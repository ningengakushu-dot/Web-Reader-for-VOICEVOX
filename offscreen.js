// Offscreen Document: 実際の音声再生と合成、およびページ内範囲選択OCRの文字認識を担当

let textQueue = [];
let audioQueue = [];
let isSynthesizing = false;
let isPlaying = false;
let currentAudio = null;
let currentAudioUrl = null;
let currentStreamingPlayer = null;
// 再生中の音声とは別に、完成済み音声をどれだけ先読みするか（件数と合計秒数の両方で制限）。
// 全文を再生より速く合成すると、長文では Blob と VOICEVOX の処理負荷が読み上げ終了まで
// 増え続ける。一方で「次の1件だけ」では、短い文（見出し・箇条書きの1行）の直後に長い文が
// 来ると、その合成（音声長の約0.5〜0.7倍）が短い文の再生中に終わらず無音になる。
// 実測（音声1秒あたり合成0.5秒）では、再生済みの音声が数十秒分たまっていれば
// 1件の合成時間（最長で音声30〜60秒＝合成15〜40秒）を吸収できる。
// 24kHz/16bit の WAV は1分で約2.9MB なので、メモリは文章量に依存しない一定範囲に収まる。
// ごく短い音声が続いても、件数が先に頭打ちになって必要秒数を蓄えられなくしない。
// 実音声は45秒を主なメモリ上限とし、件数は異常な長さの応答に対する防御にする。
const MAX_READY_AUDIO_QUEUE = 256;
const MAX_READY_AUDIO_SECONDS = 45;
const MAX_QUERY_LOOKAHEAD_ITEMS = 1024;
let activeSynthesis = null;
let synthesisSecondsPerAudioSecond = 0.7;
let playbackBufferTimer = null;
// 合成の世代トークン。stopAll() で繰り上げることで、停止前に開始済みの
// 合成（in-flight）が完了しても、その結果を破棄して状態に反映させない。
let synthesisGeneration = 0;
// 再生の世代トークン。stopAll() 直後に古い audio.play() の reject が届いても無視する。
let playbackGeneration = 0;

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;
    // 拡張自身（background）からのメッセージに限る（多層防御）
    if (sender.id !== chrome.runtime.id) return;
    const security = globalThis.VVRadioOffscreenSecurity;
    if (security) {
        const checked = security.validate(message);
        if (!checked.ok) {
            sendResponse({ success: false, error: checked.error });
            return false;
        }
        message = checked.message;
    }

    switch (message.type) {
        case 'ENQUEUE_TEXTS':
            enqueueTexts(message.texts, message.settings);
            sendResponse({ success: true });
            break;
        case 'STOP_AUDIO':
            stopAll();
            sendResponse({ success: true });
            break;
        case 'PREWARM_OCR':
            // 範囲選択中の先読み。横書きは実測で圧倒的に多いので jpn だけ用意する
            // （縦書きが必要になった場合はそのとき生成される）。
            getOcrWorker("jpn").catch(() => {});
            // 範囲選択をやめた場合にワーカーが残り続けないよう、解放予約も入れておく
            // （実際にOCRが始まれば recognizeRegion 側で取り消される）。
            scheduleOcrWorkerIdleRelease();
            sendResponse({ success: true });
            break;
        case 'OCR_RECOGNIZE':
            // OCRは数秒かかるため応答チャネルは保持せず、完了時に
            // OCR_COMPLETE を background へ送るイベント駆動にする。
            // 共有ワーカーと進捗通知先（ocrProgressTabId）が競合しないよう直列化する。
            if (!enqueueOcrRecognition(message)) {
                sendResponse({ success: false, error: "文字認識の要求が混み合っています。少し待ってから再度お試しください。" });
            } else {
                sendResponse({ success: true });
            }
            break;
    }
    return false;
});

// --- ページ内範囲選択OCR ---

// 進行状況の通知先タブ（OCR実行中のみ設定）
let ocrProgressTabId = null;
// 表示には主経路（元寸・全文）の認識の進捗だけを使う。方向判定の並行認識や
// 精錬・局所確認は回数が入力次第で変わるうえ、横書き・縦書きworkerが並行して
// 交互に 0→1 を報告するため、全部をつなぎ合わせる方式は成り立たない
// （かつては進捗の後退から回の切り替わりを推定していたが、並行化により
// 開始直後に表示が100%近くへ張り付いていた）。どの認識が主経路かの判別と
// ゲージへの変換は ocr-common.js（createPrimaryOcrProgressTracker）に集約している。
const ocrDisplayProgress = createPrimaryOcrProgressTracker();

// OCRワーカーは組版方向（横書き jpn / 縦書き jpn_vert）ごとに初回利用時に生成し、
// 以降のOCRで使い回す。この offscreen document が破棄された場合は次回作成時に再生成される。
const ocrWorkers = createOcrWorkerPool((m, source) => {
    if (ocrProgressTabId == null) return;
    const progress = ocrDisplayProgress.update(m, source);
    if (progress != null) {
        notifyBackground("OCR_PROGRESS", {
            tabId: ocrProgressTabId,
            progress
        });
    }
});
const getOcrWorker = ocrWorkers.get;

