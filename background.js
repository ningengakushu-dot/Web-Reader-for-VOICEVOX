importScripts('constants.js');

// 画面OCR読み上げのコンテキストメニューID
const OCR_MENU_ID = "capture-ocr-read";

// タブへ動的注入するコンテンツスクリプト。manifest の content_scripts と同じ並びにする
// （dom-text.js が先。content.js が globalThis.VVRadioDomText を参照するため）。
const CONTENT_SCRIPT_FILES = ["content-guard.js", "dom-text.js", "content.js"];

/**
 * 指定した対象へコンテンツスクリプトを注入する。
 * content.js は IIFE ガードを持つため、既に動いているタブへの再注入も安全。
 * @param {chrome.scripting.InjectionTarget} target
 */
function injectContentScripts(target) {
    return chrome.scripting.executeScript({ target, files: CONTENT_SCRIPT_FILES });
}

// 更新前から開かれているタブは古い content script を保持するため、更新完了時に
// 現在の一式を再注入する。注入不可ページは個別に失敗させ、他のタブは継続する。
function reinjectContentScriptsAfterUpdate() {
    chrome.tabs.query({}).then((tabs) => Promise.allSettled(
        tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) =>
            injectContentScripts({ tabId: tab.id, allFrames: true })
        )
    )).catch(() => {});
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

// この版より前から更新した利用者にだけ、機能追加のお知らせを表示する。
// 以降のバグ修正版へ更新するたびに同じお知らせが再表示されるのを防ぐ。
const UPDATE_NOTICE_INTRODUCED_VERSION = "1.4.3";
function isVersionBefore(version, target) {
    const parse = (value) => String(value || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const a = parse(version);
    const b = parse(target);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff < 0;
    }
    return false;
}

