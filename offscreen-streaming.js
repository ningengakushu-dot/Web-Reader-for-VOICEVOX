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
    const CANCEL_WAIT_MS = 1200;
    const CONTEXT_CLOSE_WAIT_MS = 3000;
    // 通信中の無音・欠落を出力しないため、検証済みの全文がこの量に収まるときだけ
    // ストリーミング再生する。超過・通信失敗は、出力前に通常合成へ戻す。
    const BUFFER_SECONDS_LIMIT = 5;
    const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
    const cache = new Map();
    // 停止直後に次の再生が来ても、前のAudioContext.close()完了を先に待つ。
    let pendingContextClose = Promise.resolve();
    let activeCleanupCount = 0;
    let cleanupFailure = null;

    function cleanupStatus() {
        return cleanupFailure ? "failed" : activeCleanupCount > 0 ? "pending" : "ready";
    }

    async function waitForCleanup() {
        await pendingContextClose;
        if (cleanupFailure) throw cleanupFailure;
    }

    // 終了処理の片方が停止しても、もう片方の終了処理を妨げない。
    function boundedCleanup(promise, milliseconds, label) {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(label + " の終了がタイムアウトしました")),
                    milliseconds);
            })
        ]).finally(() => clearTimeout(timer));
    }

    // Promise.reject(undefined/null)やmessage getterの例外が、失敗状態の記録を妨げない。
    function describeRejection(reason) {
        try {
            if (reason == null) return String(reason);
            const message = reason.message;
            return typeof message === "string" && message ? message : String(reason);
        } catch (error) {
            return "詳細を取得できない終了エラー";
        }
    }

    function monotonicNow() {
        return globalThis.performance?.now?.() ?? Date.now();
    }

    // Fetchのabort後、ReadableStreamはerrored状態になるため、
    // cancel()が既に報告された読取エラーやAbortErrorで拒否されても正常な場合がある。
    function isExpectedCancelRejection(reason, previousReadError) {
        try {
            return (reason != null && reason.name === "AbortError")
                || (previousReadError.failed && Object.is(reason, previousReadError.reason));
        } catch (error) {
            return false;
        }
    }

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
    async function supports(speakerId, forceNormal = false, options = {}) {
        if (forceNormal || typeof globalThis.AudioContext !== "function") return false;
        const signal = options?.signal;
        if (signal?.aborted) throw new Error("ストリーミング準備が中断されました");
        const key = VOICEVOX_BASE_URL + ":" + speakerId;
        const saved = cache.get(key);
        if (saved && saved.until > Date.now()) return saved.supported;
        const controller = new AbortController();
        const abortFromRequest = () => controller.abort();
        signal?.addEventListener?.("abort", abortFromRequest, { once: true });
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
            if (signal?.aborted) throw error;
            supported = false;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener?.("abort", abortFromRequest);
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
            || dataBytes === 0 || dataBytes > MAX_AUDIO_BYTES - 44 || dataBytes % block !== 0
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
        let cleanupSucceeded = false;
        let exceedsBufferLimit = false;
        let firstOutputAnalyser = null;
        const previousReadError = { failed: false, reason: undefined };
        let source = null;
        let startTimer = null;
        const abortError = () => new Error("ストリーミング再生が中断されました");
        const ensureActive = () => { if (stopped || controller.signal.aborted) throw abortError(); };
        const stop = () => {
            if (stopPromise) return stopPromise;
            stopped = true;
            if (startTimer != null) clearTimeout(startTimer);
            startTimer = null;
            let cancelledSources = true;
            // abort()は同期処理中に長く停止することがある。出力ノードを先に止め、
            // その後にレンダリング側のPCMと音声クロックで先頭が出ていないことを調べる。
            if (source) {
                source.onended = null;
                try {
                    source.stop(0);
                } catch (error) {
                    cancelledSources = false;
                }
            }
            const stopRequestedBeforeStart = playbackState === "scheduled" && context !== null
                && context.currentTime < firstScheduledAt;
            let renderedOutput = playbackState === "started";
            if (firstOutputAnalyser) {
                try {
                    const samples = new Float32Array(firstOutputAnalyser.fftSize);
                    firstOutputAnalyser.getFloatTimeDomainData(samples);
                    renderedOutput ||= samples.some(sample => sample !== 0);
                } catch (error) {
                    // 出力を確認できない場合は再合成を許可しない。
                    renderedOutput = true;
                }
            }
            const beforeStart = stopRequestedBeforeStart && !renderedOutput;
            if (source) {
                try { source.disconnect(); } catch (error) {}
                source = null;
            }
            // source.stop()とPCM確認の後で通信をabortする。abort側の遅延中に
            // 予約音源が先頭から鳴り始める競合を避ける。
            let abortFailed = false;
            let abortFailure;
            try { controller.abort(); } catch (error) { abortFailed = true; abortFailure = error; }
            // AudioContext解放とネットワーク取消しは並列に実行し、それぞれ期限を設ける。
            // reader.cancel()が永遠に返らなくてもclose()を実行し、STOP_AUDIOに有限時間で応答する。
            const closeRequest = context
                ? Promise.resolve().then(() => context.close()) : Promise.resolve();
            const cancelRequest = reader
                ? Promise.resolve().then(() => reader.cancel()) : Promise.resolve();
            stopPromise = (async () => {
                const [closeResult, cancelResult] = await Promise.allSettled([
                    boundedCleanup(closeRequest, CONTEXT_CLOSE_WAIT_MS, "AudioContext"),
                    boundedCleanup(cancelRequest, CANCEL_WAIT_MS, "ストリーム")
                ]);
                let readerReleaseFailed = false;
                try {
                    if (reader && typeof reader.releaseLock !== "function") {
                        throw new Error("Reader.releaseLock() がありません");
                    }
                    reader?.releaseLock();
                    reader = null;
                } catch (error) {
                    readerReleaseFailed = true;
                }
                const unexpectedCancelFailure = cancelResult.status === "rejected"
                    && !isExpectedCancelRejection(cancelResult.reason, previousReadError);
                const unsafe = !cancelledSources || closeResult.status === "rejected"
                    || unexpectedCancelFailure || readerReleaseFailed || abortFailed;
                if (unsafe) {
                    // エラー内容の整形・ログ出力より先に必ず安全ロックを確定する。
                    cleanupFailure ||= new Error(
                        "音声再生の安全な終了を確認できません。拡張機能を再読み込みしてください。");
                    if (playbackState === "scheduled") playbackState = "started";
                    const issues = [];
                    if (!cancelledSources) issues.push("予約音源の停止に失敗しました");
                    if (closeResult.status === "rejected") {
                        issues.push("AudioContext: " + describeRejection(closeResult.reason));
                    }
                    if (unexpectedCancelFailure) {
                        issues.push("Reader: " + describeRejection(cancelResult.reason));
                    }
                    if (readerReleaseFailed) issues.push("Readerロックの解放に失敗しました");
                    if (abortFailed) {
                        issues.push("通信中断: " + describeRejection(abortFailure));
                    }
                    try {
                        console.error("Offscreen: ストリーミング終了失敗:", issues.join(" / "));
                    } catch (error) {}
                    // close()失敗や取消し未解決は再開しない。予期されたabort拒否はここに入らない。
                    throw cleanupFailure;
                }
                cleanupSucceeded = true;
                if (playbackState === "scheduled") {
                    playbackState = beforeStart ? "cancelled" : "started";
                }
            })();
            activeCleanupCount++;
            const tracked = stopPromise.finally(() => { activeCleanupCount--; });
            // 終了失敗を後続のwaitForCleanupで検知する一方、未待機時のunhandledを防ぐ。
            void tracked.catch(() => {});
            pendingContextClose = Promise.allSettled([pendingContextClose, tracked])
                .then(() => {});
            return stopPromise;
        };
        async function run() {
            const deadline = monotonicNow() + RESPONSE_TOTAL_MS;
            const remainingResponseMs = () => deadline - monotonicNow();
            // 前回停止処理と同じOffscreen環境でのAudioContext作成を直列化する。
            await waitForCleanup();
            ensureActive();
            const header = new Uint8Array(44);
            let headerUsed = 0;
            let received = 0;
            let payloadReceived = 0;
            let meta = null;
            let pcmLeft = new Uint8Array(4);
            let pcmLeftCount = 0;
            let buffer = null;
            let channelData = null;
            let frameIndex = 0;
            let finishResolve;
            const finished = new Promise((resolve) => { finishResolve = resolve; });
            async function timed(promise, timeoutMs, abortOnTimeout = true) {
                let timer;
                let abortListener;
                try {
                    const remaining = remainingResponseMs();
                    if (remaining <= 0) throw new Error("ストリーミング全体の時間上限を超えました");
                    const effectiveTimeout = Math.min(timeoutMs, remaining);
                    const overallDeadlineFirst = remaining <= timeoutMs;
                    return await Promise.race([
                        promise,
                        new Promise((_, reject) => {
                            abortListener = () => reject(abortError());
                            controller.signal.addEventListener("abort", abortListener, { once: true });
                            if (controller.signal.aborted) abortListener();
                            timer = setTimeout(() => {
                                const error = new Error(overallDeadlineFirst
                                    ? "ストリーミング全体の時間上限を超えました"
                                    : "VOICEVOXストリームの受信タイムアウト");
                                if (!overallDeadlineFirst) error.streamIdleTimeout = true;
                                reject(error);
                                if (abortOnTimeout) controller.abort();
                            }, effectiveTimeout);
                        })
                    ]);
                } finally {
                    clearTimeout(timer);
                    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
                }
            }

            async function readStreamChunk() {
                const remainingTime = remainingResponseMs();
                if (remainingTime <= 0) throw new Error("ストリーミング受信の時間上限を超えました");
                // 同じ reader.read() を待ち直す。再度 read() を呼ぶと受信順序が変わる。
                let readPromise;
                try {
                    readPromise = Promise.resolve(reader.read()).catch(error => {
                        previousReadError.failed = true;
                        previousReadError.reason = error;
                        throw error;
                    });
                } catch (error) {
                    previousReadError.failed = true;
                    previousReadError.reason = error;
                    throw error;
                }
                try {
                    return await timed(readPromise, Math.min(RESPONSE_IDLE_MS, remainingTime), false);
                } catch (error) {
                    if (!error?.streamIdleTimeout) throw error;
                    ensureActive();
                    const graceMs = Math.min(RESPONSE_STALL_GRACE_MS, remainingResponseMs());
                    if (graceMs <= 0) {
                        throw new Error("ストリーミング受信の時間上限を超えました");
                    }
                    return timed(readPromise, graceMs);
                }
            }

            async function scheduleBuffer() {
                ensureActive();
                if (context.state !== "running") {
                    await timed(context.resume(), 3000);
                    ensureActive();
                    if (context.state !== "running") {
                        throw new Error("Chromeの音声再生機構を開始できません");
                    }
                }

                // 音声クロックが予約処理中に進んでも、PCMの途中に継ぎ目を作らない。
                source = context.createBufferSource();
                source.buffer = buffer;
                if (typeof context.createAnalyser === "function") {
                    firstOutputAnalyser = context.createAnalyser();
                    firstOutputAnalyser.fftSize = 16384;
                    source.connect(firstOutputAnalyser);
                    firstOutputAnalyser.connect(context.destination);
                } else {
                    source.connect(context.destination);
                }

                const reportActualStart = () => {
                    startTimer = null;
                    if (stopped || context.state !== "running" || playbackState !== "scheduled") return;
                    const remainingMs = (firstScheduledAt - context.currentTime) * 1000;
                    if (remainingMs > 0) {
                        startTimer = setTimeout(reportActualStart, Math.max(1, remainingMs));
                        return;
                    }
                    playbackState = "started";
                    onStart();
                };
                source.onended = () => {
                    source.disconnect();
                    source = null;
                    if (playbackState === "scheduled") {
                        clearTimeout(startTimer);
                        startTimer = null;
                        playbackState = "started";
                        onStart();
                    }
                    finishResolve();
                };

                firstScheduledAt = context.currentTime + 0.05;
                try {
                    source.start(firstScheduledAt);
                } catch (error) {
                    source.onended = null;
                    source.disconnect();
                    source = null;
                    throw error;
                }
                playbackState = "scheduled";
                startTimer = setTimeout(reportActualStart,
                    Math.max(1, (firstScheduledAt - context.currentTime) * 1000));
            }

            function acceptPcm(bytes) {
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let position = 0;
                function frame(frameView, at) {
                    for (let channel = 0; channel < meta.channels; channel++) {
                        channelData[channel][frameIndex] =
                            frameView.getInt16(at + channel * 2, true) / 32768;
                    }
                    frameIndex++;
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
                    }
                }
                while (position + meta.block <= bytes.length) {
                    frame(view, position);
                    position += meta.block;
                }
                if (position < bytes.length) {
                    pcmLeft.set(bytes.subarray(position), 0);
                    pcmLeftCount = bytes.length - position;
                }
            }

            // 全量を検証してから再生するため、上限内の音声は1回の生成にまとめる。
            try {
                const response = await timed(fetch(VOICEVOX_BASE_URL +
                    "/streaming_synthesis?speaker=" + encodeURIComponent(speaker)
                    + `&segment_length=${BUFFER_SECONDS_LIMIT}&start_offset=0`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(query),
                    signal: controller.signal
                }), 60000);
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
                            if (meta.dataBytes > BUFFER_SECONDS_LIMIT * meta.sampleRate * meta.block) {
                                exceedsBufferLimit = true;
                                throw new Error("音声バッファの上限を超えたため通常合成へ切り替えます");
                            }
                            context = new AudioContext({ sampleRate: meta.sampleRate });
                            buffer = context.createBuffer(
                                meta.channels, meta.dataBytes / meta.block, meta.sampleRate);
                            channelData = Array.from({ length: meta.channels },
                                (_, channel) => buffer.getChannelData(channel));
                        }
                    }
                    if (meta && offset < value.length) {
                        const part = value.subarray(offset);
                        payloadReceived += part.byteLength;
                        if (payloadReceived > meta.dataBytes) throw new Error("WAVデータの過剰受信");
                        acceptPcm(part);
                    }
                }
                if (!meta || received !== meta.fileBytes || payloadReceived !== meta.dataBytes
                    || (length != null && received !== length) || pcmLeftCount !== 0) {
                    throw new Error("VOICEVOXストリームの音声末尾が欠損しています");
                }
                await scheduleBuffer();
                await timed(finished, RESPONSE_TOTAL_MS);
                ensureActive();
            } finally {
                await stop();
            }
        }
        return {
            run, stop,
            get started() {
                return playbackState === "started" || (playbackState === "scheduled"
                    && context !== null && context.currentTime >= firstScheduledAt);
            },
            get exceedsBufferLimit() { return exceedsBufferLimit; },
            get canFallback() {
                return cleanupSucceeded && cleanupFailure === null
                    && (playbackState === "idle" || playbackState === "cancelled");
            }
        };
    }

    function lockCleanup(reason) {
        cleanupFailure ||= new Error("通信の安全な終了を確認できません。拡張機能を再読み込みしてください: "
            + describeRejection(reason));
        return cleanupFailure;
    }

    globalThis.VVRadioStreaming = Object.freeze({
        supports, invalidate, suppress, createPlayer, pcmHeader, lockCleanup,
        cleanupStatus, waitForCleanup, bufferSecondsLimit: BUFFER_SECONDS_LIMIT
    });
})();