// 範囲OCR要求を1件ずつ順に処理するチェーン。共有Tesseractワーカーの recognize は
// 並行呼び出しに耐えず、進捗通知先 ocrProgressTabId もモジュールグローバルのため、
// 複数タブからの同時要求が混線しないよう直列化する。recognizeRegion は自身で
// OCR_COMPLETE を送るため、チェーンは失敗も飲み込んで（catch）次の要求へ進める。
const MAX_PENDING_OCR_REQUESTS = 3;
let pendingOcrRequests = 0;
let ocrChain = Promise.resolve();
function enqueueOcrRecognition(message) {
    if (pendingOcrRequests >= MAX_PENDING_OCR_REQUESTS) return false;
    pendingOcrRequests++;
    const run = ocrChain.then(() => recognizeRegion(message));
    ocrChain = run.catch(() => {}).finally(() => { pendingOcrRequests--; });
    return true;
}

// ハングした可能性のあるワーカーを破棄し、次回のOCRで作り直させる（認識タイムアウト時に使用）。
const resetOcrWorkers = ocrWorkers.terminate;

/**
 * キャプチャ画像から選択範囲を切り出してOCRし、結果を background へ通知する。
 * rect はビューポートのCSSピクセル座標、キャプチャ画像は物理ピクセルのため、
 * 画像幅とビューポート幅の比率で座標変換する（devicePixelRatio・ズーム両対応）。
 */
async function recognizeRegion({ dataUrl, rect, viewportWidth, tabId, requestId }) {
    ocrProgressTabId = tabId ?? null;
    ocrDisplayProgress.reset();
    cancelOcrWorkerIdleRelease();
    // requestId は background が古い要求の結果を捨てるための通し番号。そのまま返す。
    const complete = (payload) => notifyBackground("OCR_COMPLETE",
        Number.isInteger(requestId) ? { tabId, requestId, ...payload } : { tabId, ...payload });
    try {
        const blob = await (await fetch(dataUrl)).blob();
        const bitmap = await createImageBitmap(blob);
        let canvas;
        try {
            const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : 1;
            const sx = Math.max(0, Math.min(Math.round(rect.x * scale), bitmap.width - 1));
            const sy = Math.max(0, Math.min(Math.round(rect.y * scale), bitmap.height - 1));
            const sw = Math.max(1, Math.min(Math.round(rect.width * scale), bitmap.width - sx));
            const sh = Math.max(1, Math.min(Math.round(rect.height * scale), bitmap.height - sy));
            canvas = cropToOcrCanvas(bitmap, sx, sy, sw, sh);
        } finally {
            bitmap.close();
        }

        // 組版方向（横書き/縦書き）を自動判定して認識する。
        // 認識がハングしても進捗トーストが残り続けないよう、タイムアウトで打ち切る。
        const data = await withOcrTimeout(
            recognizeWithOrientation(canvas, getOcrWorker),
            OCR_RECOGNIZE_TIMEOUT_MS,
            "文字認識に時間がかかりすぎました。範囲を狭めてお試しください。"
        );
        const text = cleanForSpeech(normalizeOcrText(data.text));

        if (!text) {
            complete({ error: "文字を認識できませんでした。範囲を変えてお試しください。" });
            return;
        }
        complete({ text });
    } catch (err) {
        console.error("Offscreen: OCR失敗:", err);
        // タイムアウトはワーカーがハングした可能性が高いため破棄して作り直させる
        if (err && err.isOcrTimeout) resetOcrWorkers();
        complete({ error: `文字認識に失敗しました: ${err.message}` });
    } finally {
        ocrProgressTabId = null;
        scheduleOcrWorkerIdleRelease();
    }
}

// OCRワーカーは言語ごとに 14MB の学習データを抱えるため、使い終わってしばらく
// 経ったら破棄する。連続して読み上げる間は保持し、放置時だけメモリを返す。
let ocrIdleTimer = null;

function cancelOcrWorkerIdleRelease() {
    if (ocrIdleTimer) {
        clearTimeout(ocrIdleTimer);
        ocrIdleTimer = null;
    }
}

function scheduleOcrWorkerIdleRelease() {
    cancelOcrWorkerIdleRelease();
    ocrIdleTimer = setTimeout(() => {
        ocrIdleTimer = null;
        resetOcrWorkers();
    }, OCR_WORKER_IDLE_RELEASE_MS);
}

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
/**
 * 分割済みのテキストをまとめて合成待ちキューに追加し、合成プロセスを開始する。
 * 1文ずつ別メッセージで受け取ると、短い文では先頭の再生が終わった時点で
 * キューが空になり、まだ後続が残っているのに読み上げ終了として通知してしまう
 * （アイコンが途中で待機状態に戻る）。必ず全文をまとめて積む。
 */
