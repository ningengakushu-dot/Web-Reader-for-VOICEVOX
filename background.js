// VOICEVOXエンジンのベースURL（ローカルサーバー）
const VOICEVOX_BASE_URL = "http://127.0.0.1:50021";

// 設定のデフォルト値
const SETTING_DEFAULTS = {
    speakerId: 1,
    speedScale: 1.0,
    pitchScale: 0.0,
    intonationScale: 1.0,
    volumeScale: 1.0,
    pauseLengthScale: 1.0
};

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
        chrome.tabs.sendMessage(tab.id, {
            type: "READ_SELECTED_TEXT",
            text: info.selectionText
        }).catch(() => {});
    }
});

// ショートカットキーが押された時の処理
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-reading") {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_READING" }).catch(() => {});
            }
        });
    }
});

// --- Offscreen Document 管理 ---
let offscreenCreating = null;

async function setupOffscreen() {
    try {
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });

        if (existingContexts.length > 0) return;

        if (offscreenCreating) {
            await offscreenCreating;
            return;
        }

        console.log("Background: Offscreen Document を作成します");
        offscreenCreating = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['AUDIO_PLAYBACK'],
            justification: '音声再生によるアクセシビリティ向上のため（CSP制限サイト回避）'
        });

        await offscreenCreating;
        offscreenCreating = null;
    } catch (err) {
        offscreenCreating = null;
        console.error("Background: setupOffscreen 失敗:", err.name, err.message);
        throw err;
    }
}

// Offscreen にメッセージを送信するヘルパー
function sendToOffscreen(message) {
    chrome.runtime.sendMessage({ ...message, target: 'offscreen' }).catch(() => {});
}

// Content Scriptからのメッセージを処理するリスナー
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.target && request.target !== 'background') return;

    switch (request.type) {
        case "OPEN_OPTIONS":
            chrome.runtime.openOptionsPage();
            sendResponse({ success: true });
            return false;

        case "CHECK_CONNECTION":
            fetch(`${VOICEVOX_BASE_URL}/version`)
                .then(res => sendResponse({ success: res.ok }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case "GET_SPEAKERS":
            fetch(`${VOICEVOX_BASE_URL}/speakers`)
                .then(res => res.json())
                .then(speakers => sendResponse({ success: true, speakers }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case "GENERATE_VOICE":
            handleGenerateVoice(request.text, sendResponse);
            return true;

        case "STOP_ALL":
            setupOffscreen().then(() => sendToOffscreen({ type: 'STOP_AUDIO' }));
            sendResponse({ success: true });
            return false;

        case "PLAYBACK_STARTED":
        case "PLAYBACK_ENDED":
        case "PLAYBACK_ERROR":
        case "PLAYBACK_STOPPED":
            chrome.tabs.query({active: true}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, request).catch(() => {});
                });
            });
            return false;
    }

    return false;
});

async function handleGenerateVoice(text, sendResponse) {
    const result = await chrome.storage.local.get(Object.keys(SETTING_DEFAULTS));
    const settings = { ...SETTING_DEFAULTS, ...result };
    const chunks = splitText(text);

    try {
        await setupOffscreen();
        sendToOffscreen({ type: 'STOP_AUDIO' });

        for (const chunk of chunks) {
            sendToOffscreen({
                type: 'ENQUEUE_TEXT',
                text: chunk,
                settings
            });
        }
        sendResponse({ success: true });
    } catch (err) {
        console.error("Background: 準備エラー:", err);
        sendResponse({ success: false, error: err.message });
    }
}

/**
 * テキストを文末記号（。！？）と改行で分割する
 * 読点（、）等はVOICEVOXが自然なポーズで処理するため分割しない
 */
function splitText(text) {
    if (!text) return [];

    const sentences = text.split(/([。！？\n])/);
    const chunks = [];
    let currentChunk = "";

    for (let i = 0; i < sentences.length; i++) {
        currentChunk += sentences[i];

        if (i % 2 === 1 || i === sentences.length - 1) {
            const trimmed = currentChunk.trim();
            if (trimmed) chunks.push(trimmed);
            currentChunk = "";
        }
    }

    return chunks.length > 0 ? chunks : [text];
}
