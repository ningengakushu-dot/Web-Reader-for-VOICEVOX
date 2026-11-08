
// --- ページ内範囲選択OCR ---

// 進行状況の通知先タブ（OCR実行中のみ設定）
let ocrProgressTabId = null;
// 表示には主経路（元寸・全文）の認識の進捗だけを使う。方向判定の並行認識や
// 精錬・局所確認は回数が入力次第で変わるうえ、横書き・縦書きworkerが並行して
// 交互に 0→1 を報告するため、全部をつなぎ合わせる方式は成り立たない
// （かつては進捗の後退から回の切り替わりを推定していたが、並行化により
// 開始直後に表示が100%近くへ張り付いていた）。どの認識が主経路かの判別と
// ゲージへの変換は ocr-common.js（createPrimaryOcrProgressTracker）に集約している。
const ocrDisplayProgress = createPrimaryOcrProgressTracker();

// OCRワーカーは組版方向（横書き jpn / 縦書き jpn_vert）ごとに初回利用時に生成し、
// 以降のOCRで使い回す。この offscreen document が破棄された場合は次回作成時に再生成される。
const ocrWorkers = createOcrWorkerPool((m, source) => {
    if (ocrProgressTabId == null) return;
    const progress = ocrDisplayProgress.update(m, source);
    if (progress != null) {
        notifyBackground("OCR_PROGRESS", {
            tabId: ocrProgressTabId,
            progress
        });
    }
});
const getOcrWorker = ocrWorkers.get;

// 範囲OCR要求を1件ずつ順に処理するチェーン。共有Tesseractワーカーの recognize は
// 並行呼び出しに耐えず、進捗通知先 ocrProgressTabId もモジュールグローバルのため、
// 複数タブからの同時要求が混線しないよう直列化する。recognizeRegion は自身で
// OCR_COMPLETE を送るため、チェーンは失敗も飲み込んで（catch）次の要求へ進める。
const MAX_PENDING_OCR_REQUESTS = 3;
let pendingOcrRequests = 0;
let ocrChain = Promise.resolve();
function enqueueOcrRecognition(message) {
    if (pendingOcrRequests >= MAX_PENDING_OCR_REQUESTS) return false;
    pendingOcrRequests++;
    const run = ocrChain.then(() => recognizeRegion(message));
    ocrChain = run.catch(() => {}).finally(() => { pendingOcrRequests--; });
    return true;
}

// ハングした可能性のあるワーカーを破棄し、次回のOCRで作り直させる（認識タイムアウト時に使用）。
const resetOcrWorkers = ocrWorkers.terminate;

/**
 * キャプチャ画像から選択範囲を切り出してOCRし、結果を background へ通知する。
 * rect はビューポートのCSSピクセル座標、キャプチャ画像は物理ピクセルのため、
 * 画像幅とビューポート幅の比率で座標変換する（devicePixelRatio・ズーム両対応）。
 */
async function recognizeRegion({ dataUrl, rect, viewportWidth, tabId, requestId }) {
    ocrProgressTabId = tabId ?? null;
    ocrDisplayProgress.reset();
    cancelOcrWorkerIdleRelease();
    // requestId は background が古い要求の結果を捨てるための通し番号。そのまま返す。
    const complete = (payload) => notifyBackground("OCR_COMPLETE",
        Number.isInteger(requestId) ? { tabId, requestId, ...payload } : { tabId, ...payload });
    try {
        const blob = await (await fetch(dataUrl)).blob();
        const bitmap = await createImageBitmap(blob);
        let canvas;
        try {
            const scale = viewportWidth > 0 ? bitmap.width / viewportWidth : 1;
            const sx = Math.max(0, Math.min(Math.round(rect.x * scale), bitmap.width - 1));
            const sy = Math.max(0, Math.min(Math.round(rect.y * scale), bitmap.height - 1));
            const sw = Math.max(1, Math.min(Math.round(rect.width * scale), bitmap.width - sx));
            const sh = Math.max(1, Math.min(Math.round(rect.height * scale), bitmap.height - sy));
            canvas = cropToOcrCanvas(bitmap, sx, sy, sw, sh);
        } finally {
            bitmap.close();
        }

        // 組版方向（横書き/縦書き）を自動判定して認識する。
        // 認識がハングしても進捗トーストが残り続けないよう、タイムアウトで打ち切る。
        const data = await withOcrTimeout(
            recognizeWithOrientation(canvas, getOcrWorker),
            OCR_RECOGNIZE_TIMEOUT_MS,
            "文字認識に時間がかかりすぎました。範囲を狭めてお試しください。"
        );
        const text = cleanForSpeech(normalizeOcrText(data.text));

        if (!text) {
            complete({ error: "文字を認識できませんでした。範囲を変えてお試しください。" });
            return;
        }
        complete({ text });
    } catch (err) {
        console.error("Offscreen: OCR失敗:", err);
        // タイムアウトはワーカーがハングした可能性が高いため破棄して作り直させる
        if (err && err.isOcrTimeout) resetOcrWorkers();
        complete({ error: `文字認識に失敗しました: ${err.message}` });
    } finally {
        ocrProgressTabId = null;
        scheduleOcrWorkerIdleRelease();
    }
}

// OCRワーカーは言語ごとに 14MB の学習データを抱えるため、使い終わってしばらく
// 経ったら破棄する。連続して読み上げる間は保持し、放置時だけメモリを返す。
let ocrIdleTimer = null;

function cancelOcrWorkerIdleRelease() {
    if (ocrIdleTimer) {
        clearTimeout(ocrIdleTimer);
        ocrIdleTimer = null;
    }
}

function scheduleOcrWorkerIdleRelease() {
    cancelOcrWorkerIdleRelease();
    ocrIdleTimer = setTimeout(() => {
        ocrIdleTimer = null;
        resetOcrWorkers();
    }, OCR_WORKER_IDLE_RELEASE_MS);
}

