importScripts('constants.js');

// 画面OCR読み上げのコンテキストメニューID
const OCR_MENU_ID = "capture-ocr-read";

// タブへ動的注入するコンテンツスクリプト。manifest の content_scripts と同じ並びにする
// （dom-text.js が先。content.js が globalThis.VVRadioDomText を参照するため）。
const CONTENT_SCRIPT_FILES = ["dom-text.js", "content.js"];

/**
 * 指定した対象へコンテンツスクリプトを注入する。
 * content.js は IIFE ガードを持つため、既に動いているタブへの再注入も安全。
 * @param {chrome.scripting.InjectionTarget} target
 */
function injectContentScripts(target) {
    return chrome.scripting.executeScript({ target, files: CONTENT_SCRIPT_FILES });
}

/**
 * 非同期処理の結果を sendResponse へ返す定型。
 * 失敗時の応答の形（{success:false, error}）を1か所に揃え、
 * 例外が握り潰されて「応答が返らないまま固まる」のを防ぐ。
 * @param {Promise<any>} promise
 * @param {(response: object) => void} sendResponse
 * @param {(value: any) => object} [toResponse] 成功時の応答を作る（既定は {success:true}）
 */
function respondWith(promise, sendResponse, toResponse) {
    promise
        .then((value) => sendResponse(toResponse ? toResponse(value) : { success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
}

/**
 * タブへ通知を送る。target:"tab" はタブ宛て転送の目印
 * （capture.html はこれが無いと offscreen のブロードキャストと区別できず二重処理になる）。
 * @param {number|null|undefined} tabId
 * @param {object} message
 * @param {string} [context] 指定すると失敗を警告ログに出す
 */
function notifyTab(tabId, message, context) {
    if (tabId == null) return;
    const sending = chrome.tabs.sendMessage(tabId, { ...message, target: "tab" });
    sending.catch(context ? warn(context) : () => {});
}

// 拡張機能のインストール／更新時にコンテキストメニューを作成する。
// onInstalled は更新時にも発火し、既存メニューが残っていることがある。
// 同一 id の create は "Cannot create item with duplicate id" で失敗するため、
// 必ず removeAll してから作り直す（更新後にメニューが消える不具合の原因）。
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        // コールバック内で lastError を読まないと未処理エラーになる
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
        // 選択できない文字（画像・PDF・Canvas等）向けのOCR読み上げ入口。
        // PDFビューア等では表示されない場合があるため、ショートカットとツールバー
        // アイコンのクリックからも同じ機能を起動できるようにしている。
        chrome.contextMenus.create({
            id: OCR_MENU_ID,
            title: "画面をキャプチャしてOCR読み上げ（画像・PDF向け）",
            contexts: ["page", "image", "video", "frame"]
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn("Background: OCRメニュー作成失敗:", chrome.runtime.lastError.message);
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
    if (info.menuItemId === OCR_MENU_ID && tab?.id != null) {
        startCaptureOcr(tab);
    }
});

// --- 画面キャプチャOCR読み上げ ---

// storage.session の既定クォータ（10MB）に収めるための dataURL 長の上限目安。
// PNG がこれを超える高解像度画面では JPEG への再エンコード（必要なら縮小）を行う。
const CAPTURE_MAX_DATAURL_LENGTH = 8 * 1024 * 1024;

// ツールバーアイコンのクリックでもOCR読み上げを起動する（PDFビューア等、
// コンテキストメニューやショートカットが使えない場合の確実な入口）。
chrome.action.onClicked.addListener((tab) => {
    startCaptureOcr(tab);
});

// OCR読み上げを開始する。
// 通常のWebページ: 閲覧中のページの上にオーバーレイを出してその場で範囲選択させる
// （ページの表示・サイズを一切変えないため。選択後は CAPTURE_OCR_REGION が届く）。
// content script を注入できないページ（PDFビューア・chrome:// 等）:
// 従来どおり capture.html タブでの範囲選択にフォールバックする。
async function startCaptureOcr(tab) {
    if (!tab || tab.id == null) return;

    try {
        // フォールバックの判断材料はここ（注入可否）だけに限る。
        // 後続の sendMessage の失敗でタブ方式へ落とすと、オーバーレイが出ているのに
        // capture.html も開いてUIが二重に立ち上がる。
        await injectContentScripts({ tabId: tab.id });
    } catch (err) {
        // 注入不可ページ（PDFビューア・chrome:// 等）→ タブ方式へフォールバック
        startCaptureOcrInTab(tab);
        return;
    }

    try {
        await chrome.tabs.sendMessage(tab.id, { type: "START_OCR_SELECTION" }, { frameId: 0 });
    } catch (err) {
        // 注入は成功しているのでオーバーレイは出ている見込み。ここでの失敗は
        // 応答チャネルの都合であることが多く、フォールバックの根拠にはしない。
        console.warn("Background: OCR範囲選択の開始通知に失敗:", err.message);
    }
    // 範囲をドラッグしている数秒の間に、文字認識エンジン（同梱の辞書とWASM）を
    // 先に読み込ませておく。初回だけ発生する待ち時間を利用者に見せないため。
    // 失敗しても本来の経路で改めて生成されるので無視してよい。
    prewarmOcr();
}

// フォールバック: タブをキャプチャし、範囲選択・OCR用の capture.html を開く。
// 画像データは storage.session 経由で受け渡す（Service Worker の休止に耐えるため）。
// 固定キーへの上書き保存なので並行実行しても last-write-wins となり、
// 追い越された側のタブは captureId の不一致で明示的なエラーを表示できる。
async function startCaptureOcrInTab(tab) {
    try {
        let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        if (dataUrl.length > CAPTURE_MAX_DATAURL_LENGTH) {
            // captureVisibleTab は毎秒の呼び出し回数制限があるため再キャプチャはせず、
            // 取得済みのPNGをJPEGへ再エンコードしてクォータに収める
            dataUrl = await reencodeCaptureAsJpeg(dataUrl);
        }

        const captureId = String(Date.now());
        await chrome.storage.session.set({
            [CAPTURE_STORAGE_KEY]: {
                captureId,
                dataUrl,
                sourceTitle: tab.title ?? "",
                sourceUrl: tab.url ?? ""
            }
        });

        await chrome.tabs.create({
            url: chrome.runtime.getURL(`capture.html?cid=${captureId}`),
            index: tab.index + 1
        });
    } catch (err) {
        // chrome:// ページ等のキャプチャ不可画面ではここに到達する。
        // ページ内にUIを出せない場面もあるため、ツールバーバッジで簡易通知する。
        console.warn("Background: 画面キャプチャに失敗:", err.message);
        flashActionBadge("ERR", "このページは画面をキャプチャできません（Chromeの設定画面・ウェブストア等）");
    }
}

// ページ内オーバーレイで選択された範囲をキャプチャし、offscreen にOCRを依頼する。
// OCRの完了は offscreen からの OCR_COMPLETE メッセージで受け取り（イベント駆動）、
// メッセージ応答チャネルを長時間保持しない（Service Worker の休止対策）。
async function captureAndRecognizeRegion(request, tab) {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await setupOffscreen();
    // offscreen ドキュメントは chrome.storage を参照できないため、
    // ルビ除去設定はここで読み取ってメッセージに載せて渡す。
    const { ocrRemoveRuby } = await chrome.storage.local.get(OCR_SETTING_DEFAULTS);
    await sendToOffscreen({
        type: "OCR_RECOGNIZE",
        dataUrl,
        rect: request.rect,
        viewportWidth: request.viewportWidth,
        tabId: tab.id,
        removeRuby: ocrRemoveRuby === true
    });
}

// PNGのdataURLをJPEG（品質92%）へ再エンコードする。
// それでも上限を超える超高解像度画面では、収まる見込みの倍率まで縮小して再試行する。
async function reencodeCaptureAsJpeg(pngDataUrl) {
    const blob = await (await fetch(pngDataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
        let dataUrl = await drawToJpegDataUrl(bitmap, 1);
        if (dataUrl.length > CAPTURE_MAX_DATAURL_LENGTH) {
            const scale = Math.sqrt(CAPTURE_MAX_DATAURL_LENGTH / dataUrl.length) * 0.9;
            dataUrl = await drawToJpegDataUrl(bitmap, scale);
        }
        return dataUrl;
    } finally {
        bitmap.close();
    }
}

async function drawToJpegDataUrl(bitmap, scale) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    return blobToDataUrl(jpegBlob);
}

// Service Worker には FileReader が無いため、手動で dataURL 化する
async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const CHUNK_SIZE = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
}

// ツールバーアイコンのバッジを一時表示する（キャプチャ不可ページ等のエラー通知）。
// 短時間に連続失敗しても前回のクリアタイマーが表示中のバッジを早消ししないようにする。
let badgeClearTimer = null;
// manifest.json の action.default_title と同一。エラー通知後に戻すため保持する。
const ACTION_DEFAULT_TITLE = "画面をキャプチャしてOCR読み上げ（画像・PDF向け）";
// ページ内にUIを出せない画面（chrome:// 等）での唯一の通知手段。
// バッジは3文字程度しか出せないため、理由は必ずツールチップにも入れる。
function flashActionBadge(text, title) {
    chrome.action.setBadgeBackgroundColor({ color: "#e01e5a" });
    chrome.action.setBadgeText({ text });
    if (title) chrome.action.setTitle({ title: `${ACTION_DEFAULT_TITLE}\n${title}` });
    if (badgeClearTimer) clearTimeout(badgeClearTimer);
    badgeClearTimer = setTimeout(() => {
        badgeClearTimer = null;
        chrome.action.setBadgeText({ text: "" });
        chrome.action.setTitle({ title: ACTION_DEFAULT_TITLE });
    }, 3000);
}

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
            await injectContentScripts(injectionTarget);
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
        await injectContentScripts({ tabId, allFrames: true });
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
    if (command !== "toggle-reading" && command !== "capture-ocr-reading") return;
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (chrome.runtime.lastError) {
            console.warn("Background: アクティブタブの取得に失敗:", chrome.runtime.lastError.message);
            return;
        }
        if (!tabs || tabs.length === 0) return;
        if (command === "toggle-reading") {
            handleShortcutRequest(tabs[0].id, "commands.onCommand");
        } else {
            startCaptureOcr(tabs[0]);
        }
    });
});

