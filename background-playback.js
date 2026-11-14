// Offscreen に渡した読み上げの宛先と要求ID。SW休止後に届く通知も同じ要求へ戻す。
let playbackOwner;
let playbackOwnerLoading;

function getPlaybackOwner() {
    if (playbackOwner !== undefined) return Promise.resolve(playbackOwner);
    playbackOwnerLoading ??= chrome.storage.session.get(PLAYBACK_TAB_STORAGE_KEY)
        .then(stored => {
            const saved = stored[PLAYBACK_TAB_STORAGE_KEY];
            // 以前のバージョンから残ったタブIDにも終了通知を返せるようにする。
            playbackOwner = Number.isInteger(saved) ? { tabId: saved } : saved ?? null;
            return playbackOwner;
        }, () => playbackOwner = null);
    return playbackOwnerLoading;
}

async function setPlaybackOwner(owner) {
    playbackOwner = owner;
    try {
        if (owner) {
            await chrome.storage.session.set({ [PLAYBACK_TAB_STORAGE_KEY]: owner });
        } else {
            await chrome.storage.session.remove(PLAYBACK_TAB_STORAGE_KEY);
        }
    } catch (error) {
        console.warn("Background: 再生タブ状態の保存に失敗:", error.message);
    }
}

// 停止のために Offscreen を新規作成しない。存在確認の失敗は停止結果に反映する。
async function stopOffscreenAudioIfPresent() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length === 0) return;
    try {
        await sendToOffscreen({ type: "STOP_AUDIO" });
    } catch (error) {
        // 停止応答の前に文書自体が破棄された場合は、音源も通信も文書とともに終了する。
        const remaining = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
        if (remaining.some(context => context.documentId === contexts[0].documentId)) throw error;
    }
}

function stopPlaybackForTab(tabId, documentId) {
    // 遷移したタブの準備だけを取り消す。停止の照合は直列キューでも行うため、
    // 先にキューへ入った別タブの音声を巻き込まない。
    if (!pendingVoiceStarts.has(tabId) && playbackOwner !== undefined && playbackOwner?.tabId !== tabId) return;
    return queueVoiceStop(tabId, { navigating: true, documentId }).catch(() => {});
}

// タブが閉じられたら、保持している状態（再生宛先・ショートカット重複抑制・OCR要求）を
// 掃除する。読み上げ中のタブを閉じた場合は音声も止める（閉じたタブには停止する
// 手段が残らないため、鳴りっぱなしを防ぐ）。
chrome.tabs.onRemoved.addListener((tabId) => {
    lastShortcut.delete(tabId);
    latestOcrRequestByTab.delete(tabId);
    stopPlaybackForTab(tabId);
});

// loading だけでは iframe の遷移も拾う。メイン文書の再読み込みは
// Content Script / capture.html の pagehide で検出する。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading" || changeInfo.url === undefined) return;
    stopPlaybackForTab(tabId);
});

// pagehide のメッセージは再読み込みで応答ポートごと消えることがある。
// 新しいメイン文書の初期化時にも、古い文書の要求だけを終了する。
async function stopPlaybackFromPreviousDocument(tabId, documentId) {
    const pending = pendingVoiceStarts.get(tabId);
    const owner = await getPlaybackOwner();
    const oldDocument = pending?.documentId || (owner?.tabId === tabId ? owner.documentId : null);
    if (!oldDocument || oldDocument === documentId) return;
    // 遅れて届いた旧文書の READY が、新しい文書の音声を止めないようにする。
    const frames = await chrome.scripting.executeScript({
        target: { tabId, documentIds: [documentId] }, func: () => true
    }).catch(() => []);
    const [frame] = frames;
    if (frame?.frameId === 0 && frame.documentId === documentId) await stopPlaybackForTab(tabId, oldDocument);
}

// --- Offscreen Document 管理 ---
let offscreenCreating = null;

// 文字認識エンジンの先読み。範囲選択中に offscreen を用意してワーカーを起こしておく。
// エンジンの初期化（同梱の日本語学習データとWASMの読み込み）は初回だけ数秒かかるため、
// 利用者がドラッグしている間に済ませてしまう。失敗しても本来の経路で作り直される。
async function prewarmOcr() {
    try {
        await setupOffscreen();
        await sendToOffscreen({ type: "PREWARM_OCR" });
    } catch (err) {
        // 先読みは best-effort。失敗しても本来の認識には影響しない
    }
}

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
            reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
            justification: 'ページに依存しない音声再生と、画面OCR読み上げの文字認識ワーカー実行のため'
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
async function sendToOffscreen(message) {
    const response = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    if (!response || response.success !== true) {
        throw new Error(response?.error || "Offscreen ドキュメントから応答がありません");
    }
    return response;
}

// 警告ログを出力するヘルパー（.catch() 用）
function warn(context) {
    return (err) => console.warn(`Background: ${context}:`, err.message);
}