function enqueueTexts(texts, settings) {
    if (!Array.isArray(texts) || texts.length === 0) return;
    // 連続する文章のストリーミング切替は無音区間の実機検証が未完了。
    // 音切れ対策が確立している従来の先読み経路を複数文では優先する。
    const playbackSettings = texts.length > 1
        ? { ...settings, synthesisMode: "normal" } : settings;
    for (const text of texts) {
        textQueue.push({ text, settings: playbackSettings });
    }
    processSynthesis();
}

// エンジンが特定の文だけを HTTP エラーで拒否したとき、その文を捨てる前に何回まで
// 半分に割って試すか（1文が最大8片になる）。
// エンジンは1回の要求のアクセント句が49を超えると 500 を返し（実測:
// tools/reading-corpus-check.mjs）、従来はその文が音声から黙って消え、前後の文が
// つながって聞こえていた＝利用者から見た「読み飛ばし」。分割して出し直せば読める。
const MAX_SYNTHESIS_SPLIT_DEPTH = 3;
// これより短い文は、長さが原因ではないので割らずに従来どおり諦める。
const MIN_SYNTHESIS_SPLIT_CHARS = 8;
// 続けてこの回数だけ文の合成に失敗したら、残りのキューを捨てて通知を打ち切る。
// 話者IDが今のエンジンに存在しない（VOICEVOXの入れ替え・キャラ構成の変更）、同じポートを
// 別のプロセスが使っている、といった原因はどの文でも同じように失敗するため、続けても
// 利用者は無音のまま待たされ、文の数だけエラー表示が上書きされ続けるだけになる。
// 1〜2件なら「その文だけ読めなかった」可能性があるので続行する。
const MAX_CONSECUTIVE_SYNTHESIS_FAILURES = 3;
let consecutiveSynthesisFailures = 0;

/**
 * 合成に失敗した文を2つに割る。句読点・閉じ括弧の直後のうち中央にいちばん近い位置で
 * 切り、区切りが無ければ中央で切る。割れないときは null。
 * @param {string} text
 * @returns {[string, string] | null}
 */
function splitSynthesisText(text) {
    const chars = [...(text || "")];
    if (chars.length < MIN_SYNTHESIS_SPLIT_CHARS) return null;
    const middle = Math.floor(chars.length / 2);
    let cut = -1;
    for (let i = 1; i < chars.length; i++) {
        if (!/[。．！？!?、，,」』）)]/.test(chars[i - 1])) continue;
        if (cut < 0 || Math.abs(i - middle) < Math.abs(cut - middle)) cut = i;
    }
    if (cut <= 0 || cut >= chars.length) cut = middle;
    const head = chars.slice(0, cut).join("").trim();
    const tail = chars.slice(cut).join("").trim();
    if (!head || !tail) return null;
    return [head, tail];
}

/**
 * 合成待ちキューを処理し、音声を生成する
 */
function readyAudioSeconds() {
    return audioQueue.reduce((sum, item) => sum + (item.durationSec || 0), 0);
}

function audioClockMs() {
    return globalThis.performance?.now?.() ?? Date.now();
}

// 文の文字数ではなく、エンジンが返したモーラ長で先の合成負荷を予測する。
// 短文が複数続いてから長文が来る場合も見る必要があるので、次の1件だけにはしない。
// WAVとは別の上限で軽いクエリを先読みする。音声が短い場合、WAVの件数上限で
// クエリも打ち切ると、その先にある長い合成を開始前に発見できない。
async function prepareSynthesisWindow(item, generation) {
    let seconds = readyAudioSeconds();
    let count = audioQueue.length;
    // 再生より少し速いだけのエンジンほど蓄積が遅いので、より遠くまで調べる。
    // 45〜450秒相当、かつ1024件で上限を固定し、全文分を無制限には保持しない。
    const headroom = Math.max(0.1, 1 - synthesisSecondsPerAudioSecond * 1.2);
    const lookaheadSeconds = MAX_READY_AUDIO_SECONDS / headroom;
    for (let index = -1; index < textQueue.length; index++) {
        if (index >= 0 && (count >= MAX_QUERY_LOOKAHEAD_ITEMS || seconds >= lookaheadSeconds)) break;
        const pending = index < 0 ? item : textQueue[index];
        if (!pending.query && !pending.queryError) {
            try {
                const query = await prepareVoiceQuery(pending.text, pending.settings);
                if (generation !== synthesisGeneration) return false;
                pending.query = query;
                pending.durationSec = estimateQueryDurationSec(query, pending.settings.speedScale);
            } catch (error) {
                if (generation !== synthesisGeneration) return false;
                pending.queryError = error;
            }
        }
        // 失敗は元の合成キューの順番で処理し、分割再試行とエラー通知の契約を保つ。
        // 到達不能のまま後続全件に同じ要求を出さない。
        if (pending.queryError) break;
        seconds += pending.durationSec;
        count++;
    }
    return generation === synthesisGeneration;
}