// 再生状態通知（PLAYBACK_*）の宛先タブ。GENERATE_VOICE を要求したタブの id を記録し、
// offscreen から届く再生状態を「全アクティブタブ」ではなく要求元タブにのみ転送する。
// これにより、別ウィンドウ/別タブのアイコンUIが他タブの再生状態で誤更新される問題を防ぐ。
// Service Worker はメモリ上のこの変数を休止で失うため、storage.session にも退避する。
// 句点の無い長文（画像OCRの結果等）は1つの長い音声になり、その再生中は SW への
// 通信が無く約30秒で SW が休止し得る。休止から復帰した SW でも宛先を復元できないと
// 再生終了通知（PLAYBACK_ENDED）を取りこぼし、インジケーターが点灯したまま固着する。
let playbackTabId = null;

// 宛先タブIDを更新し、storage.session にも反映する（null はクリア）。
function setPlaybackTabId(tabId) {
    playbackTabId = tabId;
    if (tabId == null) {
        chrome.storage.session.remove(PLAYBACK_TAB_STORAGE_KEY).catch(() => {});
    } else {
        chrome.storage.session.set({ [PLAYBACK_TAB_STORAGE_KEY]: tabId }).catch(() => {});
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
function switchPlaybackTabTo(tabId) {
    if (tabId == null) return;
    getPlaybackTabId().then((prev) => {
        if (prev != null && prev !== tabId) {
            notifyTab(prev, { type: "PLAYBACK_STOPPED" }, "旧再生タブへの停止通知失敗");
        }
        setPlaybackTabId(tabId);
    });
}

// タブが閉じられたら、保持している状態（再生宛先・ショートカット重複抑制）を掃除する。
chrome.tabs.onRemoved.addListener(async (tabId) => {
    lastShortcut.delete(tabId);
    if (await getPlaybackTabId() === tabId) {
        setPlaybackTabId(null);
    }
});

// 再生中のタブが別ページへ遷移／リロードされたら、音声が鳴りっぱなしになるのを防ぐため
// 再生を停止する。宛先を先にクリアするので、offscreen が返す PLAYBACK_STOPPED は
// 転送先が無くなり、遷移先の新しいページのインジケーターを誤って点灯させない。
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== "loading") return;
    if (await getPlaybackTabId() !== tabId) return;
    setPlaybackTabId(null);
    try {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
        if (contexts.length > 0) {
            sendToOffscreen({ type: "STOP_AUDIO" }).catch(() => {});
        }
    } catch (e) {
        // getContexts 失敗時は何もしない（再生中でなければ実害なし）
    }
});