// 拡張機能のインストール／更新時にコンテキストメニューを作成する。
// onInstalled は更新時にも発火し、既存メニューが残っていることがある。
// 同一 id の create は "Cannot create item with duplicate id" で失敗するため、
// 必ず removeAll してから作り直す（更新後にメニューが消える不具合の原因）。
chrome.runtime.onInstalled.addListener((details) => {
    // 廃止したルビ優先読み設定を既存ユーザーのローカルストレージから削除する。
    chrome.storage.local.remove("ocrRemoveRuby", () => { void chrome.runtime.lastError; });
    // 既存ユーザーのアップデート時のみ初回お知らせフラグを立てる（install では立てない）
    const isUpdate = details?.reason === "update";
    const shouldSetNotice = isUpdate
        && (!details.previousVersion || isVersionBefore(details.previousVersion, UPDATE_NOTICE_INTRODUCED_VERSION));
    if (shouldSetNotice) {
        // フラグ保存後に再注入し、新しい content script の初期確認との競合を防ぐ。
        chrome.storage.local.set({ update_notice_pending: true }, () => {
            if (chrome.runtime.lastError) {
                console.warn("Background: update_notice_pending 保存失敗:", chrome.runtime.lastError.message);
            }
            reinjectContentScriptsAfterUpdate();
        });
    } else if (isUpdate) {
        reinjectContentScriptsAfterUpdate();
    }

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
    // 範囲をドラッグしている数秒の間に、文字認識エンジン（同梱の学習データとWASM）を
    // 先に読み込ませておく。初回だけ発生する待ち時間を利用者に見せないため。
    // 失敗しても本来の経路で改めて生成されるので無視してよい。
    prewarmOcr();
}

// フォールバック: タブをキャプチャし、範囲選択・OCR用の capture.html を開く。
// 画像データは storage.session 経由で受け渡す（Service Worker の休止に耐えるため）。
// 固定キーへの上書き保存なので並行実行しても last-write-wins となり、
// 追い越された側のタブは captureId の不一致で明示的なエラーを表示できる。
async function startCaptureOcrInTab(tab) {
    let captureStored = false;
    try {
        let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        if (dataUrl.length > CAPTURE_MAX_DATAURL_LENGTH) {
            // captureVisibleTab は毎秒の呼び出し回数制限があるため再キャプチャはせず、
            // 取得済みのPNGをJPEGへ再エンコードしてクォータに収める
            dataUrl = await reencodeCaptureAsJpeg(dataUrl);
        }

        const captureId = typeof crypto?.randomUUID === "function"
            ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await chrome.storage.session.set({
            [CAPTURE_STORAGE_KEY]: {
                captureId,
                dataUrl,
                sourceTitle: String(tab.title ?? "").slice(0, 1000),
                sourceUrl: String(tab.url ?? "").slice(0, 4000),
                createdAt: Date.now()
            }
        });
        captureStored = true;

        await chrome.tabs.create({
            url: chrome.runtime.getURL(`capture.html?cid=${captureId}`),
            index: tab.index + 1
        });
    } catch (err) {
        if (captureStored) {
            try { await chrome.storage.session.remove(CAPTURE_STORAGE_KEY); } catch (error) { /* best effort */ }
        }
        // chrome:// ページ等のキャプチャ不可画面ではここに到達する。
        // ページ内にUIを出せない場面もあるため、ツールバーバッジで簡易通知する。
        console.warn("Background: 画面キャプチャに失敗:", err.message);
        const isFileUrl = /^file:/i.test(String(tab.url ?? ""));
        flashActionBadge(tab.id, "ERR", isFileUrl
            ? "ローカルファイルをキャプチャできません。拡張機能の詳細で「ファイルの URL へのアクセスを許可する」を ON にしてください"
            : "このページは画面をキャプチャできません（Chromeの設定画面・ウェブストア等）");
    }
}

// タブごとの「最新の範囲OCR要求」。OCRは数十秒かかることがあり、その間に利用者が
// 別の範囲を選び直したり、テキスト選択の読み上げを始めたり、停止したりできる。
// 古い要求の結果が後から届いて新しい読み上げを中断・上書きしないよう、要求に通し番号を
// 付けて offscreen に往復させ、完了時に最新の番号と一致するものだけを読み上げる。
//   値が番号: その番号の要求だけ有効 / null: 停止・別読み上げで無効化済み（結果は捨てる）
// SW休止で失われた場合は照合できないので、その要求の結果は従来どおり受け付ける。
let ocrRequestSeq = 0;
const latestOcrRequestByTab = new Map();
function invalidatePendingOcr(tabId) {
    if (Number.isInteger(tabId) && latestOcrRequestByTab.has(tabId)) {
        latestOcrRequestByTab.set(tabId, null);
    }
}

// ページ内オーバーレイで選択された範囲をキャプチャし、offscreen にOCRを依頼する。
// OCRの完了は offscreen からの OCR_COMPLETE メッセージで受け取り（イベント駆動）、
// メッセージ応答チャネルを長時間保持しない（Service Worker の休止対策）。
async function captureAndRecognizeRegion(request, tab) {
    let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (dataUrl.length > CAPTURE_MAX_DATAURL_LENGTH) {
        dataUrl = await reencodeCaptureAsJpeg(dataUrl);
    }
    if (dataUrl.length > CAPTURE_MAX_DATAURL_LENGTH) {
        throw new Error("キャプチャ画像が大きすぎます。表示倍率を下げて再度お試しください。");
    }
    await setupOffscreen();
    const requestId = ++ocrRequestSeq;
    latestOcrRequestByTab.set(tab.id, requestId);
    await sendToOffscreen({
        type: "OCR_RECOGNIZE",
        dataUrl,
        rect: request.rect,
        viewportWidth: request.viewportWidth,
        tabId: tab.id,
        requestId
    });
}

// OCR_COMPLETE が今も有効な要求のものかを判定する。無効なら true を返して呼び出し側に
// 捨てさせる。停止・別読み上げで無効化された場合は「文字認識中…」表示だけを片付ける
// （より新しいOCRが進行中の場合はそのトーストを消さないよう何も通知しない）。
function consumeStaleOcrCompletion(tabId, requestId) {
    if (!Number.isInteger(requestId) || !latestOcrRequestByTab.has(tabId)) return false;
    const latest = latestOcrRequestByTab.get(tabId);
    if (latest === requestId) {
        latestOcrRequestByTab.delete(tabId);
        return false;
    }
    // null は次の要求が来るまで残す（同じタブに複数の古い要求が並んでいても全て捨てる）。
    if (latest === null) notifyTab(tabId, { type: "OCR_STATUS", status: "done" });
    return true;
}

// PNGのdataURLをJPEG（品質92%）へ再エンコードする。
// それでも上限を超える超高解像度画面では、収まる見込みの倍率まで縮小して再試行する。
async function reencodeCaptureAsJpeg(pngDataUrl) {
    const blob = await (await fetch(pngDataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
        let scale = 1;
        let dataUrl = "";
        for (let attempt = 0; attempt < 4; attempt++) {
            dataUrl = await drawToJpegDataUrl(bitmap, scale);
            if (dataUrl.length <= CAPTURE_MAX_DATAURL_LENGTH) return dataUrl;
            scale *= Math.sqrt(CAPTURE_MAX_DATAURL_LENGTH / dataUrl.length) * 0.85;
        }
        throw new Error("キャプチャ画像を安全なサイズまで縮小できませんでした。");
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
// タブごとに表示するため、タイマーもタブごとに持つ（共有すると先に失敗したタブの
// 解除が取り消され、そのタブに ERR が残り続ける）。
const badgeClearTimers = new Map();
// manifest.json の action.default_title と同一。エラー通知後に戻すため保持する。
const ACTION_DEFAULT_TITLE = "画面をキャプチャしてOCR読み上げ（画像・PDF向け）";
// ページ内にUIを出せない画面（chrome:// 等）での唯一の通知手段。
// バッジは3文字程度しか出せないため、理由は必ずツールチップにも入れる。
// 失敗したタブに限定して表示する（全タブのアイコンに ERR が出ないように）。
// タブが3秒以内に閉じられると解除側の呼び出しが失敗するが、タブ限定の表示は
// タブと一緒に消えるので無視してよい。
function flashActionBadge(tabId, text, title) {
    const target = Number.isInteger(tabId) ? { tabId } : {};
    const swallow = (promise) => Promise.resolve(promise).catch(() => {});
    swallow(chrome.action.setBadgeBackgroundColor({ ...target, color: "#e01e5a" }));
    swallow(chrome.action.setBadgeText({ ...target, text }));
    if (title) swallow(chrome.action.setTitle({ ...target, title: `${ACTION_DEFAULT_TITLE}\n${title}` }));
    const timerKey = Number.isInteger(tabId) ? tabId : "global";
    if (badgeClearTimers.has(timerKey)) clearTimeout(badgeClearTimers.get(timerKey));
    badgeClearTimers.set(timerKey, setTimeout(() => {
        badgeClearTimers.delete(timerKey);
        swallow(chrome.action.setBadgeText({ ...target, text: "" }));
        swallow(chrome.action.setTitle({ ...target, title: ACTION_DEFAULT_TITLE }));
    }, 3000));
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

// 複数タブからの同時表示権要求を Promise チェーンで直列化し、1回のみ true を返す
let updateNoticeQueue = Promise.resolve();

function claimUpdateNotice() {
    const next = updateNoticeQueue.then(() => new Promise((resolve) => {
        if (!chrome.storage?.local) {
            resolve({ shouldShow: false });
            return;
        }
        chrome.storage.local.get(["update_notice_pending"], (res) => {
            if (chrome.runtime.lastError || !res || !res.update_notice_pending) {
                resolve({ shouldShow: false });
                return;
            }
            chrome.storage.local.set({ update_notice_pending: false }, () => {
                if (chrome.runtime.lastError) {
                    resolve({ shouldShow: false });
                    return;
                }
                resolve({ shouldShow: true });
            });
        });
    })).catch(() => ({ shouldShow: false }));

    updateNoticeQueue = next.catch(() => {});
    return next;
}

// ローカルのVOICEVOX互換APIが予期しないJSONを返しても、拡張ページへ巨大・不正な
// オブジェクトを渡さないよう、設定画面で必要な項目だけへ正規化する。
function normalizeSpeakerList(value) {
    if (!Array.isArray(value)) throw new Error("キャラクター一覧の形式が不正です");
    const speakers = [];
    for (const speaker of value.slice(0, 1000)) {
        if (!speaker || typeof speaker.name !== "string" || !Array.isArray(speaker.styles)) continue;
        const name = speaker.name.trim().slice(0, 100);
        if (!name) continue;
        const styles = [];
        for (const style of speaker.styles.slice(0, 1000)) {
            const id = Number(style?.id);
            if (!Number.isInteger(id) || id < 0 || id > 1000000) continue;
            const styleName = typeof style?.name === "string" ? style.name.trim().slice(0, 100) : "";
            styles.push({ id, name: styleName });
        }
        if (styles.length) {
            speakers.push({
                name,
                speaker_uuid: typeof speaker.speaker_uuid === "string"
                    ? speaker.speaker_uuid.slice(0, 200) : "",
                styles
            });
        }
    }
    if (!speakers.length) throw new Error("利用可能なキャラクターが見つかりません");
    return speakers;
}

// 音声の開始・停止要求を到着順に処理する。複数タブから同時に要求された場合でも、
// 「宛先切替 → 既存再生停止 → 新規キュー追加」の順序が交差しないようにする。
let voiceOperationQueue = Promise.resolve();
function enqueueVoiceOperation(operation) {
    const next = voiceOperationQueue.then(operation);
    voiceOperationQueue = next.catch(() => {});
    return next;
}

// Content Scriptからのメッセージを処理するリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target && request.target !== 'background') return;
    const security = globalThis.VVRadioBackgroundSecurity;
    if (security) {
        const checked = security.validateRequest(request, sender);
        if (!checked.ok) {
            sendResponse(security.invalidResponse(request?.type, checked.error));
            return false;
        }
        request = checked.request;
    }
    // target:'background' は offscreen ドキュメントからの通知（PLAYBACK_* / OCR_*）に限る。
    // 送信元が offscreen.html であることを確認し、他コンテキストからの偽装を排除する（多層防御）。
    // content script/拡張ページからの要求は target を付けず、sender.tab で正しく扱っている。
    if (request.target === 'background'
        && sender.url !== chrome.runtime.getURL('offscreen.html')) {
        return;
    }

    switch (request.type) {
        case "CLAIM_UPDATE_NOTICE": {
            // タブのトップフレーム (frameId === undefined || frameId === 0) からの要求のみ許可する
            const isTopFrame = sender?.tab != null && (sender.frameId === undefined || sender.frameId === 0);
            if (!isTopFrame) {
                sendResponse({ shouldShow: false });
                return false;
            }
            claimUpdateNotice()
                .then(res => sendResponse(res))
                .catch(() => sendResponse({ shouldShow: false }));
            return true;
        }
        case "SHORTCUT_PRESSED":
            // content.js の trusted keydown フォールバックからの要求。
            // commands.onCommand と同じ共通処理に集約する。
            handleShortcutRequest(sender.tab?.id, "content.SHORTCUT_PRESSED")
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case "OPEN_OPTIONS":
            respondWith(chrome.runtime.openOptionsPage(), sendResponse);
            return true;

        case "CHECK_CONNECTION":
            respondWith(
                fetchWithTimeout(`${VOICEVOX_BASE_URL}/version`, {}, VOICEVOX_FETCH_TIMEOUT_MS)
                    .then((res) => {
                        const cancellation = res.body?.cancel?.();
                        cancellation?.catch?.(() => {});
                        return res.ok;
                    }),
                sendResponse,
                (ok) => ({ success: ok }));
            return true;

        case "GET_SPEAKERS":
            respondWith(
                fetchWithTimeout(`${VOICEVOX_BASE_URL}/speakers`, {}, VOICEVOX_FETCH_TIMEOUT_MS)
                    .then((res) => {
                        if (!res.ok) throw new Error(`キャラクター一覧の取得に失敗しました (${res.status})`);
                        return readJsonResponseWithLimit(res).then(normalizeSpeakerList);
                    }),
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
            // 新しい読み上げの開始は、そのタブで進行中の範囲OCRを無効化する
            // （古い認識結果が後から届いてこの読み上げを中断しないように）。
            invalidatePendingOcr(sender.tab?.id);
            // 宛先の保存を完了してから合成を開始し、直後の PLAYBACK_STARTED を取りこぼさない。
            enqueueVoiceOperation(async () => {
                await switchPlaybackTabTo(sender.tab?.id ?? null);
                await handleGenerateVoice(request.text, sendResponse);
            }).catch((err) => sendResponse({ success: false, error: err.message }));
            return true;

        case "STOP_ALL":
            // 停止はそのタブで進行中の範囲OCRも取り消す（完了後に勝手に読み上げを始めない）。
            invalidatePendingOcr(sender.tab?.id);
            respondWith(enqueueVoiceOperation(stopOffscreenAudioIfPresent), sendResponse);
            return true;

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
            // 選び直し・停止・別の読み上げ開始で古くなった要求の結果は使わない。
            if (consumeStaleOcrCompletion(tabId, request.requestId)) return false;
            if (request.error || !request.text) {
                notifyTab(tabId, {
                    type: "OCR_STATUS",
                    status: "error",
                    message: request.error || "文字を認識できませんでした。"
                }, "OCRエラー通知の送信失敗");
                return false;
            }
            // 宛先の保存完了後に読み上げを始め、開始通知の転送先を確実にする。
            enqueueVoiceOperation(async () => {
                await switchPlaybackTabTo(tabId);
                notifyTab(tabId, { type: "OCR_STATUS", status: "done" });
                await handleGenerateVoice(request.text, (res) => {
                    if (res && res.success === false) {
                        notifyTab(tabId, {
                            type: "OCR_STATUS",
                            status: "error",
                            message: `読み上げを開始できませんでした: ${res.error}`
                        }, "読み上げ開始エラー通知の送信失敗");
                    }
                });
            }).catch((err) => {
                notifyTab(tabId, {
                    type: "OCR_STATUS", status: "error",
                    message: `読み上げを開始できませんでした: ${err.message}`
                }, "読み上げ開始エラー通知の送信失敗");
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
        // 記号・罫線だけの選択など、読める文字が無い場合は無音の合成要求を送らず、
        // 理由を返す（呼び出し側がトーストに出す）。
        if (chunks.length === 0) {
            sendResponse({ success: false, error: "読み上げられる文字がありません" });
            return;
        }

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
    const speakers = normalizeSpeakerList(await readJsonResponseWithLimit(speakersRes));

    const speaker = speakers.find(s => s.styles.some(st => st.id === id));
    if (!speaker) throw new Error("選択中のキャラクターが見つかりません");

    // speaker_uuid が無いエンジンでも名前だけは返し、文字表示にフォールバックさせる。
    if (!speaker.speaker_uuid) return { name: speaker.name, icon: null };

    const infoRes = await fetchWithTimeout(
        `${VOICEVOX_BASE_URL}/speaker_info?speaker_uuid=${encodeURIComponent(speaker.speaker_uuid)}`,
        {}, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!infoRes.ok) return { name: speaker.name, icon: null };
    const info = await readJsonResponseWithLimit(infoRes);

    // スタイルごとにアイコンが違うため、選択中のスタイルのものを優先する。
    const styleInfos = Array.isArray(info?.style_infos) ? info.style_infos.slice(0, 1000) : [];
    const matched = styleInfos.find(si => Number(si?.id) === id) || styleInfos[0];
    const icon = typeof matched?.icon === "string"
        && matched.icon.length <= 3 * 1024 * 1024
        && /^[A-Za-z0-9+/=]+$/.test(matched.icon)
        ? matched.icon : null;
    return { name: speaker.name, icon };
}

// ===== 読み上げテキストの整形と分割 =====
//
// あらゆる読み上げ（選択テキスト・範囲読み上げ・OCR・キャプチャタブ）はここを通り、
// VOICEVOX へ渡す「1件ずつの合成単位」になる。多様な入力（記号・URL・日付・単位が混じる
// 文章、箇条書き・表、OCR特有の崩れ、句読点の無い長文、想定外の文字）でも、
// 途切れず・欠けず・不自然にならずに読み上げることが目的。
//
// 実エンジン（VOICEVOX 0.25、CPU合成）で確認した挙動:
// - 記号・絵文字・罫線（─ = * ・ … ★ ■ ◆ 等）は0モーラ＝無音。読まれないが害も無い。
// - 制御文字 U+0000 が混じると、その位置以降が合成から欠落する。
// - ゼロ幅スペース・BOM・ソフトハイフン・双方向制御・結合文字は「読点相当の長い間」になる。
// - 英単語は辞書読み（quick→クイック）で日本語と同程度の速さ。辞書に無い英字列・16進・
//   大文字略語は1文字ずつ読み（日本語の約2倍の時間）、数字列は数として読む（1桁あたり
//   日本語の3〜4倍の時間）。長さの上限は文字数ではなくこの「読み上げコスト」で決める。
// - 文中の「。」の間と、合成単位の切れ目（前後の無音0.1秒ずつ）はほぼ同じ長さ。
//   読点・空白で切っても、聞こえ方はほぼ変わらない。
// - 合成時間は音声長の約0.3倍（無負荷）〜0.7倍（負荷時）。合成は「再生中の分＋先読み分」
//   で進むため、1件の合成が「直前までの音声の残り時間」を超えると無音になる。
// - 句読点・空白（＝間）の無いまま続く部分でアクセント句が49を超えると audio_query が
//   500 を返す、または以降の読みが欠落する（句読点の無い和文276字、16進60字、
//   句読点の無い英文60語で失敗）。和文は上限120で1件に収めれば約40句以下。

// 1件の読み上げコスト上限。SOFT を超える文だけを区切りで分ける。区切りが何も無い塊は
// 上限で機械的に切る（上のエンジン制約のため、切らずに送る方が害が大きい）。
// 先頭の数件は小さくして、クリックから最初の音が出るまでを短くする
// （120コストの文は合成に4〜15秒かかる）。後続の合成は再生中に先読みで進む。
const SPEECH_SOFT_COST = 120;
const SPEECH_LEAD_COSTS = [40, 60, 90];
// offscreen-security.js の MAX_TEXT_ITEMS と揃える（超えると受理されない）。
const SPEECH_MAX_CHUNKS = 5000;
// 1件の文字数の上限。記号・空白の読み上げコストは0なので、コスト上限だけでは1件の
// 文字数が青天井になる（実測: 「あ」＋「=-」×20000 は splitText で1件40,001文字・
// コスト1）。audio_query はテキストをURLのクエリ文字列に載せるため、長すぎる1件は
// エンジンに拒否され、その1件だけが黙って音声から消える。罫線・アスキーアートを
// 含むOCR結果で到達しうるので、コストとは別に文字数でも切る。
// 通常の日本語はコスト120＝約120文字、英文でも約80文字なので、この値では切れない。
const SPEECH_MAX_CHUNK_CHARS = 600;

/**
 * 読み上げに使う文字列へ整形する（分割の前段）。
 * - 合成を欠落させる制御文字、無音なのに長い「間」を作る不可視文字を取り除く
 * - 同じ記号の3個以上の連続（罫線・点線リーダー・強調の＊＊＊）を1個にする
 *   （無音のまま URL 長だけを消費し、極端な場合はエンジンに拒否される）
 * - エンジンが読めない・不自然に読む表記を、読みが定まるものだけ置き換える
 *   （単位の合成文字、日付 2026/08/16、時刻 10:30 等）
 * @param {string} text
 * @returns {string}
 */
function sanitizeSpeechText(text) {
    if (!text) return "";
    let s = String(text);
    try { s = s.normalize("NFC"); } catch (error) { /* 環境依存の失敗は無視 */ }
    s = s.replace(/\r\n?/g, "\n").replace(/[\t\v\f]/g, " ")
        // 制御文字（改行以外）・書式文字（ゼロ幅・BOM・双方向制御・ソフトハイフン）・
        // 単独の結合文字・私用領域・不正なサロゲート・特殊用途文字
        .replace(/[\p{Cc}\p{Cf}\p{Mn}\p{Co}\p{Cs}\uFFF0-\uFFFF]/gu, (ch) => (ch === "\n" ? "\n" : ""))
        // 同じ記号の連続（文字・数字・空白以外）
        .replace(/([^\p{L}\p{N}\s])\1{2,}/gu, "$1")
        // 全角英数字は半角へ（読みは同じ。URL・日付・時刻・桁区切りの判定を効かせる）
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        // 「\12,800」は日本語フォントで円記号として表示される（OCR は \ と読む）
        .replace(/\\(?=\d)/g, "¥")
        // URL は読まない（content.js / ocr-common.js でも置換するが、OCR で「https:/」と
        // 崩れたもの、www. や「ドメイン/パス」で書かれたものはここで拾う。
        // 「example.com」のようなドメインだけの表記はそのまま読める）。
        // 英数字の塊への空白挿入より前に行う（URL の長いパスを壊さない）
        .replace(/https?:\/{1,2}[\w\/:%#$&?()~.=+\-]*/gi, "URL省略")
        .replace(/\bwww\.[\w\-]+(?:\.[\w\-]+)+[\w\/:%#$&?()~.=+\-]*/gi, "URL省略")
        .replace(/\b(?:[a-z0-9\-]+\.)+[a-z]{2,}\/[\w\/:%#$&?()~.=+\-]+/gi, "URL省略")
        // 長い英数字の塊（ハッシュ・base64・ID）は12文字ごとに空白で区切る。VOICEVOX は
        // 辞書に無い英字列を1文字1アクセント句として読み、間の無いアクセント句が49を超えると
        // audio_query が 500 になる／以降が欠落する（実測: 16進60字で 500、50字で欠落）。
        // 空白は間になり、1文字ずつ読む塊では聞こえ方も自然。24字以下の語（通常の英単語・
        // 型番）は触らない
        // 17桁以上の数字列は4桁ずつに（数として読むと途中で欠落し意味も無い）
        .replace(/(?<![\d,.])\d{17,}(?![\d,.])/g, (run) => run.replace(/\d{4}(?=\d)/g, "$& "))
        .replace(/(?=[0-9]*[A-Za-z])[A-Za-z0-9]{25,}/g, (run) => run.replace(/.{12}(?=.)/g, "$& "))
        // 単位・会社表記の合成文字（VOICEVOX は無音）
        .replace(/[㎡㎠㎢㎝㎜㎞㎏㎎㎖㍑㈱㈲№℡]/g, (ch) => SPEECH_COMPAT_CHARS[ch] || ch)
        // 金額 ¥12,800 → 12,800円（そのままだと「エン、イチマン…」と先に読まれる）
        .replace(/[¥￥]\s*(\d[\d,]*(?:\.\d+)?)/g, "$1円")
        // 日付 2026/08/16・2026-08-16（そのままだと「ゼロハチ、ジュウロク」と読まれる）
        .replace(/(?<!\d)(\d{4})[\/／\-](\d{1,2})[\/／\-](\d{1,2})(?![\d\/／\-])/g,
            (m, y, mo, d) => (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31)
                ? `${y}年${Number(mo)}月${Number(d)}日` : m)
        // 時刻 10:00 / 9:30（そのままだと「ジュウ、ゼロゼロ」と読まれる）
        .replace(/(?<![\d０-９:：])(\d{1,2})[:：](\d{2})(?![\d０-９:：])/g,
            (m, h, mi) => (Number(h) <= 24 && Number(mi) <= 59)
                ? `${Number(h)}時${Number(mi) === 0 ? "" : `${Number(mi)}分`}` : m);
    return s;
}

const SPEECH_COMPAT_CHARS = {
    "㎡": "平方メートル", "㎠": "平方センチメートル", "㎢": "平方キロメートル",
    "㎝": "センチメートル", "㎜": "ミリメートル", "㎞": "キロメートル",
    "㎏": "キログラム", "㎎": "ミリグラム", "㎖": "ミリリットル", "㍑": "リットル",
    "㈱": "株式会社", "㈲": "有限会社", "№": "ナンバー", "℡": "電話"
};

// 1文字あたりの読み上げコスト（実測の音声長比。日本語1文字≒1）。
function speechCharCost(ch) {
    if (/[0-9０-９]/.test(ch)) return 3;
    if (/[A-Za-zＡ-Ｚａ-ｚ]/.test(ch)) return 1.5;
    if (/[\p{L}\p{N}]/u.test(ch)) return 1;
    return 0;
}

function speechCost(str) {
    let cost = 0;
    for (const ch of str) cost += speechCharCost(ch);
    return cost;
}

// 読み上げ対象になる文字（文字・数字）を含むか。記号・空白だけの断片は無音になる。
const SPEECH_READABLE_RE = /[\p{L}\p{N}]/u;

// 分割してよい位置を、区切りの強い順に列挙する（すべて幅ゼロ＝文字を落とさない）。
//   0: 文末。。！？（直後の閉じ括弧・閉じ引用符まで含める）、改行、全角ピリオド（学術文書の
//      句点。小数点「３．５」、英字の前「example．com」、行頭の番号「１．項目」は除く）
//   1: 英文の文末（空白の前の . ! ?）と節（読点・セミコロン）。コロンは項目名と値を
//      結ぶ（「価格：12,800円」）ので切らない
//   2: 語（空白の直後）
//   3: 文字と記号の境（括弧・中黒・スラッシュ等の前後）
// 0 は無条件に切る（1文＝1件）。1 以降は上限を超える文だけに使う。
const SPEECH_CLOSERS = "」』）)\\]】〕〉》\"'’”";
const SPEECH_SPLIT_LEVELS = [
    new RegExp(`(?<=[。！？][${SPEECH_CLOSERS}]*)(?![。！？${SPEECH_CLOSERS}])|(?<=\\n)`
        + `|(?<=．)(?![0-9A-Za-z])(?<!^\\s*[0-9]{1,3}．)`, "um"),
    // 英文の文末: 略語（Mr. / e.g. / 頭文字 J.）の直後、数字の桁区切り「1,000」では切らない
    /(?<=[.!?])(?=\s)(?<!\b(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|St|No|vs|etc|Fig|Inc|Ltd|Co|Jr|Sr|e\.g|i\.e)\.)|(?<=[、，;；])|(?<=,)(?![0-9])/u,
    /(?<=\s)/u,
    // 記号の前後、および和文と英数字の境（「情報ですb3f9…」）
    /(?<=[^\p{L}\p{N}\s])(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])(?=[^\p{L}\p{N}\s])|(?<=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])(?=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])/u
];

/**
 * 1つの断片を、コスト上限以内の断片へ分ける。
 * 強い区切りから順に候補位置で切り、それでも上限を超える断片は次に弱い区切りへ進む。
 * 弱い区切りでも収まらない（記号も空白も無い長い塊）ときだけ上限で機械的に切る。
 * 分ける必要があるときは、上限いっぱいに詰めて端数を余らせるのではなく、
 * 件数を変えない範囲で各件の長さを揃える（「…across all major regions」＋「this year.」
 * のような不自然な切れ端を作らない）。
 * maxLevel を指定した場合はそれより弱い区切りは使わず、収まらない断片はそのまま返す。
 * @param {string} text
 * @param {number} limit
 * @param {number} level SPEECH_SPLIT_LEVELS の添字
 * @param {number} [maxLevel]
 * @returns {string[]}
 */
function splitByCost(text, limit, level, maxLevel = Infinity, balanced = true) {
    const total = speechCost(text);
    if (total <= limit) return [text];
    if (level > maxLevel) return [text];
    // 区切りが何も無い塊は上限で機械的に切る。語の途中で切ると読みが変わることがあるが、
    // 間の無い塊をそのまま送ると VOICEVOX 側で失敗する（実測: 句読点の無い276字で
    // audio_query が 500、アクセント句が49を超えると欠落）方が害が大きい。
    if (level >= SPEECH_SPLIT_LEVELS.length) return hardCutByCost(text, limit);
    const pieces = text.split(SPEECH_SPLIT_LEVELS[level]).filter((p) => p.length > 0);
    if (pieces.length <= 1) return splitByCost(text, limit, level + 1, maxLevel, balanced);
    // 残りを件数最小で均等に分けたときの1件の目安。詰めるたびに残りから計算し直す。
    const targetFor = (remaining) => (balanced
        ? Math.max(limit / 2, remaining / Math.ceil(remaining / limit)) : limit);
    const out = [];
    let buffer = "";
    let bufferCost = 0;
    let remaining = total;
    let target = targetFor(remaining);
    const flush = () => {
        if (buffer) out.push(buffer);
        remaining -= bufferCost;
        buffer = "";
        bufferCost = 0;
        target = targetFor(remaining);
    };
    for (const piece of pieces) {
        const cost = speechCost(piece);
        if (buffer && bufferCost + cost > target) flush();
        if (cost > limit) {
            // この断片単体で上限を超える → より弱い区切りで分ける
            flush();
            out.push(...splitByCost(piece, limit, level + 1, maxLevel, balanced));
            remaining -= cost;
            target = targetFor(remaining);
            continue;
        }
        buffer += piece;
        bufferCost += cost;
    }
    flush();
    return out;
}

function hardCutByCost(text, limit) {
    let remaining = speechCost(text);
    const targetFor = () => Math.max(limit / 2, remaining / Math.ceil(remaining / limit));
    const out = [];
    let buffer = "";
    let bufferCost = 0;
    let target = targetFor();
    for (const ch of text) {
        const cost = speechCharCost(ch);
        if (buffer && bufferCost + cost > target) {
            out.push(buffer);
            remaining -= bufferCost;
            buffer = "";
            bufferCost = 0;
            target = targetFor();
        }
        buffer += ch;
        bufferCost += cost;
    }
    if (buffer) out.push(buffer);
    return out;
}

/**
 * 読み上げテキストを VOICEVOX へ渡す合成単位の配列にする。
 *
 * 1. 整形（sanitizeSpeechText）
 * 2. 文末（。！？ 改行）で1文ずつに分ける。通常の長さの文はそのまま1件にする
 *    （読点等は VOICEVOX が自然な間として処理する）。
 * 3. 上限コストを超える文だけを、読点→空白→記号境界の順で上限以内に分ける。
 *    句点の無い長い箇条書き（メールの求人紹介等）が1件になると、その合成
 *    （実測: 約390字＝音声55秒に26秒）が直前の文の再生中に終わらず、文の間に
 *    20〜30秒の無音が空いた。読点単位なら1件の合成が数秒に収まり、先読みが追いつく。
 * 4. 文字・数字を含まない断片（罫線・区切り線・記号だけの行・「！！」の残り）は
 *    無音の合成要求になるだけなので落とす。
 * 5. 件数上限を超える分は読まず、その旨を最後に一言添える（黙って失敗しない）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitText(text) {
    const cleaned = sanitizeSpeechText(text);
    if (!cleaned.trim()) return [];

    const sentences = cleaned.split(SPEECH_SPLIT_LEVELS[0]);
    const result = [];
    const push = (piece) => {
        const chunk = piece.trim();
        if (!chunk || !SPEECH_READABLE_RE.test(chunk)) return;
        const chars = [...chunk];
        // コスト0の記号だけが続く塊は文字数で切る（SPEECH_MAX_CHUNK_CHARS のコメント参照）
        if (chars.length <= SPEECH_MAX_CHUNK_CHARS) { result.push(chunk); return; }
        for (let i = 0; i < chars.length; i += SPEECH_MAX_CHUNK_CHARS) {
            const part = chars.slice(i, i + SPEECH_MAX_CHUNK_CHARS).join("").trim();
            if (part && SPEECH_READABLE_RE.test(part)) result.push(part);
        }
    };
    for (const sentence of sentences) {
        let rest = sentence.trim();
        if (!rest || !SPEECH_READABLE_RE.test(rest)) continue;
        // 先頭の数件は、節の区切り（読点・英文の文末）で小さく切り出せるならそうする。
        // 節の区切りが無い文は無理に語の途中で切らず、通常の上限で扱う。
        // 切り出した先頭が上限の半分にも満たない（「新型センサー、」のような短い語句）
        // 場合もやめる: 直後の長い件の合成がその短い音声の再生中に終わらず、開始直後に
        // 途切れる方が、待ち時間より目立つ。
        while (rest && result.length < SPEECH_LEAD_COSTS.length) {
            const lead = SPEECH_LEAD_COSTS[result.length];
            const [head, ...tail] = splitByCost(rest, lead, 1, 1, false);
            const headCost = speechCost(head);
            if (headCost > lead || (tail.length > 0 && headCost < lead / 2)) break;
            push(head);
            rest = tail.join("");
        }
        if (rest) splitByCost(rest, SPEECH_SOFT_COST, 1).forEach(push);
        if (result.length >= SPEECH_MAX_CHUNKS) break;
    }
    if (result.length >= SPEECH_MAX_CHUNKS) {
        result.length = SPEECH_MAX_CHUNKS - 1;
        result.push("読み上げの上限に達したため、ここまでで終了します。");
    }
    return result;
}