function requiredPlaybackBufferSeconds() {
    // 直近の合成実測に20%の余裕を持たせる。実測値は各合成で更新するので、
    // エンジン起動時の一時的な遅さを以降ずっと引きずらない。
    const rate = synthesisSecondsPerAudioSecond * 1.2;
    let synthesisSeconds = 0;
    let precedingAudioSeconds = 0;
    let required = 0;
    const add = (durationSec, elapsed = 0) => {
        synthesisSeconds += Math.max(0, durationSec * rate - elapsed);
        required = Math.max(required, synthesisSeconds - precedingAudioSeconds);
        precedingAudioSeconds += durationSec;
    };
    if (activeSynthesis?.durationSec != null) {
        add(activeSynthesis.durationSec, Math.max(0, audioClockMs() - activeSynthesis.startedAt) / 1000);
    }
    for (const pending of textQueue) {
        if (!pending.query || pending.queryError) break;
        add(pending.durationSec);
    }
    return required > 0 ? required + 0.1 : 0;
}

function clearPlaybackBufferTimer() {
    if (playbackBufferTimer !== null) clearTimeout(playbackBufferTimer);
    playbackBufferTimer = null;
}

async function processSynthesis() {
    if (isSynthesizing || currentStreamingPlayer || audioQueue.some(item => item.streaming)
        || textQueue.length === 0
        || audioQueue.length >= MAX_READY_AUDIO_QUEUE
        || readyAudioSeconds() >= MAX_READY_AUDIO_SECONDS) return;

    isSynthesizing = true;
    const item = textQueue.shift();
    // この合成が属する世代を記録。完了時に世代が進んでいれば stale とみなす。
    const generation = synthesisGeneration;
    activeSynthesis = { durationSec: null, startedAt: null };

    try {
        // 先に対応を確認し、streaming_talk では大量のクエリ/WAV先読みを避ける。
        // 古いENGINE・不明スタイル・音声API未対応では従来の経路を変更しない。
        const streaming = !item.forceNormal && item.settings.synthesisMode === "auto"
            && globalThis.VVRadioStreaming
            && await globalThis.VVRadioStreaming.supports(item.settings.speakerId);
        if (generation !== synthesisGeneration) return;
        if (streaming) {
            const query = item.query || await prepareVoiceQuery(item.text, item.settings);
            if (generation !== synthesisGeneration) return;
            audioQueue.push({ streaming: true, query, settings: item.settings,
                text: item.text, durationSec: estimateQueryDurationSec(query, item.settings.speedScale),
                splitDepth: item.splitDepth || 0, notice: item.notice });
            activeSynthesis = null;
            processPlayback();
            return;
        }
        if (!await prepareSynthesisWindow(item, generation)) return;
        if (item.queryError) throw item.queryError;
        activeSynthesis = { durationSec: item.durationSec, startedAt: audioClockMs() };
        processPlayback();
        const { url: blobUrl, durationSec } = await generateVoiceBlob(item.text, item.settings, item.query);
        // 合成中に stopAll() が走った場合、生成済み Blob を破棄して状態を触らない
        if (generation !== synthesisGeneration) {
            URL.revokeObjectURL(blobUrl);
            return;
        }
        const elapsedSec = Math.max(0, audioClockMs() - activeSynthesis.startedAt) / 1000;
        if (durationSec > 0) synthesisSecondsPerAudioSecond = elapsedSec / durationSec;
        activeSynthesis = null;
        consecutiveSynthesisFailures = 0;
        audioQueue.push({ url: blobUrl, text: item.text, durationSec });
        processPlayback();
    } catch (err) {
        // stale な世代のエラーは通知も状態変更もしない
        if (generation !== synthesisGeneration) return;
        console.error("Offscreen: 合成失敗:", err);
        // エンジンが特定の文だけ拒否した場合（HTTP エラー）は、その文を捨てる前に
        // 半分に割って積み直す（MAX_SYNTHESIS_SPLIT_DEPTH のコメント参照）。
        // 割れるあいだは通知しない: まだ文は失われていない。
        const splitDepth = item.splitDepth || 0;
        // 割った断片が結局どれも読めなかった場合でも、通知は元の1文につき1回に保つ
        // （最大8片ぶんのエラー表示を出さない）。
        const notice = item.notice || { notified: false };
        if (isVoicevoxRetryableError(err) && splitDepth < MAX_SYNTHESIS_SPLIT_DEPTH) {
            const parts = splitSynthesisText(item.text);
            if (parts) {
                textQueue.unshift(
                    { text: parts[0], settings: item.settings, forceNormal: item.forceNormal, splitDepth: splitDepth + 1, notice },
                    { text: parts[1], settings: item.settings, forceNormal: item.forceNormal, splitDepth: splitDepth + 1, notice });
                return;
            }
        }
        if (notice.notified && !isVoicevoxUnreachableError(err)) return;
        notice.notified = true;
        consecutiveSynthesisFailures++;
        // エンジンに届かない・応答が無い失敗では残りの文を合成しない。続けても文の数だけ
        // 同じ失敗と PLAYBACK_ERROR 通知（＝タブのエラー表示・SW起動）を繰り返すだけになる。
        // 到達はできるが毎回同じ理由で拒否される場合も同じなので、連続失敗が続いたら諦める。
        // 割っても駄目だった文はここで諦め、次の文へ進む（既に合成済みの音声は再生を終える）。
        if (isVoicevoxUnreachableError(err)) globalThis.VVRadioStreaming?.invalidate?.();
        if (isVoicevoxUnreachableError(err)
            || consecutiveSynthesisFailures >= MAX_CONSECUTIVE_SYNTHESIS_FAILURES) {
            textQueue = [];
        }
        // 利用者へ見せる文言を持つエラー（HTTPステータス・応答形式）はそのまま伝える。
        // 内部由来の英語メッセージだけ「合成失敗:」を付けて区別できるようにする。
        notifyBackground("PLAYBACK_ERROR",
            { error: err?.userFacing ? err.message : `合成失敗: ${err.message}` });
    } finally {
        // 現在の世代のみが合成フラグの解除と次処理の継続を行える。
        // stale な世代では stopAll() が既に状態をリセット済みのため何もしない。
        if (generation === synthesisGeneration) {
            activeSynthesis = null;
            isSynthesizing = false;
            processSynthesis();
            processPlayback();
        }
    }
}

