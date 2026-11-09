// Offscreen 専用: VOICEVOX ENGINE 0.26.0 の固定44-byte PCM16 WAVストリーム。
// 通常合成は offscreen-audio.js に残し、使えない環境では一切この再生経路に入らない。
(() => {
    const CAPABILITY_TIMEOUT_MS = 1800;
    const CAPABILITY_TTL_MS = 60000;
    const FAILURE_TTL_MS = 30000;
    const RESPONSE_IDLE_MS = 20000;
    const RESPONSE_TOTAL_MS = 10 * 60 * 1000;
    const BUFFER_SECONDS_LIMIT = 5;
    const STARTUP_BUFFER_SECONDS = 0.6;
    const FRAME_BUFFER = 4096;
    const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
    const cache = new Map();

    function invalidate(speakerId) {
        if (speakerId == null) cache.clear();
        else cache.delete(VOICEVOX_BASE_URL + ":" + speakerId);
    }

    function suppress(speakerId) {
        cache.set(VOICEVOX_BASE_URL + ":" + speakerId,
            { supported: false, until: Date.now() + FAILURE_TTL_MS, reason: "stream-error" });
    }

    // 0.26.0 の /engine_manifest API は supported_features の各値を bool に平坦化する。
    // engine_manifest.json 自体の {value:true} と混同しない。
    async function supports(speakerId, forceNormal = false) {
        if (forceNormal || typeof globalThis.AudioContext !== "function") return false;
        const key = VOICEVOX_BASE_URL + ":" + speakerId;
        const saved = cache.get(key);
        if (saved && saved.until > Date.now()) return saved.supported;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CAPABILITY_TIMEOUT_MS);
        let supported = false;
        let fingerprint = null;
        try {
            const get = (path) => fetch(VOICEVOX_BASE_URL + path, { signal: controller.signal })
                .then(async (res) => {
                    if (!res.ok) throw new Error("ENGINE capability status " + res.status);
                    return readJsonResponseWithLimit(res, 1024 * 1024, CAPABILITY_TIMEOUT_MS);
                });
            const [manifest, speakers, version] = await Promise.all([
                get("/engine_manifest"), get("/speakers"), get("/version")
            ]);
            const styles = Array.isArray(speakers) ? speakers.flatMap((s) =>
                Array.isArray(s?.styles) ? s.styles.slice(0, 1000) : []) : [];
            const style = styles.find((s) => Number(s?.id) === Number(speakerId));
            supported = manifest?.supported_features?.streaming_synthesis === true
                && style?.type === "streaming_talk";
            fingerprint = String(manifest?.uuid || "").slice(0, 100)
                + ":" + String(version || "").slice(0, 100);
        } catch (error) {
            supported = false;
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
        cache.set(key, { supported, fingerprint, until: Date.now()
            + (supported ? CAPABILITY_TTL_MS : FAILURE_TTL_MS) });
        return supported;
    }

    function pcmHeader(bytes, query, contentLength) {
        if (bytes.byteLength !== 44) throw new Error("WAV header length");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ascii = (at, size) => String.fromCharCode(...bytes.subarray(at, at + size));
        const channels = view.getUint16(22, true);
        const sampleRate = view.getUint32(24, true);
        const block = view.getUint16(32, true);
        const dataBytes = view.getUint32(40, true);
        const fileBytes = 44 + dataBytes;
        if (ascii(0, 4) !== "RIFF" || ascii(8, 8) !== "WAVEfmt "
            || ascii(36, 4) !== "data" || view.getUint32(16, true) !== 16
            || view.getUint16(20, true) !== 1 || view.getUint16(34, true) !== 16
            || (channels !== 1 && channels !== 2) || sampleRate < 8000 || sampleRate > 192000
            || block !== channels * 2 || view.getUint32(28, true) !== sampleRate * block
            || view.getUint32(4, true) !== fileBytes - 8
            || dataBytes > MAX_AUDIO_BYTES - 44 || dataBytes % block !== 0
            || sampleRate !== Number(query.outputSamplingRate)
            || channels !== (query.outputStereo ? 2 : 1)
            || (contentLength != null && contentLength !== fileBytes)) {
            throw new Error("VOICEVOXストリームのWAV形式が不正です");
        }
        return { channels, sampleRate, dataBytes, block, fileBytes };
    }

    function createPlayer(query, speaker, onStart) {
        const controller = new AbortController();
        let context = null;
        let reader = null;
        let stopped = false;
        let started = false;
        const sources = new Set();
        let startTimer = null;
        const abortError = () => new Error("ストリーミング再生が中断されました");
        const ensureActive = () => { if (stopped || controller.signal.aborted) throw abortError(); };
        const stop = () => {
            if (stopped) return;
            stopped = true;
            controller.abort();
            if (startTimer != null) clearTimeout(startTimer);
            if (reader) void reader.cancel().catch(() => {});
            for (const source of sources) {
                source.onended = null;
                try { source.stop(); } catch (error) {}
                source.disconnect();
            }
            sources.clear();
            if (context) void context.close().catch(() => {});
        };
        async function run() {
            const header = new Uint8Array(44);
            let headerUsed = 0;
            let received = 0;
            let payloadReceived = 0;
            let meta = null;
             let pcmLeft = new Uint8Array(4);
            let pcmLeftCount = 0;
            let floats = null;
            let framesInBlock = 0;
            let waitingBuffers = [];
            let waitingSeconds = 0;
            let nextAudioTime = 0;
            let pendingSources = 0;
            let streamEnded = false;
            let finishResolve;
            const finished = new Promise((resolve) => { finishResolve = resolve; });
            const deadline = Date.now() + RESPONSE_TOTAL_MS;

            async function timed(promise, timeoutMs) {
                let timer;
                let abortListener;
                try {
                    return await Promise.race([
                        promise,
                        new Promise((_, reject) => {
                            abortListener = () => reject(abortError());
                            controller.signal.addEventListener("abort", abortListener, { once: true });
                            if (controller.signal.aborted) abortListener();
                            timer = setTimeout(() => {
                                reject(new Error("VOICEVOXストリームの受信タイムアウト"));
                                controller.abort();
                            }, timeoutMs);
                        })
                    ]);
                } finally {
                    clearTimeout(timer);
                    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
                }
            }

            function finishIfComplete() {
                if (streamEnded && pendingSources === 0) finishResolve();
            }

            async function scheduleBuffers() {
                ensureActive();
                if (context.state !== "running") {
                    await timed(context.resume(), 3000);
                    if (context.state !== "running") {
                        throw new Error("Chromeの音声再生機構を開始できません");
                    }
                }
                for (const buffer of waitingBuffers) {
                    ensureActive();
                    while (started && nextAudioTime - context.currentTime > BUFFER_SECONDS_LIMIT - 0.3) {
                        await timed(new Promise((resolve) => {
                            const timer = setTimeout(resolve, 70);
                            controller.signal.addEventListener("abort", () => {
                                clearTimeout(timer);
                                resolve();
                            }, { once: true });
                        }), RESPONSE_IDLE_MS);
                        ensureActive();
                    }
                    if (started && nextAudioTime < context.currentTime + 0.01) {
                        throw new Error("VOICEVOXストリームの再生バッファが不足しました");
                    }
                    const at = started ? nextAudioTime : context.currentTime + 0.05;
                    const source = context.createBufferSource();
                    source.buffer = buffer;
                    source.connect(context.destination);
                    source.onended = () => {
                        sources.delete(source);
                        source.disconnect();
                        pendingSources--;
                        finishIfComplete();
                    };
                    sources.add(source);
                    pendingSources++;
                    source.start(at);
                    nextAudioTime = at + buffer.duration;
                    if (!started) {
                        started = true;  // 出力予約以降は通常合成を先頭から再試行しない
                        startTimer = setTimeout(() => {
                            startTimer = null;
                            if (!stopped && context.state === "running") onStart();
                        }, Math.max(0, (at - context.currentTime) * 1000));
                    }
                }
                waitingBuffers = [];
                waitingSeconds = 0;
            }

            async function flushFrames() {
                if (framesInBlock === 0) return;
                const buffer = context.createBuffer(meta.channels, framesInBlock, meta.sampleRate);
                for (let channel = 0; channel < meta.channels; channel++) {
                    buffer.getChannelData(channel).set(floats[channel].subarray(0, framesInBlock));
                }
                waitingBuffers.push(buffer);
                waitingSeconds += buffer.duration;
                framesInBlock = 0;
                if (started || waitingSeconds >= STARTUP_BUFFER_SECONDS) await scheduleBuffers();
            }

            async function acceptPcm(bytes) {
                if (!floats) floats = Array.from({ length: meta.channels },
                    () => new Float32Array(FRAME_BUFFER));
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let position = 0;
                function frame(frameView, at) {
                    for (let channel = 0; channel < meta.channels; channel++) {
                        floats[channel][framesInBlock] =
                            frameView.getInt16(at + channel * 2, true) / 32768;
                    }
                    framesInBlock++;
                }
                if (pcmLeftCount) {
                    const needed = meta.block - pcmLeftCount;
                    const take = Math.min(needed, bytes.length);
                    pcmLeft.set(bytes.subarray(0, take), pcmLeftCount);
                    pcmLeftCount += take;
                    position = take;
                    if (pcmLeftCount === meta.block) {
                        frame(new DataView(pcmLeft.buffer), 0);
                        pcmLeftCount = 0;
                        if (framesInBlock === FRAME_BUFFER) await flushFrames();
                    }
                }
                while (position + meta.block <= bytes.length) {
                    frame(view, position);
                    position += meta.block;
                    if (framesInBlock === FRAME_BUFFER) await flushFrames();
                }
                if (position < bytes.length) {
                    pcmLeft.set(bytes.subarray(position), 0);
                    pcmLeftCount = bytes.length - position;
                }
            }

            const headerTimer = setTimeout(() => controller.abort(), 60000);
            try {
                const response = await fetch(VOICEVOX_BASE_URL +
                    "/streaming_synthesis?speaker=" + encodeURIComponent(speaker)
                    + "&segment_length=0.3&start_offset=0", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(query),
                    signal: controller.signal
                });
                clearTimeout(headerTimer);
                ensureActive();
                if (!response.ok) {
                    const error = new Error("ストリーミング合成エラー (" + response.status + ")");
                    error.httpStatus = response.status;
                    throw error;
                }
                if (!response.body?.getReader) throw new Error("ストリーミング受信が利用できません");
                const lengthString = response.headers?.get?.("content-length");
                const length = lengthString == null ? null : Number(lengthString);
                if (length != null && (!Number.isSafeInteger(length) || length < 44
                    || length > MAX_AUDIO_BYTES)) throw new Error("ストリームのサイズが不正です");
                reader = response.body.getReader();
                while (true) {
                    ensureActive();
                    const remainingTime = deadline - Date.now();
                    if (remainingTime <= 0) throw new Error("ストリーミング受信の時間上限を超えました");
                    const { done, value } = await timed(reader.read(),
                        Math.min(RESPONSE_IDLE_MS, remainingTime));
                    ensureActive();
                    if (done) break;
                    if (!(value instanceof Uint8Array) || value.byteLength > 2 * 1024 * 1024) {
                        throw new Error("ストリーム受信チャンクが不正です");
                    }
                    received += value.length;
                    if (received > MAX_AUDIO_BYTES || (length != null && received > length)) {
                        throw new Error("VOICEVOX音声応答が大きすぎます");
                    }
                    let offset = 0;
                    if (headerUsed < 44) {
                        const count = Math.min(44 - headerUsed, value.length);
                        header.set(value.subarray(0, count), headerUsed);
                        headerUsed += count;
                        offset += count;
                        if (headerUsed === 44) {
                            meta = pcmHeader(header, query, length);
                            context = new AudioContext();
                        }
                    }
                    if (meta && offset < value.length) {
                        const part = value.subarray(offset);
                        payloadReceived += part.byteLength;
                        if (payloadReceived > meta.dataBytes) throw new Error("WAVデータの過剰受信");
                        await acceptPcm(part);
                    }
                }
                if (!meta || received !== meta.fileBytes || payloadReceived !== meta.dataBytes
                    || (length != null && received !== length) || pcmLeftCount !== 0) {
                    throw new Error("VOICEVOXストリームの音声末尾が欠損しています");
                }
                await flushFrames();
                if (waitingBuffers.length) await scheduleBuffers();
                streamEnded = true;
                finishIfComplete();
                await timed(finished, RESPONSE_TOTAL_MS);
                ensureActive();
            } catch (error) {
                stop();
                throw error;
            } finally {
                clearTimeout(headerTimer);
                reader?.releaseLock?.();
                if (!stopped) {
                    stopped = true;
                    if (startTimer != null) clearTimeout(startTimer);
                    if (context) await context.close().catch(() => {});
                }
            }
        }
        return { run, stop, get started() { return started; } };
    }

    globalThis.VVRadioStreaming = Object.freeze({ supports, invalidate, suppress, createPlayer, pcmHeader });
})();
