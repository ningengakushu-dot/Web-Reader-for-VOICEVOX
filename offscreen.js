// Offscreen Document: 実際の音声再生と合成、およびページ内範囲選択OCRの文字認識を担当

let textQueue = [];
let audioQueue = [];
let isSynthesizing = false;
let isPlaying = false;
let currentAudio = null;
let currentAudioUrl = null;
// 再生中の音声とは別に、完成済み音声を何件まで先読みするか。
// 全文を再生より速く合成すると、長文では Blob と VOICEVOX の処理負荷が
// 読み上げ終了まで増え続ける。次の1件だけを用意すれば文間の途切れを防ぎつつ、
// メモリとCPUの使用量を文章量に依存しない一定範囲へ抑えられる。
const MAX_READY_AUDIO_QUEUE = 1;
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
            enqueueOcrRecognition(message);
            sendResponse({ success: true });
            break;
    }
    return false;
});

// --- ページ内範囲選択OCR ---

// 進行状況の通知先タブ（OCR実行中のみ設定）
let ocrProgressTabId = null;
// 1回のOCR要求で recognize は最大6回走る（拡大版・二値化版・融合用の各倍率）。
// 各回が独立に 0→1 を報告するため、そのまま流すと表示が 100%→0% を何度も繰り返す。
// 各回に「残りの一定割合」を割り当てて、全体として単調増加になるよう変換する。
const OCR_PROGRESS_PASS_SHARE = 0.6;
let ocrProgressBase = 0;
let ocrProgressPrev = 0;

function resetOcrProgress() {
    ocrProgressBase = 0;
    ocrProgressPrev = 0;
}

// tesseract の1回分の進捗を、通し進捗（単調増加）へ変換する
function toOverallOcrProgress(passProgress) {
    const p = Math.min(1, Math.max(0, passProgress || 0));
    // 前回より大きく戻ったら次の認識に移ったとみなし、その回の持ち分を確定させる
    if (p < ocrProgressPrev - 0.05) {
        ocrProgressBase += (1 - ocrProgressBase) * OCR_PROGRESS_PASS_SHARE;
    }
    ocrProgressPrev = p;
    return ocrProgressBase + (1 - ocrProgressBase) * OCR_PROGRESS_PASS_SHARE * p;
}

// OCRワーカーは組版方向（横書き jpn / 縦書き jpn_vert）ごとに初回利用時に生成し、
// 以降のOCRで使い回す。この offscreen document が破棄された場合は次回作成時に再生成される。
const ocrWorkers = createOcrWorkerPool((m) => {
    if (m.status === "recognizing text" && ocrProgressTabId != null) {
        notifyBackground("OCR_PROGRESS", {
            tabId: ocrProgressTabId,
            progress: toOverallOcrProgress(m.progress)
        });
    }
});
const getOcrWorker = ocrWorkers.get;

// 範囲OCR要求を1件ずつ順に処理するチェーン。共有Tesseractワーカーの recognize は
// 並行呼び出しに耐えず、進捗通知先 ocrProgressTabId もモジュールグローバルのため、
// 複数タブからの同時要求が混線しないよう直列化する。recognizeRegion は自身で
// OCR_COMPLETE を送るため、チェーンは失敗も飲み込んで（catch）次の要求へ進める。
let ocrChain = Promise.resolve();
function enqueueOcrRecognition(message) {
    ocrChain = ocrChain.then(() => recognizeRegion(message)).catch(() => {});
}

// ハングした可能性のあるワーカーを破棄し、次回のOCRで作り直させる（認識タイムアウト時に使用）。
const resetOcrWorkers = ocrWorkers.terminate;

/**
 * キャプチャ画像から選択範囲を切り出してOCRし、結果を background へ通知する。
 * rect はビューポートのCSSピクセル座標、キャプチャ画像は物理ピクセルのため、
 * 画像幅とビューポート幅の比率で座標変換する（devicePixelRatio・ズーム両対応）。
 */