// --- Offscreen Document 管理 ---
let offscreenCreating = null;

// 文字認識エンジンの先読み。範囲選択中に offscreen を用意してワーカーを起こしておく。
// エンジンの初期化（同梱の辞書14MBとWASMの読み込み）は初回だけ数秒かかるため、
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
            justification: '音声再生によるアクセシビリティ向上（CSP制限サイト回避）と、画面OCR読み上げの文字認識ワーカー実行のため'
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
    // target:'background' は offscreen ドキュメントからの通知（PLAYBACK_* / OCR_*）に限る。
    // 送信元が offscreen.html であることを確認し、他コンテキストからの偽装を排除する（多層防御）。
    // content script/拡張ページからの要求は target を付けず、sender.tab で正しく扱っている。
    if (request.target === 'background'
        && sender.url !== chrome.runtime.getURL('offscreen.html')) {
        return;
    }

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
            respondWith(
                fetchWithTimeout(`${VOICEVOX_BASE_URL}/version`, {}, VOICEVOX_FETCH_TIMEOUT_MS),
                sendResponse,
                (res) => ({ success: res.ok }));
            return true;

        case "GET_SPEAKERS":
            respondWith(
                fetchWithTimeout(`${VOICEVOX_BASE_URL}/speakers`, {}, VOICEVOX_FETCH_TIMEOUT_MS)
                    .then((res) => res.json()),
                sendResponse,
                (speakers) => ({ success: true, speakers }));
            return true;

        case "GET_SPEAKER_ICON":
            // 設定画面のページ内アイコン表示用。VOICEVOXエンジンは拡張機能の
            // オリジンからしか叩けないため、取得は background に集約する。
            respondWith(
                fetchSpeakerIcon(request.speakerId),
                sendResponse,
                (result) => ({ success: true, ...result }));
            return true;

        case "GENERATE_VOICE":
            // 要求元タブを再生状態通知の宛先として記録する。
            // ショートカット/コンテキストメニュー経由でも content.js から送信されるため
            // sender.tab.id で正しい要求元タブが取得できる。
            switchPlaybackTabTo(sender.tab?.id ?? null);
            handleGenerateVoice(request.text, sendResponse);
            return true;

        case "STOP_ALL":
            setupOffscreen()
                .then(() => sendToOffscreen({ type: 'STOP_AUDIO' }))
                .catch(warn("再生停止メッセージ送信失敗"));
            sendResponse({ success: true });
            return false;

        case "CAPTURE_OCR_REGION": {
            // ページ内オーバーレイで選択された範囲のキャプチャ→OCR開始要求
            const tab = sender.tab;
            if (!tab || tab.id == null) {
                sendResponse({ success: false, error: "要求元タブを特定できません" });
                return false;
            }
            captureAndRecognizeRegion(request, tab)
                .then(() => sendResponse({ success: true }))
                .catch((err) => {
                    console.warn("Background: 範囲OCRの開始に失敗:", err.message);
                    // captureVisibleTab には毎秒の呼び出し回数制限がある。連続実行で踏んだ場合は
                    // 生のエラー文言だと利用者が対処できないため、原因の分かる案内に差し替える。
                    const message = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(err.message)
                        ? "短い間隔で連続して実行されました。少し待ってからもう一度お試しください。"
                        : err.message;
                    sendResponse({ success: false, error: message });
                });
            return true;
        }

        case "OCR_PROGRESS":
            // offscreen からのOCR進行状況を要求元タブへ転送する
            notifyTab(request.tabId, { type: "OCR_PROGRESS", progress: request.progress });
            return false;

        case "OCR_COMPLETE": {
            // offscreen でのOCR完了。認識テキストを既存の読み上げパイプラインへ流す。
            const tabId = request.tabId ?? null;
            if (request.error || !request.text) {
                notifyTab(tabId, {
                    type: "OCR_STATUS",
                    status: "error",
                    message: request.error || "文字を認識できませんでした。"
                }, "OCRエラー通知の送信失敗");
                return false;
            }
            // GENERATE_VOICE と同様に、再生状態通知の宛先を要求元タブへ切り替える
            switchPlaybackTabTo(tabId);
            notifyTab(tabId, { type: "OCR_STATUS", status: "done" });
            // 読み上げ準備の失敗（offscreen 生成不可等）も要求元タブへ通知する。
            // VOICEVOX への接続失敗は合成時に PLAYBACK_ERROR として別途届く。
            handleGenerateVoice(request.text, (res) => {
                if (res && res.success === false) {
                    notifyTab(tabId, {
                        type: "OCR_STATUS",
                        status: "error",
                        message: `読み上げを開始できませんでした: ${res.error}`
                    }, "読み上げ開始エラー通知の送信失敗");
                }
            });
            return false;
        }

        case "PLAYBACK_STARTED":
        case "PLAYBACK_ENDED":
        case "PLAYBACK_ERROR":
        case "PLAYBACK_STOPPED":
            // 再生を要求したタブにのみ転送する。全アクティブタブへ配信すると、
            // 別ウィンドウのアクティブタブのUIまで誤って更新されてしまう。
            // target を 'tab' に付け替えるのは、拡張機能ページ（capture.html）が
            // offscreen からの全体ブロードキャスト（target:'background'）と
            // このタブ宛て転送を区別して二重処理を防げるようにするため。
            // SW休止から復帰した直後はメモリ上の宛先が失われているため、
            // storage.session から復元してから転送する（getPlaybackTabId）。
            getPlaybackTabId().then((tabId) => notifyTab(tabId, request, "再生状態の転送失敗"));
            return false;
    }

    return false;
});