// 文を割って読み直す価値のある失敗か。エンジンは1要求のアクセント句が49を超えると
// 500 を返すので、5xx のときだけ割り直す意味がある。404/422（話者がこのエンジンに無い等）や
// 応答形式の異常はどう割っても同じ結果で、1文あたり最大15回の無駄な要求になるだけ。
function isVoicevoxRetryableError(err) {
    const status = Number(err?.httpStatus);
    return Number.isFinite(status) && status >= 500 && status < 600;
}

// エンジンに接続できない／応答が無い種類の失敗か（fetch の TypeError・タイムアウト）。
// HTTP ステータス由来の失敗（Query失敗(500) 等）は含めない。
function isVoicevoxUnreachableError(err) {
    const message = String(err?.message || "");
    return (err && err.name === "TypeError")
        || /Failed to fetch|NetworkError|ERR_CONNECTION|応答しません/i.test(message);
}

/**
 * audio_query の結果から音声の長さ（秒）を見積もる。先読み量と再生開始の判断に使い、
 * 話速・休止設定を含める。フレーム丸めの差は再生開始の余裕で吸収する。
 */
function estimateQueryDurationSec(query, speedScale) {
    let seconds = (Number(query.prePhonemeLength) || 0) + (Number(query.postPhonemeLength) || 0);
    const phrases = Array.isArray(query.accent_phrases) ? query.accent_phrases : [];
    for (const phrase of phrases) {
        const moras = Array.isArray(phrase?.moras) ? phrase.moras : [];
        for (const mora of moras) {
            seconds += (Number(mora?.consonant_length) || 0) + (Number(mora?.vowel_length) || 0);
        }
        if (phrase?.pause_mora) {
            const pause = query.pauseLength == null
                ? (Number(phrase.pause_mora.vowel_length) || 0) : Number(query.pauseLength);
            const scale = Number.isFinite(Number(query.pauseLengthScale)) ? Number(query.pauseLengthScale) : 1;
            seconds += pause * scale;
        }
    }
    const speed = Number(speedScale) > 0 ? Number(speedScale) : 1;
    return seconds / speed;
}

/**
 * VOICEVOX が非2xxを返したときのエラー。HTTPステータスを err.httpStatus に残し、
 * 「割って読み直すか」の判断をメッセージの文字列一致に頼らずに行えるようにする。
 * userFacing を立てた文言はそのまま利用者へ表示される。
 */
function voicevoxHttpError(status) {
    const message = status >= 500
        ? `VOICEVOXエンジンがこの文を処理できませんでした（応答コード${status}）`
        : `VOICEVOXエンジンが要求を受け付けませんでした（応答コード${status}）。`
            + "オプション画面で話者を選び直すと直ることがあります";
    const error = new Error(message);
    error.httpStatus = status;
    error.userFacing = true;
    return error;
}

/**
 * VOICEVOX ではない応答（JSONでない・音声合成用クエリの形をしていない）に対するエラー。
 */
function voicevoxUnexpectedResponseError() {
    const error = new Error(
        "VOICEVOXエンジンから予期しない応答が返りました。"
        + "ポート50021を別のアプリが使っていないか確認してください");
    error.userFacing = true;
    return error;
}

