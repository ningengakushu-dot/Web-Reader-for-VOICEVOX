// Offscreen Document: 実際の音声再生と合成を担当

let textQueue = [];
let audioQueue = [];
let isSynthesizing = false;
let isPlaying = false;
let currentAudio = null;
// 合成の世代トークン。stopAll() で繰り上げることで、停止前に開始済みの
// 合成（in-flight）が完了しても、その結果を破棄して状態に反映させない。
let synthesisGeneration = 0;

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    switch (message.type) {
        case 'ENQUEUE_TEXT':
            enqueueText(message.text, message.settings);
            sendResponse({ success: true });
            break;
        case 'STOP_AUDIO':
            stopAll();
            sendResponse({ success: true });
            break;
    }
    return false;
});

/**
 * テキストを合成待ちキューに追加し、合成プロセスを開始する
 */
function enqueueText(text, settings) {
    textQueue.push({ text, settings });
    processSynthesis();
}

/**
 * 合成待ちキューを処理し、音声を生成する
 */
async function processSynthesis() {
    if (isSynthesizing || textQueue.length === 0) return;

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
 * VOICEVOX APIを使用して音声を合成し、Blob URLを返す
 */
async function generateVoiceBlob(text, settings) {
    const { speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLengthScale } = settings;

    const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(text)}`;
    const queryResponse = await fetch(queryUrl, { method: "POST" });
    if (!queryResponse.ok) throw new Error(`Query失敗(${queryResponse.status})`);

    const queryJson = await queryResponse.json();

    queryJson.prePhonemeLength = 0.1 * speedScale;
    queryJson.postPhonemeLength = 0.1 * speedScale;
    queryJson.speedScale = speedScale;
    queryJson.pitchScale = pitchScale;
    queryJson.intonationScale = intonationScale;
    queryJson.volumeScale = volumeScale;
    queryJson.pauseLengthScale = pauseLengthScale;

    const synthUrl = `${VOICEVOX_BASE_URL}/synthesis?speaker=${speakerId}`;
    const synthResponse = await fetch(synthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queryJson)
    });
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

    const current = audioQueue.shift();
    const audio = new Audio(current.url);
    currentAudio = audio;

    let isCleanedUp = false;

    const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(current.url);
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
        console.error("Offscreen: play()失敗:", err.name, err.message);
        notifyBackground("PLAYBACK_ERROR", { error: `${err.name}: ${err.message}` });
        cleanup();
    }
}

function stopAll() {
    // in-flight の合成を無効化（完了しても破棄させる）
    synthesisGeneration++;

    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
        currentAudio = null;
    }

    textQueue = [];
    audioQueue.forEach(item => URL.revokeObjectURL(item.url));
    audioQueue = [];

    isSynthesizing = false;
    isPlaying = false;

    notifyBackground("PLAYBACK_STOPPED");
}

function notifyBackground(type, payload = {}) {
    chrome.runtime.sendMessage({ type, target: 'background', ...payload });
}
