// Offscreen Document: 実際の音声再生と合成を担当
const VOICEVOX_BASE_URL = "http://127.0.0.1:50021";

let textQueue = [];  // 合成待ちのテキスト
let audioQueue = []; // 再生待ちの音声（Blob URL）
let isSynthesizing = false; // 現在合成中か
let isPlaying = false;      // 現在再生中か
let currentAudio = null;    // 現在再生中のAudioオブジェクト

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    switch (message.type) {
        case 'ENQUEUE_TEXT':
            enqueueText(message.text, message.speakerId, message.speedScale, message.pitchScale, message.intonationScale, message.volumeScale, message.pauseLength);
            break;
        case 'STOP_AUDIO':
            stopAll();
            break;
    }
    return false; // 非同期応答不要
});

/**
 * テキストを合成待ちキューに追加し、合成プロセスを開始する
 */
function enqueueText(text, speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLength) {
    console.log("Offscreen: 合成待ちに追加:", text);
    textQueue.push({ text, speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLength });
    processSynthesis();
}

/**
 * 合成待ちキューを処理し、音声を生成する
 */
async function processSynthesis() {
    if (isSynthesizing || textQueue.length === 0) return;

    isSynthesizing = true;
    const item = textQueue.shift();

    try {
        console.log("Offscreen: 合成開始:", item.text);
        const blobUrl = await generateVoiceBlob(item.text, item.speakerId, item.speedScale, item.pitchScale, item.intonationScale, item.volumeScale, item.pauseLength);
        audioQueue.push({ url: blobUrl, text: item.text });
        
        // 音声ができたら再生プロセスも回す
        processPlayback();
    } catch (err) {
        console.error("Offscreen: 合成失敗:", err);
        notifyBackground("PLAYBACK_ERROR", { error: `合成失敗: ${err.message}` });
    } finally {
        isSynthesizing = false;
        // 次の合成へ
        processSynthesis();
    }
}

/**
 * VOICEVOX APIを使用して音声を合成し、Blob URLを返す
 */
async function generateVoiceBlob(text, speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLength) {
    const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(text)}`;
    const queryResponse = await fetch(queryUrl, { method: "POST" });
    if (!queryResponse.ok) throw new Error(`Query失敗(${queryResponse.status})`);
    
    const queryJson = await queryResponse.json();
    queryJson.prePhonemeLength = 0.1;
    queryJson.postPhonemeLength = pauseLength !== undefined ? pauseLength : 1.0;
    queryJson.speedScale = speedScale !== undefined ? speedScale : 1.0;
    queryJson.pitchScale = pitchScale !== undefined ? pitchScale : 0.0;
    queryJson.intonationScale = intonationScale !== undefined ? intonationScale : 1.0;
    queryJson.volumeScale = volumeScale !== undefined ? volumeScale : 1.0;

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
    console.log("Offscreen: 再生開始:", current.text);

    const audio = new Audio(current.url);
    currentAudio = audio;

    let isCleanedUp = false;

    const cleanup = (reason = "unknown") => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        console.log(`Offscreen: クリーンアップ (理由: ${reason})`);
        
        audio.onended = null;
        audio.onerror = null;

        URL.revokeObjectURL(current.url);
        audio.removeAttribute('src');
        audio.load();

        if (currentAudio === audio) {
            currentAudio = null;
        }
        isPlaying = false;

        if (audioQueue.length === 0 && textQueue.length === 0) {
            notifyBackground("PLAYBACK_ENDED");
        }
        
        processPlayback();
    };

    audio.onended = () => cleanup("ended");
    audio.onerror = (e) => {
        const errorInfo = audio.error ? `Code: ${audio.error.code}, Message: ${audio.error.message}` : "Details unavailable";
        console.error(`Offscreen: Audioエラー [${errorInfo}]`, e);
        notifyBackground("PLAYBACK_ERROR", { error: errorInfo });
        cleanup("error");
    };

    try {
        await audio.play();
    } catch (err) {
        console.error("Offscreen: play()失敗:", err.name, err.message);
        notifyBackground("PLAYBACK_ERROR", { error: `${err.name}: ${err.message}` });
        cleanup("play_failed");
    }
}

function stopAll() {
    console.log("Offscreen: 全停止");
    
    // 現在の再生を停止
    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
        currentAudio = null;
    }

    // キューをクリア
    textQueue = [];
    audioQueue.forEach(item => {
        URL.revokeObjectURL(item.url);
    });
    audioQueue = [];
    
    isSynthesizing = false;
    isPlaying = false;
    
    notifyBackground("PLAYBACK_STOPPED");
}

function notifyBackground(type, payload = {}) {
    chrome.runtime.sendMessage({
        type,
        target: 'background',
        ...payload
    });
}
