importScripts('constants.js');

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
    if (info.menuItemId === "read-selected-text" && info.selectionText && tab?.id) {
        const options = { frameId: Number.isInteger(info.frameId) ? info.frameId : 0 };
        sendMessageWithInjection(
            tab.id,
            { type: "READ_SELECTED_TEXT", text: info.selectionText },
            "コンテキストメニューからのメッセージ送信失敗",
            options
        );
    }
});

// content.js が未注入のタブ（拡張のインストール/リロード前から開かれていたタブ等）では
// tabs.sendMessage が "Receiving end does not exist" で失敗する。
// その場合は content.js を動的に注入してから元のメッセージを再送し、無言の失敗を防ぐ。
async function sendMessageWithInjection(tabId, message, context, options = {}) {
    const messageOptions = Number.isInteger(options.frameId) ? { frameId: options.frameId } : null;
    const injectionTarget = messageOptions
        ? { tabId, frameIds: [messageOptions.frameId] }
        : { tabId, allFrames: true };

    try {
        if (messageOptions) {
            await chrome.tabs.sendMessage(tabId, message, messageOptions);
        } else {
            await chrome.tabs.sendMessage(tabId, message);
        }
    } catch (err) {
        if (!/Receiving end does not exist/.test(err.message)) {
            console.warn(`Background: ${context}:`, err.message);
            return;
        }
        try {
            await chrome.scripting.executeScript({
                target: injectionTarget,
                files: ["content.js"]
            });
            if (messageOptions) {
                await chrome.tabs.sendMessage(tabId, message, messageOptions);
            } else {
                await chrome.tabs.sendMessage(tabId, message);
            }
        } catch (injectErr) {
            console.warn(`Background: ${context}（content.js 再注入後も失敗）:`, injectErr.message);
        }
    }
}

// ショートカットキーが押された時の処理
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-reading") {
        chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
            if (tabs.length === 0) return;
            const tabId = tabs[0].id;

            // TOGGLE_READING は全フレームへ配信され、フォーカスを持つフレームのみが処理する。
            // 未注入のフレーム（フォーカス中の子フレーム等）が取りこぼされないよう、
            // 送信前に全フレームへ content.js を事前注入する。
            // content.js は IIFE ガードを持つため再注入は安全（多重生成しない）。
            try {
                await chrome.scripting.executeScript({
                    target: { tabId, allFrames: true },
                    files: ["content.js"]
                });
            } catch (err) {
                console.warn("Background: ショートカット用 content.js 事前注入失敗:", err.message);
            }

            sendMessageWithInjection(
                tabId,
                { type: "TOGGLE_READING" },
                "ショートカットキーのメッセージ送信失敗"
            );
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
// 配信の成否を呼び出し元で扱えるよう Promise をそのまま返す
function sendToOffscreen(message) {
    return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

// 警告ログを出力するヘルパー（.catch() 用）
function warn(context) {
    return (err) => console.warn(`Background: ${context}:`, err.message);
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
            setupOffscreen()
                .then(() => sendToOffscreen({ type: 'STOP_AUDIO' }))
                .catch(warn("再生停止メッセージ送信失敗"));
            sendResponse({ success: true });
            return false;

        case "PLAYBACK_STARTED":
        case "PLAYBACK_ENDED":
        case "PLAYBACK_ERROR":
        case "PLAYBACK_STOPPED":
            chrome.tabs.query({active: true}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, request)
                        .catch(warn("再生状態の転送失敗"));
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
        // Offscreen への配信完了を確認してから成功応答を返す（無音失敗の可視化）
        await sendToOffscreen({ type: 'STOP_AUDIO' });

        for (const chunk of chunks) {
            await sendToOffscreen({
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

    const chunks = text.match(/[^。！？\n]+[。！？\n]?/g);
    if (!chunks) return [text];

    const result = chunks.map(s => s.trim()).filter(Boolean);
    return result.length > 0 ? result : [text];
}
