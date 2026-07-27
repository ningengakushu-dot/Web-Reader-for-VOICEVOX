importScripts('constants.js');

// 1リクエストで読み上げる最大文字数。ページ全体を誤選択した場合などに
// 合成リクエストが際限なく発行されるのを防ぐ安全弁。
const MAX_TEXT_LENGTH = 10000;

// 拡張機能インストール/更新時にコンテキストメニューを作成
// 既存メニューは更新をまたいで残る場合があり、同一 id の create は
// "Cannot create item with duplicate id" で失敗するため、必ず removeAll してから作る。
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        // removeAll のコールバック内で lastError を読み捨てないと未処理エラーになる
        void chrome.runtime.lastError;
        chrome.contextMenus.create({
            id: "read-selected-text",
            title: "選択したテキストをWeb Reader for VOICEVOXで読み上げ",
            contexts: ["selection"]
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn("Background: コンテキストメニュー作成失敗:", chrome.runtime.lastError.message);
            }
        });
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
    // なお SHORTCUT_PRESSED 経路では activeTab が付与されないため注入が失敗し得るが、
    // その場合も manifest 由来の content.js が既にいるため後続の送信で機能する。
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ["content.js"]
        });
    } catch (err) {
        console.debug(`Background: ショートカット用 content.js 事前注入スキップ (${source}):`, err.message);
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
            if (chrome.runtime.lastError || !tabs || tabs.length === 0) return;
            handleShortcutRequest(tabs[0].id, "commands.onCommand");
        });
    }
});

// 再生状態通知（PLAYBACK_*）の宛先タブ。GENERATE_VOICE を要求したタブの id を記録し、
// offscreen から届く再生状態を「全アクティブタブ」ではなく要求元タブにのみ転送する。
// これにより、別ウィンドウ/別タブのアイコンUIが他タブの再生状態で誤更新される問題を防ぐ。
//
// Service Worker は無操作 30 秒程度で停止するため、メモリ上の変数だけで保持すると
// 長文の再生中にワーカーが停止した時点で宛先を見失い、再生終了通知が届かず
// アイコンが「再生中」のまま固まる。chrome.storage.session に併せて保存して復元する。
let playbackTabId = null;
let playbackTabIdLoaded = false;

async function getPlaybackTabId() {
    if (playbackTabIdLoaded) return playbackTabId;
    try {
        const stored = await chrome.storage.session.get("playbackTabId");
        playbackTabId = Number.isInteger(stored.playbackTabId) ? stored.playbackTabId : null;
    } catch (err) {
        playbackTabId = null;
    }
    playbackTabIdLoaded = true;
    return playbackTabId;
}

function setPlaybackTabId(tabId) {
    playbackTabId = Number.isInteger(tabId) ? tabId : null;
    playbackTabIdLoaded = true;
    const write = playbackTabId == null
        ? chrome.storage.session.remove("playbackTabId")
        : chrome.storage.session.set({ playbackTabId });
    write.catch(warn("再生宛先タブの保存失敗"));
}

// 読み上げを要求したタブが閉じられた場合、再生を止める。
// 停止しないと、操作対象のUIが失われたまま音声だけが鳴り続ける（止める手段がない）。
chrome.tabs.onRemoved.addListener(async (tabId) => {
    lastShortcut.delete(tabId);
    if (await getPlaybackTabId() === tabId) {
        setPlaybackTabId(null);
        stopPlayback();
    }
});

// 読み上げを要求したタブが別ページへ遷移した場合も同様に停止する。
// 遷移後の content.js は isPlaying=false で起動するため、
// 停止しないとアイコンからは止められない音声が残ってしまう。
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') return;
    if (await getPlaybackTabId() !== tabId) return;
    setPlaybackTabId(null);
    stopPlayback();
});

// --- Offscreen Document 管理 ---
let offscreenCreating = null;

async function hasOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
}

