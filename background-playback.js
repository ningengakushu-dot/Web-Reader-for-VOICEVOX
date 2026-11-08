// 再生状態通知（PLAYBACK_*）の宛先タブ。GENERATE_VOICE を要求したタブの id を記録し、
// offscreen から届く再生状態を「全アクティブタブ」ではなく要求元タブにのみ転送する。
// これにより、別ウィンドウ/別タブのアイコンUIが他タブの再生状態で誤更新される問題を防ぐ。
// Service Worker はメモリ上のこの変数を休止で失うため、storage.session にも退避する。
// 句点の無い長文（画像OCRの結果等）は1つの長い音声になり、その再生中は SW への
// 通信が無く約30秒で SW が休止し得る。休止から復帰した SW でも宛先を復元できないと
// 再生終了通知（PLAYBACK_ENDED）を取りこぼし、インジケーターが点灯したまま固着する。
let playbackTabId = null;

// 宛先タブIDを更新し、storage.session にも反映する（null はクリア）。
async function setPlaybackTabId(tabId) {
    playbackTabId = tabId;
    try {
        if (tabId == null) {
            await chrome.storage.session.remove(PLAYBACK_TAB_STORAGE_KEY);
        } else {
            await chrome.storage.session.set({ [PLAYBACK_TAB_STORAGE_KEY]: tabId });
        }
    } catch (error) {
        // メモリ上の宛先は維持し、同じService Workerの生存中は通知を継続する。
        console.warn("Background: 再生タブ状態の保存に失敗:", error.message);
    }
}

// 宛先タブIDを取得する。メモリ上の値が失われている（SW休止からの復帰直後）場合は
// storage.session から読み直してメモリへ復元する。
async function getPlaybackTabId() {
    if (playbackTabId != null) return playbackTabId;
    try {
        const stored = await chrome.storage.session.get(PLAYBACK_TAB_STORAGE_KEY);
        const tabId = stored[PLAYBACK_TAB_STORAGE_KEY];
        if (tabId != null) playbackTabId = tabId;
    } catch (e) {
        // session 参照に失敗しても従来どおりメモリ値で続行する
    }
    return playbackTabId;
}

/**
 * 再生状態通知の宛先を指定タブへ移す。
 * 前の宛先タブには停止を通知し、そのタブのアイコンが「再生中」のまま
 * 取り残されるのを防ぐ（GENERATE_VOICE と OCR_COMPLETE の共通処理）。
 * @param {number|null} tabId
 */
async function switchPlaybackTabTo(tabId) {
    if (tabId == null) return;
    const prev = await getPlaybackTabId();
    if (prev != null && prev !== tabId) {
        notifyTab(prev, { type: "PLAYBACK_STOPPED" }, "旧再生タブへの停止通知失敗");
    }
    await setPlaybackTabId(tabId);
}

// offscreen ドキュメントが存在するときだけ再生停止を送る。
// 存在しなければ再生中でもないので、停止のためだけに生成しない（生成すると
// 以後ブラウザ終了まで常駐し、SW休止によるメモリ削減効果を打ち消す）。
// GENERATE_VOICE の「STOP_AUDIO → ENQUEUE_TEXTS」の間に割り込むと積んだ直後の
// キューが消えて無音になるため、必ず同じ直列キューを通す。
async function stopOffscreenAudioIfPresent() {
    let contexts = [];
    try {
        contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    } catch (e) {
        // 存在確認ができないときは何もしない（再生中でなければ実害なし）
        return;
    }
    if (contexts.length > 0) await sendToOffscreen({ type: "STOP_AUDIO" });
}

// 指定タブが再生宛先のままなら、宛先を外して再生を止める（タブ終了・遷移用）。
// 宛先の照合も直列キューの内側で行う: 別タブの読み上げ開始（switchPlaybackTabTo）が
// 先にキューへ入っていた場合、その完了後に照合すれば宛先は既に別タブなので、
// 始まったばかりの読み上げを誤って止めない。
async function stopPlaybackForTab(tabId) {
    // 事前確認: 再生に無関係なタブの読み込みで直列キューを塞がない
    if (await getPlaybackTabId() !== tabId) return;
    return enqueueVoiceOperation(async () => {
        if (await getPlaybackTabId() !== tabId) return;
        // 宛先を先にクリアするので、offscreen が返す PLAYBACK_STOPPED は転送先が
        // 無くなり、遷移先の新しいページのインジケーターを誤って点灯させない。
        await setPlaybackTabId(null);
        try {
            await stopOffscreenAudioIfPresent();
        } catch (e) {
            // 送信失敗は無視（offscreen が消えていれば再生も止まっている）
        }
    });
}

// タブが閉じられたら、保持している状態（再生宛先・ショートカット重複抑制・OCR要求）を
// 掃除する。読み上げ中のタブを閉じた場合は音声も止める（閉じたタブには停止する
// 手段が残らないため、鳴りっぱなしを防ぐ）。
chrome.tabs.onRemoved.addListener((tabId) => {
    lastShortcut.delete(tabId);
    latestOcrRequestByTab.delete(tabId);
    stopPlaybackForTab(tabId);
});

// 再生中のタブが別ページへ遷移／リロードされたら、音声が鳴りっぱなしになるのを防ぐため
// 再生を停止する。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading") return;
    stopPlaybackForTab(tabId);
});

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
