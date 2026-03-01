// Offscreen Document: 実際の音声再生を担当

let audioQueue = [];
let isPlaying = false;
let currentAudio = null;

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    switch (message.type) {
        case 'PLAY_AUDIO':
            playAudio(message.data, message.text);
            break;
        case 'STOP_AUDIO':
            stopAll();
            break;
    }
});

function playAudio(url, text) {
    console.log("Offscreen: 再生待ちに追加:", text);
    audioQueue.push({ url, text });
    processQueue();
}

async function processQueue() {
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

        if (current.url.startsWith('blob:')) {
            URL.revokeObjectURL(current.url);
        }
        audio.removeAttribute('src');
        audio.load();

        if (currentAudio === audio) {
            currentAudio = null;
        }
        isPlaying = false;

        if (audioQueue.length === 0) {
            notifyBackground("PLAYBACK_ENDED");
        }
        
        processQueue();
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
    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
        currentAudio = null;
    }
    audioQueue.forEach(item => {
        if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url);
    });
    audioQueue = [];
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