async function setupOffscreen() {
    try {
        if (await hasOffscreenDocument()) return;

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

// 再生の停止要求。Offscreen Document が存在しない＝再生していない状態なので、
// 停止のためだけに Offscreen Document を新規生成しない。
async function stopPlayback() {
    try {
        if (!(await hasOffscreenDocument())) return;
        await sendToOffscreen({ type: 'STOP_AUDIO' });
    } catch (err) {
        console.warn("Background: 再生停止メッセージ送信失敗:", err.message);
    }
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
            fetchVoicevox("/version")
                .then(res => sendResponse({ success: res.ok }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case "GET_SPEAKERS":
            fetchVoicevox("/speakers")
                .then(res => {
                    if (!res.ok) throw new Error(`Speakers取得失敗(${res.status})`);
                    return res.json();
                })
                .then(speakers => sendResponse({ success: true, speakers }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case "GENERATE_VOICE":
            // 要求元タブを再生状態通知の宛先として記録する。
            // ショートカット/コンテキストメニュー経由でも content.js から送信されるため
            // sender.tab.id で正しい要求元タブが取得できる。
            switchPlaybackTab(sender.tab?.id ?? null)
                .then(() => handleGenerateVoice(request.text, sendResponse))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case "STOP_ALL":
            stopPlayback();
            sendResponse({ success: true });
            return false;

        case "PLAYBACK_STARTED":
        case "PLAYBACK_ENDED":
        case "PLAYBACK_ERROR":
        case "PLAYBACK_STOPPED":
            // 再生を要求したタブにのみ転送する。全アクティブタブへ配信すると、
            // 別ウィンドウのアクティブタブのUIまで誤って更新されてしまう。
            forwardPlaybackState(request);
            return false;
    }

    return false;
});

// 新しい再生要求元へ宛先を切り替える。別タブからの要求なら、前の再生タブへ
// 明示的に停止を通知してからにする（前タブのアイコンが「再生中」で取り残されるのを防ぐ）。
async function switchPlaybackTab(requestTabId) {
    if (requestTabId == null) return;

    const previousTabId = await getPlaybackTabId();
    if (previousTabId != null && previousTabId !== requestTabId) {
        chrome.tabs.sendMessage(previousTabId, { type: "PLAYBACK_STOPPED" })
            .catch(warn("旧再生タブへの停止通知失敗"));
    }
    setPlaybackTabId(requestTabId);
}

async function forwardPlaybackState(request) {
    const tabId = await getPlaybackTabId();
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, request).catch(warn("再生状態の転送失敗"));
}

// VOICEVOXエンジンへの fetch。エンジン未起動時に応答待ちで固まらないよう
// タイムアウトを設ける。
async function fetchVoicevox(path, init = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(`${VOICEVOX_BASE_URL}${path}`, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// chrome.storage.local に不正な値（旧バージョンの残骸・手動編集など）が入っていても
// VOICEVOX へ NaN を送らないよう、数値として妥当な値のみ採用する。
function normalizeSettings(raw) {
    const settings = {};
    for (const [key, defaultValue] of Object.entries(SETTING_DEFAULTS)) {
        const stored = raw?.[key];
        // null / undefined / 空文字は Number() で 0 になってしまうため、未設定として扱う
        if (stored == null || stored === "") {
            settings[key] = defaultValue;
            continue;
        }
        const value = Number(stored);
        settings[key] = Number.isFinite(value) ? value : defaultValue;
    }
    return settings;
}

async function handleGenerateVoice(text, sendResponse) {
    try {
        const stored = await chrome.storage.local.get(Object.keys(SETTING_DEFAULTS));
        const settings = normalizeSettings(stored);
        const chunks = splitText(typeof text === "string" ? text.slice(0, MAX_TEXT_LENGTH) : "");

        if (chunks.length === 0) {
            sendResponse({ success: false, error: "読み上げるテキストがありません" });
            return;
        }

        await setupOffscreen();
        // Offscreen への配信完了を確認してから成功応答を返す（無音失敗の可視化）
        await sendToOffscreen({ type: 'STOP_AUDIO' });

        // 全チャンクを1回で渡す。1文ずつ送ると、先頭チャンクの再生が
        // 後続チャンクの登録より早く終わった場合に PLAYBACK_ENDED が
        // 早期発火し、読み上げ途中でアイコンが待機状態に戻ってしまう。
        await sendToOffscreen({
            type: 'ENQUEUE_TEXTS',
            texts: chunks,
            settings
        });
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
    if (!chunks) return [];

    const result = chunks.map(s => s.trim()).filter(Boolean);
    if (result.length > 0) return result;

    const fallback = text.trim();
    return fallback ? [fallback] : [];
}
