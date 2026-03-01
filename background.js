// VOICEVOXエンジンのベースURL（ローカルサーバー）
const VOICEVOX_BASE_URL = "http://127.0.0.1:50021";

// 拡張機能インストール時にコンテキストメニューを作成
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "read-selected-text",
        title: "選択したテキストをWeb Reader for VOICEVOXで読み上げ",
        contexts: ["selection"]
    });
});

// コンテキストメニューがクリックされた時の処理
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "read-selected-text" && info.selectionText) {
        // Content script にメッセージを送信
        chrome.tabs.sendMessage(tab.id, {
            type: "READ_SELECTED_TEXT",
            text: info.selectionText
        });
    }
});

// ショートカットキーが押された時の処理
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-reading") {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_READING" });
            }
        });
    }
});

// --- Offscreen Document 管理 ---
let offscreenCreating = null; // 作成中のPromise

async function setupOffscreen() {
    // すでに存在するか確認
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
        return;
    }

    // 作成中なら待機
    if (offscreenCreating) {
        await offscreenCreating;
        return;
    }

    // 新規作成
    offscreenCreating = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: '音声再生によるアクセシビリティ向上のため（CSP制限サイト回避）'
    });
    await offscreenCreating;
    offscreenCreating = null;
}

// Content Scriptからのメッセージを処理するリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // ターゲットがbackgroundでない場合は無視（Offscreenからの返信など）
    if (request.target && request.target !== 'background') return;

    // オプション画面を開く要求
    if (request.type === "OPEN_OPTIONS") {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
        return false;
    }

    // 接続確認
    if (request.type === "CHECK_CONNECTION") {
        fetch(`${VOICEVOX_BASE_URL}/version`)
            .then(res => res.ok ? sendResponse({ success: true }) : sendResponse({ success: false }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    // 音声生成リクエスト
    if (request.type === "GENERATE_VOICE") {
        chrome.storage.local.get(['speakerId', 'speedScale']).then(async (result) => {
            const speakerId = result.speakerId || 1;
            const speedScale = result.speedScale || 1.0;
            
            try {
                const data = await generateVoice(request.text, speakerId, speedScale);
                await setupOffscreen();
                chrome.runtime.sendMessage({
                    type: 'PLAY_AUDIO',
                    target: 'offscreen',
                    data: data,
                    text: request.text
                });
                sendResponse({ success: true });
            } catch (err) {
                console.error("Background: 生成/再生エラー:", err);
                sendResponse({ success: false, error: err.message });
            }
        });
        return true; 
    }

    // 停止リクエスト
    if (request.type === "STOP_ALL") {
        setupOffscreen().then(() => {
            chrome.runtime.sendMessage({
                type: 'STOP_AUDIO',
                target: 'offscreen'
            });
        });
        sendResponse({ success: true });
        return false;
    }

    // 再生状態の転送（Offscreen -> Content Script）
    if (["PLAYBACK_STARTED", "PLAYBACK_ENDED", "PLAYBACK_ERROR", "PLAYBACK_STOPPED"].includes(request.type)) {
        chrome.tabs.query({active: true}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, request);
            });
        });
    }

    return false;
});

/**
 * VOICEVOX APIを使用して音声を生成し、Base64文字列として返す
 */
async function generateVoice(text, speakerId, speedScale) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); 

    try {
        const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(text)}`;
        const queryResponse = await fetch(queryUrl, { method: "POST", signal: controller.signal });
        if (!queryResponse.ok) throw new Error(`Query失敗(${queryResponse.status})`);
        
        const queryJson = await queryResponse.json();
        queryJson.prePhonemeLength = 0.1;
        queryJson.speedScale = speedScale;

        const synthUrl = `${VOICEVOX_BASE_URL}/synthesis?speaker=${speakerId}`;
        const synthResponse = await fetch(synthUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(queryJson),
            signal: controller.signal
        });
        if (!synthResponse.ok) throw new Error(`Synthesis失敗(${synthResponse.status})`);

        const audioBlob = await synthResponse.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("Base64変換失敗"));
            reader.readAsDataURL(audioBlob);
        });

    } finally {
        clearTimeout(timeoutId);
    }
}