async function recognizeRegion({ dataUrl, rect, viewportWidth, tabId, removeRuby }) {
    ocrProgressTabId = tabId ?? null;
    resetOcrProgress();
    cancelOcrWorkerIdleRelease();
    try {
        const blob = await (await fetch(dataUrl)).blob();
        const bitmap = await createImageBitmap(blob);
        const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : 1;

        const sx = Math.max(0, Math.min(Math.round(rect.x * scale), bitmap.width - 1));
        const sy = Math.max(0, Math.min(Math.round(rect.y * scale), bitmap.height - 1));
        const sw = Math.max(1, Math.min(Math.round(rect.width * scale), bitmap.width - sx));
        const sh = Math.max(1, Math.min(Math.round(rect.height * scale), bitmap.height - sy));

        const canvas = cropToOcrCanvas(bitmap, sx, sy, sw, sh);
        bitmap.close();

        // 組版方向（横書き/縦書き）を自動判定して認識する。
        // ルビ除去設定は offscreen では chrome.storage を参照できないため、
        // background がメッセージに載せて渡す（既定OFF）。
        // 認識がハングしても進捗トーストが残り続けないよう、タイムアウトで打ち切る。
        const data = await withOcrTimeout(
            recognizeWithOrientation(canvas, getOcrWorker, { removeRuby: removeRuby === true }),
            OCR_RECOGNIZE_TIMEOUT_MS,
            "文字認識に時間がかかりすぎました。範囲を狭めてお試しください。"
        );
        const text = cleanForSpeech(normalizeOcrText(data.text));

        if (!text) {
            notifyBackground("OCR_COMPLETE", { tabId, error: "文字を認識できませんでした。範囲を変えてお試しください。" });
            return;
        }
        notifyBackground("OCR_COMPLETE", { tabId, text });
    } catch (err) {
        console.error("Offscreen: OCR失敗:", err);
        // タイムアウトはワーカーがハングした可能性が高いため破棄して作り直させる
        if (err && err.isOcrTimeout) resetOcrWorkers();
        notifyBackground("OCR_COMPLETE", { tabId, error: `文字認識に失敗しました: ${err.message}` });
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

/**
 * 分割済みのテキストをまとめて合成待ちキューに追加し、合成プロセスを開始する。
 * 1文ずつ別メッセージで受け取ると、短い文では先頭の再生が終わった時点で
 * キューが空になり、まだ後続が残っているのに読み上げ終了として通知してしまう
 * （アイコンが途中で待機状態に戻る）。必ず全文をまとめて積む。
 */
function enqueueTexts(texts, settings) {
    if (!Array.isArray(texts) || texts.length === 0) return;
    for (const text of texts) {
        textQueue.push({ text, settings });
    }
    processSynthesis();
}

/**
 * 合成待ちキューを処理し、音声を生成する
 */
async function processSynthesis() {
    if (isSynthesizing || textQueue.length === 0
        || audioQueue.length >= MAX_READY_AUDIO_QUEUE) return;

    isSynthesizing = true;
    const item = textQueue.shift();
    // この合成が属する世代を記録。完了時に世代が進んでいれば stale とみなす。
    const generation = synthesisGeneration;

    try {
        const blobUrl = await generateVoiceBlob(item.text, item.settings);
        // 合成中に stopAll() が走った場合、生成済み Blob を破棄して状態を触らない
        if (generation !== synthesisGeneration) {
            URL.revokeObjectURL(blobUrl);
            return;
        }
        audioQueue.push({ url: blobUrl, text: item.text });
        processPlayback();
    } catch (err) {
        // stale な世代のエラーは通知も状態変更もしない
        if (generation !== synthesisGeneration) return;
        console.error("Offscreen: 合成失敗:", err);
        notifyBackground("PLAYBACK_ERROR", { error: `合成失敗: ${err.message}` });
    } finally {
        // 現在の世代のみが合成フラグの解除と次処理の継続を行える。
        // stale な世代では stopAll() が既に状態をリセット済みのため何もしない。
        if (generation === synthesisGeneration) {
            isSynthesizing = false;
            processSynthesis();
        }
    }
}

/**
 * VOICEVOX APIを使用して音声を合成し、Blob URLを返す。
 * 制限時間つきの fetch（fetchWithTimeout）は constants.js で定義している。
 */
async function generateVoiceBlob(text, settings) {
    const { speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLengthScale } = settings;
    // speaker はURLに載るため数値に正規化する（不正値が紛れてもURLを壊さない）
    const speaker = Number(speakerId);

    const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`;
    const queryResponse = await fetchWithTimeout(
        queryUrl, { method: "POST" }, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!queryResponse.ok) throw new Error(`Query失敗(${queryResponse.status})`);

    const queryJson = await queryResponse.json();

    queryJson.prePhonemeLength = 0.1 * speedScale;
    queryJson.postPhonemeLength = 0.1 * speedScale;
    queryJson.speedScale = speedScale;
    queryJson.pitchScale = pitchScale;
    queryJson.intonationScale = intonationScale;
    queryJson.volumeScale = volumeScale;
    queryJson.pauseLengthScale = pauseLengthScale;

    const synthUrl = `${VOICEVOX_BASE_URL}/synthesis?speaker=${speaker}`;
    const synthResponse = await fetchWithTimeout(synthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queryJson)
    }, VOICEVOX_SYNTHESIS_TIMEOUT_MS);
    if (!synthResponse.ok) throw new Error(`Synthesis失敗(${synthResponse.status})`);

    const audioBlob = await synthResponse.blob();
    return URL.createObjectURL(audioBlob);
}

/**
 * 再生待ちキューを処理する
 */
async function processPlayback() {
    if (isPlaying || audioQueue.length === 0) return;

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

    const cleanup = () => {
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

        if (audioQueue.length === 0 && textQueue.length === 0 && !isSynthesizing) {
            notifyBackground("PLAYBACK_ENDED");
        }

        processPlayback();
    };

    audio.onended = cleanup;
    audio.onerror = (e) => {
        const errorInfo = audio.error
            ? `Code: ${audio.error.code}, Message: ${audio.error.message}`
            : "Details unavailable";
        console.error(`Offscreen: Audioエラー [${errorInfo}]`, e);
        notifyBackground("PLAYBACK_ERROR", { error: errorInfo });
        cleanup();
    };

    try {
        await audio.play();
    } catch (err) {
        if (generation !== playbackGeneration) return;
        console.error("Offscreen: play()失敗:", err.name, err.message);
        notifyBackground("PLAYBACK_ERROR", { error: `${err.name}: ${err.message}` });
        cleanup();
    }
}

function stopAll() {
    // in-flight の合成を無効化（完了しても破棄させる）
    synthesisGeneration++;
    // in-flight の再生開始処理を無効化（停止後の AbortError 等を通知しない）
    playbackGeneration++;

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
    audioQueue.forEach(item => URL.revokeObjectURL(item.url));
    audioQueue = [];

    isSynthesizing = false;
    isPlaying = false;

    notifyBackground("PLAYBACK_STOPPED");
}

function notifyBackground(type, payload = {}) {
    // background 側は応答を返さない通知なので、応答チャネルが閉じたことによる
    // 拒否は無視する（放置すると未処理の Promise 拒否でコンソールが埋まる）。
    chrome.runtime.sendMessage({ type, target: 'background', ...payload }).catch(() => {});
}