// ===== 括弧が作る不自然な間を取り除く =====
//
// 括弧そのものは読まれないが、開き・閉じの両方が「間」を作り、直後の助詞を別の
// アクセント句へ切り離す。実測（VOICEVOX 0.25.2 / 話者1）:
//   彼は「はい」と答えた。  カレワ、ハイ、ト/コタエタ  無音0.94秒・全体3.27秒
//   括弧を外すと            カレワ/ハイト/コタエタ     無音0秒・全体1.92秒
//
// ただし括弧を外すと、隣り合う語がつながって読みが変わることがある。文字の並びからは
// 判別できない（実測: 「彼は「ええ」と言った」を外すと助詞の「は」が吸収されて
// カレ/ハエエト になる。「ABC（株）」はカブシキガイシャがカブになる。
// 「9月1日（月）」はゲツヨオビがツイタチビになる）。
// そこで**エンジン自身に両方の読みを尋ね、音素列と語の切れ目が変わらないときだけ外す**。
// 間（pause_mora）と句の結合は比較に含めない。それを減らすことが目的だから。
// audio_query は実測13ミリ秒で、合成に比べて無視できる。
const OFFSCREEN_BRACKET_RE = /[「」『』（）()｢｣〈〉《》【】〔〕]/g;
// 閉じと開きが隣り合う所（「はい」「いいえ」）は、外すと2つの引用が地続きになる。
// 音素列は変わらないためエンジンには区別できないので、読点1つを残す。
const OFFSCREEN_BRACKET_JUNCTION_RE = /[」』）)｣〉》】〕]\s*[「『（(｢〈《【〔]/g;

/**
 * 括弧を外した読み上げ用の候補を作る。外すものが無ければ null。
 * @param {string} text
 * @returns {string|null}
 */
function bracketFreeCandidate(text) {
    if (!OFFSCREEN_BRACKET_RE.test(text)) {
        OFFSCREEN_BRACKET_RE.lastIndex = 0;
        return null;
    }
    OFFSCREEN_BRACKET_RE.lastIndex = 0;
    const candidate = text
        .replace(OFFSCREEN_BRACKET_JUNCTION_RE, "、")
        .replace(OFFSCREEN_BRACKET_RE, "");
    return candidate && candidate !== text ? candidate : null;
}

/**
 * 読みを比べるための情報を取り出す。
 * - phonemes: 子音＋母音の並び。カナだけの比較では拾えない無声化（「す」の u → U）まで見る。
 * - boundaries: アクセント句の切れ目（先頭からのモーラ数）。語のまとまりが変わったかを見る。
 * 間（pause_mora）と句の長さそのものは含めない。間が減ることが目的だから。
 * @param {object} query
 * @returns {{phonemes: string, boundaries: number[]}}
 */
function queryReadingSignature(query) {
    const phonemes = [];
    const boundaries = [];
    const phrases = Array.isArray(query?.accent_phrases) ? query.accent_phrases : [];
    let count = 0;
    for (const phrase of phrases) {
        const moras = Array.isArray(phrase?.moras) ? phrase.moras : [];
        for (const mora of moras) {
            phonemes.push(String(mora?.consonant || "") + String(mora?.vowel || mora?.text || ""));
            count += 1;
        }
        boundaries.push(count);
    }
    return { phonemes: phonemes.join(" "), boundaries };
}

/**
 * 括弧を外した読みが、元の読みと同じと言えるか。
 * 許すのは「アクセント句がつながること」だけ。これが括弧を外す目的そのもので、
 * 直後の助詞が元の句へ戻る（カレワ、ハイ、ト → カレワ/ハイト）。
 * 逆に**新しい切れ目が生まれた**場合は、語のまとまりが変わっている。
 * 実測: 「ここで」「はきもの」を脱ぐ。→ ハキモノ が ハキ/モノオ に割れる。
 * 音素まで一致していても、これは読みが変わったものとして退ける。
 * @param {object} candidateQuery
 * @param {object} originalQuery
 * @returns {boolean}
 */
function isSameReading(candidateQuery, originalQuery) {
    const candidate = queryReadingSignature(candidateQuery);
    const original = queryReadingSignature(originalQuery);
    if (candidate.phonemes !== original.phonemes) return false;
    const originalBoundaries = new Set(original.boundaries);
    return candidate.boundaries.every((at) => originalBoundaries.has(at));
}

/**
 * 括弧を外しても読みが変わらないなら、外したほうのクエリを使う。
 * 判定できない・取得に失敗したときは元のクエリをそのまま返す（読みを壊さない側に倒す）。
 * @param {string} text
 * @param {number} speaker
 * @param {object} queryJson 元のテキストのクエリ
 * @returns {Promise<object>}
 */
async function preferBracketFreeQuery(text, speaker, queryJson) {
    const candidate = bracketFreeCandidate(text);
    if (!candidate) return queryJson;
    let candidateQuery;
    try {
        candidateQuery = await requestAudioQuery(candidate, speaker);
    } catch (error) {
        return queryJson;
    }
    return isSameReading(candidateQuery, queryJson) ? candidateQuery : queryJson;
}

/**
 * 音声合成用クエリを1件取得する。
 * @param {string} text
 * @param {number} speaker
 * @returns {Promise<object>}
 */
async function requestAudioQuery(text, speaker) {
    const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`;
    const queryResponse = await fetchWithTimeout(
        queryUrl, { method: "POST" }, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!queryResponse.ok) throw voicevoxHttpError(queryResponse.status);

    let queryJson;
    try {
        queryJson = await readJsonResponseWithLimit(queryResponse);
    } catch (error) {
        // 本文がJSONでない（同じポートを別のプロセスが使っている、エラーページが返る等）。
        // ここで置き換えないと JSON.parse の英語の内部メッセージがそのまま通知へ出る。
        // realm をまたいで投げられるので instanceof ではなく name で判定する。
        if (error?.name === "SyntaxError") throw voicevoxUnexpectedResponseError();
        throw error;
    }
    // 応答の形を確かめてから書き込む。null や配列以外が返ったとき、この後の代入が
    // TypeError になり「Cannot set properties of null」がそのまま利用者へ出ていた。
    if (!queryJson || typeof queryJson !== "object" || !Array.isArray(queryJson.accent_phrases)) {
        throw voicevoxUnexpectedResponseError();
    }
    return queryJson;
}

/**
 * 読みが変わらない場合だけ括弧の間を除き、先読み・合成で共有するクエリを用意する。
 * 制限時間つきの fetch（fetchWithTimeout）は constants.js で定義している。
 * @returns {Promise<object>}
 */
async function prepareVoiceQuery(text, settings) {
    const { speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLengthScale } = settings;
    // speaker はURLに載るため数値に正規化する（不正値が紛れてもURLを壊さない）
    const speaker = Number(speakerId);

    let queryJson = await requestAudioQuery(text, speaker);
    queryJson = await preferBracketFreeQuery(text, speaker, queryJson);

    queryJson.prePhonemeLength = 0.1 * speedScale;
    queryJson.postPhonemeLength = 0.1 * speedScale;
    queryJson.speedScale = speedScale;
    queryJson.pitchScale = pitchScale;
    queryJson.intonationScale = intonationScale;
    queryJson.volumeScale = volumeScale;
    queryJson.pauseLengthScale = pauseLengthScale;
    return queryJson;
}

/**
 * 検証済みのクエリを合成する。先読み済みなら同じクエリを再取得しない。
 * @returns {Promise<{url: string, durationSec: number}>}
 */
async function generateVoiceBlob(text, settings, preparedQuery = null) {
    const queryJson = preparedQuery || await prepareVoiceQuery(text, settings);
    const speaker = Number(settings.speakerId);

    const synthUrl = `${VOICEVOX_BASE_URL}/synthesis?speaker=${speaker}`;
    const synthResponse = await fetchWithTimeout(synthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queryJson)
    }, VOICEVOX_SYNTHESIS_TIMEOUT_MS);
    if (!synthResponse.ok) throw voicevoxHttpError(synthResponse.status);

    const audioBlob = await readBlobResponseWithLimit(synthResponse);
    return {
        url: URL.createObjectURL(audioBlob),
        durationSec: estimateQueryDurationSec(queryJson, settings.speedScale)
    };
}

/**
 * 再生待ちキューを処理する
 */
async function processPlayback(continuePlayback = false) {
    if (isPlaying || audioQueue.length === 0) return;
    if (audioQueue[0].streaming) {
        clearPlaybackBufferTimer();
        const item = audioQueue.shift();
        const generation = playbackGeneration;
        isPlaying = true;
        const player = globalThis.VVRadioStreaming.createPlayer(
            item.query, Number(item.settings.speakerId), () => {
                if (generation === playbackGeneration) notifyBackground("PLAYBACK_STARTED");
            });
        currentStreamingPlayer = player;
        let completed = false;
        try {
            await player.run();
            completed = true; // readerの終了だけではなく最後のAudioBufferの再生完了まで待つ
        } catch (error) {
            if (generation !== playbackGeneration) return;
            globalThis.VVRadioStreaming.suppress(item.settings.speakerId);
            if (player.canFallback === true) {
                // 未予約、または開始前の予約取消し・Context解放が完了した場合のみ再試行。
                textQueue.unshift({ text: item.text, settings: item.settings,
                    forceNormal: true, query: item.query, durationSec: item.durationSec,
                    splitDepth: item.splitDepth, notice: item.notice });
            } else {
                // 再生済み音声を先頭から二重に再生しない。途中復旧は安全性未検証。
                textQueue = [];
                for (const ready of audioQueue) if (ready.url) URL.revokeObjectURL(ready.url);
                audioQueue = [];
                console.error("Offscreen: ストリーミング再生失敗:", error);
                notifyBackground("PLAYBACK_ERROR",
                    { error: "ストリーミング再生を中断しました: " + error.message });
            }
        } finally {
            await player.stop();
            if (generation === playbackGeneration) {
                currentStreamingPlayer = null;
                isPlaying = false;
                if (completed && textQueue.length === 0 && audioQueue.length === 0
                    && !isSynthesizing) notifyBackground("PLAYBACK_ENDED");
                processSynthesis();
                processPlayback(true);
            }
        }
        return;
    }

    clearPlaybackBufferTimer();
    processSynthesis();
    const atBufferLimit = audioQueue.length >= MAX_READY_AUDIO_QUEUE
        || readyAudioSeconds() >= MAX_READY_AUDIO_SECONDS;
    if (!continuePlayback && !atBufferLimit && activeSynthesis?.durationSec === null) return;
    // 未準備の次クエリがある間は負荷を判定できない。準備完了・失敗時に再評価される。
    if (!continuePlayback && !atBufferLimit && !activeSynthesis && textQueue[0]
        && !textQueue[0].query && !textQueue[0].queryError) return;
    const waitSeconds = requiredPlaybackBufferSeconds() - readyAudioSeconds();
    if (!continuePlayback && !atBufferLimit && waitSeconds > 0.001) {
        const generation = playbackGeneration;
        // 合成完了時にも再評価する。長い合成の途中でも残り時間がバッファ内に収まれば
        // 開始でき、全文合成の完了まで待たせない。
        playbackBufferTimer = setTimeout(() => {
            playbackBufferTimer = null;
            if (generation === playbackGeneration) processPlayback();
        }, Math.max(1, waitSeconds * 1000));
        return;
    }

    isPlaying = true;
    notifyBackground("PLAYBACK_STARTED");
    const generation = playbackGeneration;

    const current = audioQueue.shift();
    // 完成済みキューに空きができたので、再生と並行して次の1件だけを合成する。
    // processSynthesis 側の上限判定により、それより先の文はテキストのまま待機する。
    processSynthesis();
    const audio = new Audio(current.url);
    currentAudio = audio;
    currentAudioUrl = current.url;

    let isCleanedUp = false;

    const cleanup = (completedNormally) => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(current.url);
        if (currentAudioUrl === current.url) currentAudioUrl = null;
        audio.removeAttribute('src');
        audio.load();

        if (currentAudio === audio) currentAudio = null;
        isPlaying = false;

        if (completedNormally && audioQueue.length === 0 && textQueue.length === 0 && !isSynthesizing) {
            notifyBackground("PLAYBACK_ENDED");
        }

        // 既に完成している音声はそのまま続ける。予測の更新を理由に途中へ間を挿入しない。
        // 実際にバッファが空になった場合だけ、再開時に必要量を再び確保する。
        processPlayback(completedNormally && audioQueue.length > 0);
    };

    audio.onended = () => cleanup(true);
    audio.onerror = (e) => {
        const errorInfo = audio.error
            ? `Code: ${audio.error.code}, Message: ${audio.error.message}`
            : "Details unavailable";
        console.error(`Offscreen: Audioエラー [${errorInfo}]`, e);
        notifyBackground("PLAYBACK_ERROR", { error: errorInfo });
        cleanup(false);
    };

    try {
        await audio.play();
    } catch (err) {
        if (generation !== playbackGeneration) return;
        console.error("Offscreen: play()失敗:", err.name, err.message);
        notifyBackground("PLAYBACK_ERROR", { error: `${err.name}: ${err.message}` });
        cleanup(false);
    }
}

function stopAll() {
    // 何も動いていないときの停止（読み上げ開始前の STOP_AUDIO・二度目の停止）では
    // PLAYBACK_STOPPED を通知しない。開始直前に「停止」が届くと capture.html の
    // 表示が「停止しました」→「再生中」と往復し、タブのアイコンも一瞬点滅する。
    const wasActive = isPlaying || isSynthesizing || textQueue.length > 0 || audioQueue.length > 0
        || currentAudio != null || currentStreamingPlayer != null;
    // in-flight の合成を無効化（完了しても破棄させる）
    synthesisGeneration++;
    clearPlaybackBufferTimer();
    activeSynthesis = null;
    synthesisSecondsPerAudioSecond = 0.7;
    // 連続失敗の数え上げは1回の読み上げの中だけで意味を持つ。エンジンを起動し直して
    // やり直したときに、前回の失敗数のせいで1文目で打ち切られないようにする。
    consecutiveSynthesisFailures = 0;
    // in-flight の再生開始処理を無効化（停止後の AbortError 等を通知しない）
    playbackGeneration++;
    if (currentStreamingPlayer) {
        currentStreamingPlayer.stop();
        currentStreamingPlayer = null;
    }

    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
        currentAudio = null;
    }
    if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
    }

    textQueue = [];
    audioQueue.forEach(item => { if (item.url) URL.revokeObjectURL(item.url); });
    audioQueue = [];

    isSynthesizing = false;
    isPlaying = false;

    if (wasActive) notifyBackground("PLAYBACK_STOPPED");
}

function notifyBackground(type, payload = {}) {
    // background 側は応答を返さない通知なので、応答チャネルが閉じたことによる
    // 拒否は無視する（放置すると未処理の Promise 拒否でコンソールが埋まる）。
    chrome.runtime.sendMessage({ type, target: 'background', ...payload }).catch(() => {});
}
