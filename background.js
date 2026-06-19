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

// ショートカット要求のタブ別二重発火抑制。chrome.commands 経路と content.js の
// trusted keydown フォールバック（SHORTCUT_PRESSED）が同一キー押下で同時に発火しても、
// 同一タブで二重トグルしないよう直近に受理した要求の時刻と発生源を記録する。
// 全体デバウンスではなく「異なる発生源からの近接重複のみ」を抑制するため、
// ユーザーが素早く2回押して読み上げを止める操作はそのまま通る。
const SHORTCUT_DUPLICATE_MS = 400;
const lastShortcut = new Map();

// ショートカット要求の共通処理。commands.onCommand と content.js の
// SHORTCUT_PRESSED フォールバックの両方からこの関数を呼び出す。
async function handleShortcutRequest(tabId, source) {
    if (tabId == null) return;

    // 直近に受理した要求が「異なる発生源」かつ重複ウィンドウ内なら、
    // 同一キー押下が両経路で二重発火したものとみなして抑制する。
    // 同一発生源からの連続要求は素早いトグルとして許可する。
    const now = Date.now();
    const last = lastShortcut.get(tabId);
    if (last != null && last.source !== source && now - last.at < SHORTCUT_DUPLICATE_MS) {
        return;
    }

    // 非同期注入の前に受理タイムスタンプと発生源を更新し、
    // commands と content の同時発火による二重トリガを防ぐ。
    lastShortcut.set(tabId, { at: now, source });

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
        console.warn(`Background: ショートカット用 content.js 事前注入失敗 (${source}):`, err.message);
    }

    await sendMessageWithInjection(
        tabId,
        { type: "TOGGLE_READING" },
        "ショートカットキーのメッセージ送信失敗"
    );
}

// ショートカットキーが押された時の処理
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-reading") {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs.length === 0) return;
            handleShortcutRequest(tabs[0].id, "commands.onCommand");
        });
    }
});

// 再生状態通知（PLAYBACK_*）の宛先タブ。GENERATE_VOICE を要求したタブの id を記録し、
// offscreen から届く再生状態を「全アクティブタブ」ではなく要求元タブにのみ転送する。
// これにより、別ウィンドウ/別タブのアイコンUIが他タブの再生状態で誤更新される問題を防ぐ。
let playbackTabId = null;

// タブが閉じられたら、保持している状態（再生宛先・ショートカット重複抑制）を掃除する。
chrome.tabs.onRemoved.addListener((tabId) => {
    lastShortcut.delete(tabId);
    if (playbackTabId === tabId) {
        playbackTabId = null;
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
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target && request.target !== 'background') return;

    switch (request.type) {
        case "SHORTCUT_PRESSED":
            // content.js の trusted keydown フォールバックからの要求。
            // commands.onCommand と同じ共通処理に集約する。
            handleShortcutRequest(sender.tab?.id, "content.SHORTCUT_PRESSED")
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

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

        case "GENERATE_VOICE": {
            // 要求元タブを再生状態通知の宛先として記録する。
            // ショートカット/コンテキストメニュー経由でも content.js から送信されるため
            // sender.tab.id で正しい要求元タブが取得できる。
            const requestTabId = sender.tab?.id ?? null;
            // 別タブからの新しい再生要求なら、前の再生タブへ明示的に停止を通知してから
            // 宛先を切り替える。前タブのアイコンUIが「再生中」のまま取り残されるのを防ぐ。
            if (requestTabId != null && playbackTabId != null && playbackTabId !== requestTabId) {
                chrome.tabs.sendMessage(playbackTabId, { type: "PLAYBACK_STOPPED" })
                    .catch(warn("旧再生タブへの停止通知失敗"));
            }
            if (requestTabId != null) {
                playbackTabId = requestTabId;
            }
            handleGenerateVoice(request.text, sendResponse);
            return true;
        }

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
            // 再生を要求したタブにのみ転送する。全アクティブタブへ配信すると、
            // 別ウィンドウのアクティブタブのUIまで誤って更新されてしまう。
            if (playbackTabId != null) {
                chrome.tabs.sendMessage(playbackTabId, request)
                    .catch(warn("再生状態の転送失敗"));
            }
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