async function handleGenerateVoice(text, sendResponse) {
    try {
        // 設定の読み出しも try の内側に入れる。ここで例外が出ると応答が返らず、
        // 要求元は「無反応」のまま待たされてしまう。
        const result = await chrome.storage.local.get(Object.keys(SETTING_DEFAULTS));
        const settings = { ...SETTING_DEFAULTS, ...result };
        const chunks = splitText(text);

        await setupOffscreen();
        // Offscreen への配信完了を確認してから成功応答を返す（無音失敗の可視化）
        await sendToOffscreen({ type: 'STOP_AUDIO' });

        // 1文ずつ送ると、短い文では先頭の再生完了時にキューが空になり
        // 読み上げ終了が早すぎるタイミングで通知される。まとめて渡す。
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
 * スタイルID（speakerId）から、キャラクター名とアイコン画像を取得する。
 *
 * 画像は拡張機能に同梱せず、利用者自身のPCで動いている VOICEVOX エンジンから
 * その都度取得する（VOICEVOX本体の規約が禁じる「再配布」を避けるため）。
 * 取得した画像は利用者のブラウザ内にとどまり、外部へ送信されることはない。
 *
 * エンジンが起動していない場合は例外になるが、呼び出し側（options.js）は
 * 名前だけの表示にフォールバックできるため、致命的ではない。
 *
 * @returns {Promise<{name: string, icon: string|null}>} icon は base64（データURL接頭辞なし）
 */
async function fetchSpeakerIcon(speakerId) {
    const id = Number(speakerId);
    if (!Number.isInteger(id)) throw new Error("speakerId が不正です");

    const speakersRes = await fetchWithTimeout(
        `${VOICEVOX_BASE_URL}/speakers`, {}, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!speakersRes.ok) throw new Error(`キャラクター一覧の取得に失敗しました (${speakersRes.status})`);
    const speakers = await speakersRes.json();

    const speaker = speakers.find(s => (s.styles || []).some(st => st.id === id));
    if (!speaker) throw new Error("選択中のキャラクターが見つかりません");

    // speaker_uuid が無いエンジンでも名前だけは返し、文字表示にフォールバックさせる。
    if (!speaker.speaker_uuid) return { name: speaker.name, icon: null };

    const infoRes = await fetchWithTimeout(
        `${VOICEVOX_BASE_URL}/speaker_info?speaker_uuid=${encodeURIComponent(speaker.speaker_uuid)}`,
        {}, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!infoRes.ok) return { name: speaker.name, icon: null };
    const info = await infoRes.json();

    // スタイルごとにアイコンが違うため、選択中のスタイルのものを優先する。
    const styleInfos = info.style_infos || [];
    const matched = styleInfos.find(si => si.id === id) || styleInfos[0];
    return { name: speaker.name, icon: matched?.icon || null };
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
