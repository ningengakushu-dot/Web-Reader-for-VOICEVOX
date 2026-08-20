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
