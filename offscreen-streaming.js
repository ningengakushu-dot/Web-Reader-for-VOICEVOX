// Offscreen 専用: VOICEVOX ENGINE 0.26.0 の固定44-byte PCM16 WAVストリーム。
// 通常合成は offscreen-audio.js に残し、使えない環境では一切この再生経路に入らない。
(() => {
    const CAPABILITY_TIMEOUT_MS = 1800;
    const CAPABILITY_TTL_MS = 60000;
    const FAILURE_TTL_MS = 30000;
    const RESPONSE_IDLE_MS = 20000;
    // 20秒の無通信は一時停止の可能性がある。さらに40秒だけ同じreadを待ち、
    // 合計60秒で打ち切る（際限なく待機しない）。
    const RESPONSE_STALL_GRACE_MS = 40000;
    const RESPONSE_TOTAL_MS = 10 * 60 * 1000;
    // 予約したAudioBufferSourceNodeの取消し完了を確認してからだけ通常合成へ戻す。
    // 音声出力時刻より前でも一律「開始済み」とみなす保守的ガードは、
    // 先頭の音を丸ごと欠落させるため使用しない。
    const BUFFER_SECONDS_LIMIT = 5;
    // 受信・合成の揺らぎを吸収するため、0.6秒から余裕を持たせる。
    const STARTUP_BUFFER_SECONDS = 1.2;
    const FRAME_BUFFER = 4096;
    const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
    const cache = new Map();
    // 停止直後に次の再生が来ても、前のAudioContext.close()完了を先に待つ。
    let pendingContextClose = Promise.resolve();

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
            // 旧ENGINEでは /engine_manifest 自体が未対応の場合もある。
            // まず1つだけ問い合わせ、非対応なら /speakers・/version を追加取得しない。
            const manifest = await get("/engine_manifest");
            if (manifest?.supported_features?.streaming_synthesis === true) {
                const [speakers, version] = await Promise.all([
                    get("/speakers"), get("/version")
                ]);
                const styles = Array.isArray(speakers) ? speakers.flatMap((s) =>
                    Array.isArray(s?.styles) ? s.styles.slice(0, 1000) : []) : [];
                const style = styles.find((s) => Number(s?.id) === Number(speakerId));
                supported = style?.type === "streaming_talk";
                fingerprint = String(manifest?.uuid || "").slice(0, 100)
                    + ":" + String(version || "").slice(0, 100);
            }
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
        // idle: 未予約 / scheduled: 予約済みだが開始前 /
        // started: 音声開始時刻に到達 / cancelled: 予約取消し・Context解放を確認。
        let playbackState = "idle";
        let firstScheduledAt = null;
        let stopPromise = null;
        const sources = new Set();
        let startTimer = null;
        const abortError = () => new Error("ストリーミング再生が中断されました");
        const ensureActive = () => { if (stopped || controller.signal.aborted) throw abortError(); };
        const stop = () => {
            if (stopPromise) return stopPromise;
            // JSタイマーではなく音声クロックを確認する。ただし取消し成功前に
            // fallback可能とはせず、停止処理が完了して初めてcancelledに遷移する。
            const beforeStart = playbackState === "scheduled" && context !== null
                && context.currentTime < firstScheduledAt;
            stopped = true;
            controller.abort();
            if (startTimer != null) clearTimeout(startTimer);
            startTimer = null;
            let cancelledSources = true;
            for (const source of sources) {
                source.onended = null;
                try {
                    source.stop(0);
                } catch (error) {
                    cancelledSources = false;
                }
                try { source.disconnect(); } catch (error) {}
            }
            sources.clear();
            stopPromise = (async () => {
                let contextClosed = true;
                try {
                    if (context) await context.close();
                } catch (error) {
                    contextClosed = false;
                    console.error("Offscreen: AudioContext.close()失敗:", error);
                }
                try {
                    if (reader) await reader.cancel();
                } catch (error) {}
                if (playbackState === "scheduled") {
                    playbackState = beforeStart && cancelledSources && contextClosed
                        ? "cancelled" : "started";
                }
            })();
            pendingContextClose = Promise.allSettled([pendingContextClose, stopPromise])
                .then(() => {});
            return stopPromise;
        };
        async function run() {
            // 前回停止処理と同じOffscreen環境でのAudioContext作成を直列化する。
            await pendingContextClose;
            ensureActive();
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

            async function timed(promise, timeoutMs, abortOnTimeout = true) {
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
                                const error = new Error("VOICEVOXストリームの受信タイムアウト");
                                error.streamIdleTimeout = true;
                                reject(error);
                                if (abortOnTimeout) controller.abort();
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

            async function waitForPlaybackRoom() {
                await timed(new Promise((resolve, reject) => {
                    let timer;
                    const onAbort = () => {
                        clearTimeout(timer);
                        controller.signal.removeEventListener("abort", onAbort);
                        reject(abortError());
                    };
                    timer = setTimeout(() => {
                        controller.signal.removeEventListener("abort", onAbort);
                        resolve();
                    }, 70);
                    controller.signal.addEventListener("abort", onAbort, { once: true });
                    if (controller.signal.aborted) onAbort();
                }), RESPONSE_IDLE_MS);
            }

            async function readStreamChunk() {
                const remainingTime = deadline - Date.now();
                if (remainingTime <= 0) throw new Error("ストリーミング受信の時間上限を超えました");
                // 同じ reader.read() を待ち直す。再度 read() を呼ぶと受信順序が変わる。
                const readPromise = reader.read();
                try {
                    return await timed(readPromise, Math.min(RESPONSE_IDLE_MS, remainingTime), false);
                } catch (error) {
                    if (!error.streamIdleTimeout) throw error;
                    ensureActive();
                    const graceMs = Math.min(RESPONSE_STALL_GRACE_MS, deadline - Date.now());
                    if (graceMs <= 0) {
                        throw new Error("ストリーミング受信の時間上限を超えました");
                    }
                    return timed(readPromise, graceMs);
                }
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
                    while (playbackState !== "idle"
                        && nextAudioTime - context.currentTime > BUFFER_SECONDS_LIMIT - 0.3) {
                        await waitForPlaybackRoom();
                        ensureActive();
                    }
                    // 受信が再生速度に追いつかなくても、残りのサンプルを捨てない。
                    // 不足分の無音は不可避だが、読み上げ全体を中断するより安全。
                    const at = playbackState !== "idle"
                        ? Math.max(nextAudioTime, context.currentTime + 0.02)
                        : context.currentTime + 0.05;
                    if (playbackState !== "idle" && at > nextAudioTime) {
                        // 次回の読み上げは通常合成を優先し、再度の音切れを抑制。
                        suppress(speaker);
                    }
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
                    try {
                        source.start(at);
                    } catch (error) {
                        sources.delete(source);
                        source.onended = null;
                        source.disconnect();
                        pendingSources--;
                        throw error;
                    }
                    nextAudioTime = at + buffer.duration;
                    if (playbackState === "idle") {
                        playbackState = "scheduled";
                        firstScheduledAt = at;
                        const reportActualStart = () => {
                            startTimer = null;
                            if (stopped || context.state !== "running"
                                || playbackState !== "scheduled") return;
                            const remainingMs = (firstScheduledAt - context.currentTime) * 1000;
                            if (remainingMs > 0) {
                                startTimer = setTimeout(reportActualStart, Math.max(1, remainingMs));
                                return;
                            }
                            playbackState = "started";
                            onStart();
                        };
                        startTimer = setTimeout(reportActualStart,
                            Math.max(1, (at - context.currentTime) * 1000));
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
                if (playbackState !== "idle" || waitingSeconds >= STARTUP_BUFFER_SECONDS)
                    await scheduleBuffers();
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
                    const { done, value } = await readStreamChunk();
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
                            context = new AudioContext({ sampleRate: meta.sampleRate });
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
            } finally {
                clearTimeout(headerTimer);
                await stop();
                try { reader?.releaseLock?.(); } catch (error) {}
            }
        }
        return {
            run, stop,
            get started() {
                return playbackState === "started" || (playbackState === "scheduled"
                    && context !== null && context.currentTime >= firstScheduledAt);
            },
            get canFallback() {
                return playbackState === "idle" || playbackState === "cancelled";
            }
        };
    }

    globalThis.VVRadioStreaming = Object.freeze({ supports, invalidate, suppress, createPlayer, pcmHeader });
})();
