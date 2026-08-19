// OCR共通処理:
// offscreen.html（ページ内範囲選択のOCR）と capture.html（タブでの範囲選択のOCR）の
// 両方から使う Tesseract.js ワーカーの生成・認識の制御・テキスト整形。
// 拡張機能ページ（extension_pages の CSP が適用されるコンテキスト）での実行を前提とする。
//
// 画像の前処理と組版方向の判定は ocr-image.js、認識結果の精錬は ocr-refine.js にある
// （いずれも本ファイルより前に読み込む）。

// OCRエンジン初期化のタイムアウト。アセット読み込み失敗時に createWorker が
// 解決も拒否もされないケースがあるため（tesseract.js v6 の既知の挙動）、
// 待ちっぱなしを防ぐ。
const OCR_WORKER_INIT_TIMEOUT_MS = 30000;

// OCR認識本体のタイムアウト。worker.recognize が返らない（極端な入力・WASM異常）ときに
// 進捗トーストや「実行中」表示が残り続けないよう、呼び出し側でこの時間で打ち切る。
const OCR_RECOGNIZE_TIMEOUT_MS = 60000;

/**
 * Promise をタイムアウト付きで待つ。
 * 超過時は isOcrTimeout 目印付きの Error で reject する
 * （呼び出し側がタイムアウトとその他の失敗を区別し、ハングしたワーカーを破棄できるようにする）。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withOcrTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(message);
            err.isOcrTimeout = true;
            reject(err);
        }, ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

// ===== ワーカーの生成と使い回し =====

// ===== 表示用の進捗（OCR結果には影響しない） =====
//
// 1回のOCR要求では、主経路（元寸・全文）の認識に加えて、方向判定の並行認識・
// 拡大版・二値化版・融合用の各倍率・短い縦列の局所確認が走り、認識回数は入力に
// よって数回〜10回超まで変わる。各認識は独立に 0→1 の進捗を報告し、横書き(jpn)と
// 縦書き(jpn_vert)のworkerは並行にも動くため、進捗メッセージの連結だけでは
// 「全体のどこまで進んだか」を再構成できない。そこで認識を実行する側
// （recognizeWithOrientation）が「いまどのworkerが主経路を認識中か」の目印を立て、
// プールのloggerがメッセージへ由来（lang）と目印を添える。
//
// 目印がworker(lang)単位で正確なのは、同一workerのrecognizeが常に1件ずつ
// 逐次実行されるため（同一workerへの並行recognizeは元々許されない）。
// 目印の窓が開いている間、そのworkerが処理しているのは主経路の認識だけになる。
let ocrPrimaryPassLangs = null;

// 主経路の進捗を表示ゲージのどこまで割り当てるか。主経路完了後も精錬・局所確認が
// 残るが、その回数は確信度など途中の結果に依存して予見できないため、残りを細かく
// 刻まず、この値で止めて完了通知（トーストの消去・バーの非表示）に100%到達を任せる。
const OCR_PRIMARY_PROGRESS_SHARE = 0.7;

/**
 * createOcrWorkerPool のloggerが受け取る (message, source) から、表示用の
 * 通し進捗（単調増加・0〜OCR_PRIMARY_PROGRESS_SHARE）を作る。
 * 主経路以外の認識（方向判定の小領域比較・精錬・局所確認）は表示に使わない。
 * 方向判定で範囲全体を縦横並行認識して主経路として再利用する場合は、
 * 両workerの進捗の遅い方（min）を全体値とする（両方の完了を待つ処理のため）。
 * @returns {{reset: () => void, update: (m: object, source: object) => number|null}}
 *   update は表示を進めるべきときだけ値を返し、それ以外は null を返す。
 */
function createPrimaryOcrProgressTracker() {
    let perLang = null;
    let shown = 0;
    return {
        reset() {
            perLang = null;
            shown = 0;
        },
        update(m, source) {
            if (!source || !source.primaryPass || m.status !== "recognizing text") return null;
            if (!perLang) perLang = {};
            perLang[source.lang] = Math.min(1, Math.max(0, m.progress || 0));
            const combined = Math.min(...Object.values(perLang));
            const value = combined * OCR_PRIMARY_PROGRESS_SHARE;
            // 並行認識の交互報告で表示が後退・振動しないよう、増加時だけ通知する
            if (value <= shown) return null;
            shown = value;
            return value;
        }
    };
}

/**
 * 同梱アセットで日本語OCRワーカーを生成する（タイムアウト保護付き）。
 * すべてのアセット（worker/wasmコア/言語データ）は拡張機能に同梱したものを使う。
 * @param {"jpn"|"jpn_vert"} lang jpn=横書き / jpn_vert=縦書き
 * @param {(message: object) => void} [logger] 認識の進捗ログ
 * @returns {Promise<object>} Tesseract のワーカー
 */
function createOcrWorker(lang, logger) {
    let created;
    try {
        created = createOcrWorkerPromise(lang, logger);
    } catch (error) {
        // Tesseract 本体（同梱 tesseract.min.js）が読み込めていない等の同期例外も
        // 拒否された Promise として返し、呼び出し側の .catch（エラー表示）に届かせる。
        return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            // タイムアウト後に遅れて生成が完了した場合は破棄する（リーク防止）
            created.then((worker) => worker.terminate()).catch(() => {});
            reject(new Error("文字認識エンジンの初期化がタイムアウトしました。"));
        }, OCR_WORKER_INIT_TIMEOUT_MS);
        created.then(
            (worker) => { clearTimeout(timer); resolve(worker); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

function createOcrWorkerPromise(lang, logger) {
    return Tesseract.createWorker(lang, 1, {
        workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
        // ディレクトリを指定すると SIMD 対応状況に応じたコアが自動選択される
        corePath: chrome.runtime.getURL("vendor/tesseract/core"),
        langPath: chrome.runtime.getURL("vendor/tesseract/lang"),
        // 同梱の jpn.traineddata は未圧縮のため .gz サフィックスを付けさせない
        gzip: false,
        // MV3 の CSP（script-src 'self'）では Blob URL のワーカーを起動できないため、
        // worker.min.js を直接読み込む
        workerBlobURL: false,
        // ワーカー内部エラーは既定では同期 throw されて捕捉できないため明示的に受ける
        errorHandler: (err) => console.error("OCR: ワーカーエラー:", err),
        logger: logger || (() => {})
    }).then(async (worker) => {
        // 縦書きモデルには「縦書きテキストの単一ブロック」のセグメンテーションを指定する
        // （既定のままだと縦の行（列）分割が正しく行われない）。
        // 横書きモデルはTesseract既定のSINGLE_BLOCK(6)と同値を明示設定する。値は
        // 変えないが、局所漢字再確認がPSMを一時変更した後の復元先（同じ定数）と
        // 生成時の値が一致することをコード上で保証するため。
        try {
            await worker.setParameters({
                tessedit_pageseg_mode: lang === "jpn_vert"
                    ? Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT
                    : Tesseract.PSM.SINGLE_BLOCK
            });
        } catch (error) {
            // 生成済みworker（WASM＋学習データ）を抱えたまま失敗させない
            try { await worker.terminate(); } catch (terminateError) { /* 破棄失敗は無視 */ }
            throw error;
        }
        return worker;
    });
}

/**
 * 組版方向ごとのワーカーを初回利用時に生成し、以降のOCRで使い回すプール。
 * offscreen（ページ内範囲選択）と capture（タブでの範囲選択）が同じ管理をしていたため共通化する。
 *
 * get はそのまま recognizeWithOrientation の workerProvider として渡せる。
 * @param {(message: object, source: {lang: string, primaryPass: boolean}) => void} [logger]
 *   認識の進捗ログ。source でどのworker由来か（lang）と、主経路の認識中かを識別できる
 *   （createPrimaryOcrProgressTracker と組で表示用進捗に変換する）。
 * @returns {{get: (lang: string) => Promise<object>, terminate: () => void}}
 */
function createOcrWorkerPool(logger) {
    const workerPromises = {};
    const readyWorkers = {};
    const get = (lang) => {
        if (!workerPromises[lang]) {
            const created = createOcrWorker(lang, logger
                ? (m) => logger(m, {
                    lang,
                    primaryPass: !!(ocrPrimaryPassLangs && ocrPrimaryPassLangs.includes(lang))
                })
                : logger);
            let tracked;
            tracked = created.then((worker) => {
                if (workerPromises[lang] === tracked) readyWorkers[lang] = worker;
                return worker;
            }).catch((err) => {
                // 失敗したPromiseをキャッシュしない（次回のOCRで再試行できるようにする）
                if (workerPromises[lang] === tracked) {
                    workerPromises[lang] = null;
                    readyWorkers[lang] = null;
                }
                throw err;
            });
            workerPromises[lang] = tracked;
        }
        return workerPromises[lang];
    };
    // ロード済みworkerだけを（新規作成せずに）参照するための補助API。
    get.peek = (lang) => readyWorkers[lang] || null;
    get.invalidate = (lang, expectedWorker = null) => {
        const worker = readyWorkers[lang];
        if (expectedWorker && worker !== expectedWorker) return false;
        const promise = workerPromises[lang];
        workerPromises[lang] = null;
        readyWorkers[lang] = null;
        if (promise) promise.then((item) => item.terminate()).catch(() => {});
        return true;
    };
    return {
        get,
        // ハングした可能性のあるワーカーを破棄し、次回のOCRで作り直させる
        // （ページ離脱時・認識タイムアウト時・一定時間の未使用時に呼ぶ）。
        terminate() {
            for (const lang of Object.keys(workerPromises)) {
                const promise = workerPromises[lang];
                workerPromises[lang] = null;
                readyWorkers[lang] = null;
                if (promise) promise.then((worker) => worker.terminate()).catch(() => {});
            }
        }
    };
}

/**
 * 全文用の縦書きモデルとは独立した横書きモデルで、短い縦列の漢字だけを再確認する。
 * gray 2.5倍・Otsu二値化2倍・gray 3倍が強く一致したセルだけを置換する。
 * 辞書・語彙・文脈には依存しない。横書きworkerはプールの準備状況に依存せず
 * ここで必ず取得する（準備済みのときだけ実行すると、直前の操作履歴や
 * 入口＝offscreen/captureの違いで同じ画像の出力が変わってしまうため）。
 * ロードに失敗した場合は補正なしで続行する。
 */
async function refineVerticalGlyphsWithHorizontalWorker(
    grayCanvas, blocks, blockScale, workerProvider, edgeInsets = null) {
    // edgeInsets は認識入力に足した各辺の余白（元の画像端は余白の内側にある）。
    // 端で欠けたセルの除外は元の画像端を基準に行う。
    const targets = collectVerticalGlyphRescanTargets(
        blocks, blockScale, grayCanvas.width, grayCanvas.height, edgeInsets);
    if (!targets.length) return [];

    const replacements = [];
    let worker;
    try {
        worker = await workerProvider("jpn");
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_CHAR });
        for (const target of targets) {
            const raw = cropOcrCanvas(
                grayCanvas, target.x, target.y, target.width, target.height, 1);
            const binaryCanvas = prepareOcrCanvas(raw);
            if (binaryCanvas === raw) continue;
            const grayGlyphCanvas = upscaleOcrCanvas(raw, 2.5);
            const grayResult = await worker.recognize(
                grayGlyphCanvas, {}, { text: true, blocks: true });
            const binaryResult = await worker.recognize(
                binaryCanvas, {}, { text: true, blocks: true });
            const gray = extractSingleHanEvidence(
                grayResult.data.blocks, grayGlyphCanvas.width, grayGlyphCanvas.height);
            const binary = extractSingleHanEvidence(
                binaryResult.data.blocks, binaryCanvas.width, binaryCanvas.height);
            let replacement = null;
            if (gray && binary && gray.text === binary.text
                && gray.text !== target.symbol.text
                && gray.confidence >= 85 && binary.confidence >= 85) {
                const thirdCanvas = upscaleOcrCanvas(raw, 3);
                const thirdResult = await worker.recognize(
                    thirdCanvas, {}, { text: true, blocks: true });
                const third = extractSingleHanEvidence(
                    thirdResult.data.blocks, thirdCanvas.width, thirdCanvas.height);
                replacement = selectVerticalGlyphRescanReplacement(
                    target.symbol, gray, binary, third);
            }
            if (replacement) replacements.push({ ...target, replacement });
        }
    } catch (error) {
        return [];
    } finally {
        if (worker) {
            try {
                // 横書きworkerは生成時にPSMを設定しておらず、実効値はTesseract既定の
                // SINGLE_BLOCK(6)。AUTOへ「復元」すると以後の全文OCRの分割挙動が変わる。
                await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
            } catch (error) {
                // SINGLE_CHARのまま残った共有workerを次回全文OCRへ使わせない。
                if (!workerProvider.invalidate?.("jpn", worker)) {
                    try { await worker.terminate?.(); } catch (terminateError) { /* 破棄を優先 */ }
                }
            }
        }
    }
    // 共有blocksは全文融合も変更するため、ここでは書き換えず置換案だけを返す。
    // 呼び出し側が全処理を合流した後、採用された原寸blocksへ一度だけ適用する。
    return replacements;
}

function applyVerticalGlyphRescanReplacements(replacements) {
    if (!replacements?.length) return 0;
    const touchedWords = new Set();
    for (const target of replacements) {
        target.symbol.text = target.replacement;
        touchedWords.add(target.word);
    }
    rebuildOcrWordTexts(touchedWords);
    return replacements.length;
}

// ===== 認識の制御（どの前処理・どの方向の結果を採用するか） =====

// 検出した組版方向での認識確信度がこの値を下回った場合のみ、もう一方の方向でも
// 認識を試して確信度の高い方を採用する。値を低め（55）に設定しているのは、
// 確信度が組版方向をまたいで比較できない（誤った方向でも高確信度になり得る）ため。
// 縦書きの正しい認識は確信度が控えめ（60〜75程度）に出ることが多く、これを安易に
// 横書きへ切り替えると縦書き文をバラバラに誤読した結果を掴む。基本は組版方向の
// 判定を信頼し、明確に低品質なときだけ再判定する。
const OCR_CONFIDENCE_ACCEPT = 55;

// 元画像での認識確信度がこの値以上なら、前処理版の再認識を省略する
// （十分に鮮明な文字。再試行しても改善余地が小さく、時間だけ倍増するため）。
const OCR_PREPROCESS_SKIP_CONFIDENCE = 92;

// 同じ理由で、複数倍率の認識と融合（この段が待ち時間の大半を占める）も省く確信度。
// 実測（2026-08-18、確信度90以上の32入力を逐次A/B）:
//   ・92以上で省く: 誤り 83 → 83 で**全入力の出力がバイト一致**。つまりこの領域では
//     融合は1文字も変えておらず、時間だけを使っていた。実運用予算での待ち時間は
//     6.8→2.1秒 / 5.5→1.8秒 / 7.0→2.5秒 / 5.5→1.6秒（およそ1/3）。
//   ・90以上で省くと 83 → 88 と悪化する（暗い配色の記事 0→4、横書き見出しのページ 11→12）。
//     90〜91 の帯では融合が実際に効いているので、しきい値は 92 から下げない。
const OCR_FUSION_SKIP_CONFIDENCE = 92;

// 前処理版を採用するために必要な確信度の上積み。
// 確信度が拮抗している場合（差1〜2）、前処理版は実際には悪化していることがある
// （実測: MS明朝縦書きスクリーンショットで元画像 CER 11.3%/確信度84 に対し
// 前処理版 CER 13.7%/確信度85）。単純比較だと悪い方を掴むうえ、選択範囲の
// 数pxの違いで採用側が入れ替わり「同じ場所なのに毎回結果が変わる」不安定さを
// 生んでいた。前処理が本当に効くケース（ゴシック体の小さい文字）は実測で
// +4〜+8 の差が付く（84→88、82→90）ため、マージン3はその改善を保ったまま
// 拮抗時の乗り換えだけを防ぐ。
const OCR_PREPROCESS_ADOPT_MARGIN = 3;

// 小さい文字の再認識（2倍拡大）を試す文字サイズのしきい値。
// Tesseract LSTM の最適文字サイズは約20〜30px（公式FAQ）で、縮小表示された
// スクリーンショット等で文字が小さいと漢字の誤認識が急増する（実測: 行bbox
// 文字サイズ10px相当で CER 21.6%）。1回目の認識結果の行bboxから文字サイズを
// 実測し、この値未満のときだけグレースケール画像の2倍拡大でも認識して、
// 確信度がマージン以上高い場合に採用する。
// 実測（カクヨム明朝縦書き・縮小系列）: CER 21.6%→2.0%、31.4%→9.8%、3.9%→2.9%。
// 文字が十分大きい場合は候補に入れないため劣化せず、MS明朝ベースラインは
// 全サイズで変化なし。補間kernel非依存（lanczos3/mitchellで同一結果）。
// なお「常時拡大」「目標30pxへの適応拡大(最大3x)」は実測で固定2xに劣り不採用
// （過剰拡大は補間アーティファクトが逆効果: 10px→3x で CER 8.8% vs 2x で 2.0%）。
const OCR_UPSCALE_TRIGGER_GLYPH_PX = 24;

// 2倍拡大版へ「全文まるごと」乗り換えることを許す、元寸側の確信度の上限。
// 2倍拡大版は全体の確信度が高くても個々の文字を誤ることがあり、丸ごと入れ替えると
// 元寸で正しく読めていた文字まで失われる（実測: 元寸 conf86 で「間違っていた」が
// 正しいのに、conf89 の2倍拡大版が「問違っていた」で上書きし読み上げが破綻した）。
// そのため全文乗り換えは「元寸が明らかに信用できない」場合だけに限定し、
// 信用できる範囲の改善は文字単位融合（正しい文字を壊さない）に任せる。
// 実測: 壊滅的な領域（文字10px・元寸CER24%）では元寸の確信度が58程度まで落ちるため、
// 75 を境にすると壊滅ケースの救済（CER 24.31%→2.55%）は保ったまま上書き事故を防げる。
const OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE = 75;

// 認識全体をこの時間に収めることを目標に、精錬（拡大再認識・二値化・文字融合）の
// 実行回数を決める。精錬1段は元寸の認識1回分とほぼ同じ時間がかかる。
// 体感速度を優先した値。実測では 1920x1080 の全画面キャプチャは元寸の認識だけで
// 7〜10秒かかり、精錬を無制限に許すと合計20秒を超えて「読み上げ開始が遅い」と感じられる。
// この値は実質的に「認識全体の待ち時間の上限」になる（予算を超えない範囲でしか
// 精錬を足さないため）。範囲をドラッグした通常の選択は元寸が1〜4秒なので、
// 精錬は2〜7段まで走り精度は保たれる＝遅いケースだけを速くする。
const OCR_REFINE_TIME_BUDGET_MS = 15000;

// 精錬を行う入力画素数の上限。これを超える大きなキャプチャでは精錬を一切行わない。
// 実測: 1920x1080(2.1Mpx) では1段が7〜12秒かかり、1段走るだけで待ち時間が倍増する。
// 一方、範囲をドラッグした選択は 0.5Mpx 程度なので通常どおり精錬される。
const OCR_REFINE_MAX_AREA = 1200000;

// 画素統計では向きを決めきれない小～中規模画像は、局所パッチの偏りや選択位置に
// 左右されないよう範囲全体を縦横モデルで認識する。方向間confidenceは常に比較可能とは
// 限らないため、明確な差が付いた場合だけ切り替える。大画像は従来の小領域比較を使う。
// 実測（縦書き本文の選択左端を6pxずつ移動）では、従来はCER 2.38%→99.21%と
// 破綻したが、全体比較では横70〜72 / 縦88〜89と安定して正しい向きを選べた。
const OCR_ORIENTATION_FULL_CONFIDENCE_MARGIN = 8;

/**
 * 比較用画像を横書き・縦書きの両モデルで並行認識し、確信度差が明確な側を返す。
 * 比較用画像が選択範囲全体の場合だけ、両結果を後段の本文・副方向候補として再利用する。
 * verticalCanvas を渡した場合、縦書きモデルだけはそちらを認識する（柱を塗った画像を
 * 縦書き側にだけ使うため。採用された側の結果がそのまま本文認識になる）。
 * @returns {Promise<{orientation: "horizontal"|"vertical", fullData: object|null,
 * elapsedMs: number}|null>} 判定できないときは null
 */
async function resolveOcrOrientation(
    comparisonCanvas, workerProvider, outputFields, fallbackOrientation,
    confidenceMargin = OCR_ORIENTATION_FULL_CONFIDENCE_MARGIN, reuseAsFull = true,
    verticalCanvas = null) {
    try {
        const [horizontalWorker, verticalWorker] = await Promise.all([
            workerProvider("jpn"),
            workerProvider("jpn_vert")
        ]);
        // 曖昧入力で局所パッチや暫定方向を確定扱いすると、選択位置の数px差で
        // 縦書き全体を横書きに誤転換する。2認識は別ワーカーなので並行実行し、
        // 採用側のdataを後段のprimaryとして再利用して認識回数を増やさない。
        const startedAt = Date.now();
        // 範囲全体の並行認識を主経路として再利用する場合は、この2認識が
        // 実質的な主経路（表示進捗の基準）になる。小領域比較は対象外。
        if (reuseAsFull) ocrPrimaryPassLangs = ["jpn", "jpn_vert"];
        let horizontal;
        let vertical;
        try {
            [horizontal, vertical] = await Promise.all([
                horizontalWorker.recognize(comparisonCanvas, {}, outputFields),
                verticalWorker.recognize(verticalCanvas || comparisonCanvas, {}, outputFields)
            ]);
        } finally {
            ocrPrimaryPassLangs = null;
        }
        const difference = Math.abs(horizontal.data.confidence - vertical.data.confidence);
        const orientation = difference >= confidenceMargin
            ? (horizontal.data.confidence >= vertical.data.confidence ? "horizontal" : "vertical")
            : fallbackOrientation;
        return {
            orientation,
            fullData: reuseAsFull ? {
                jpn: horizontal.data,
                jpn_vert: vertical.data
            } : null,
            elapsedMs: Math.max(1, Date.now() - startedAt)
        };
    } catch (error) {
        // 判定に失敗しても本来の認識は続ける
        return null;
    }
}

/**
 * 組版方向を自動判定してOCRを実行する。確信度が低い場合はもう一方の方向でも
 * 認識し、良い方の結果を返す。
 *
 * @param {HTMLCanvasElement} sourceCanvas 認識対象（切り出し済み・原寸）
 * @param {(lang: string) => Promise<object>} workerProvider ワーカーを返す関数（キャッシュは呼び出し側）
 * @returns {Promise<{text: string, confidence: number}>} text は処理後の生テキスト（整形は呼び出し側）
 */
async function recognizeWithOrientation(sourceCanvas, workerProvider) {
    // 前回の認識がタイムアウトでworkerごと破棄された場合、目印を閉じる finally が
    // 実行されないまま残ることがある（recognizeが永遠に解決しない）。要求は
    // 呼び出し側で直列化されているため、開始時に必ず初期化して誤標識を防ぐ。
    ocrPrimaryPassLangs = null;
    // blocks は文字サイズの実測、文字融合、段落境界の推定に使う。
    const outputFields = { text: true, blocks: true };

    // まずグレースケール化した元寸画像を作る（拡大・二値化はしない。
    // 明朝体等、強い前処理が裏目に出るフォントがあるため）。
    // 認識に渡す画像（grayCanvas と、そこから作る拡大版・二値化版）には、文字が画像端に
    // 接している辺にだけ背景色の余白を足し、インクと端の間に最低 OCR_INPUT_PAD_PX を確保する
    // （理由と実測は OCR_INPUT_PAD_PX のコメント参照。既に余白がある画像は無変更）。
    // 組版方向の判定と面積によるしきい値は、余白の無い元画像（unpaddedGrayCanvas /
    // sourceCanvas）で行い、余白の有無で判定が変わらないようにする。
    // 表の罫線・ボタンの枠・下線のような「文字の画よりずっと長い直線」は、認識に渡す前に
    // 消す。横書きworkerの行分割を壊して語が丸ごと落ちるため（詳細と実測は
    // removeOcrRuleLines のコメント参照）。長い直線が無ければ画像は1画素も変わらない。
    const unpaddedGrayCanvas = removeOcrRuleLines(toGrayscale(sourceCanvas));
    const paddedInput = padOcrCanvasToMargin(unpaddedGrayCanvas, OCR_INPUT_PAD_PX);
    let grayCanvas = paddedInput.canvas;
    // 認識入力の座標系で「元の画像端」がどこにあるか（各辺に足した余白。局所再確認で
    // 端の欠けセルを除く基準と、二値化版へ同じ余白を付けるのに使う）
    const inputInsets = paddedInput.insets;
    const sourceArea = sourceCanvas.width * sourceCanvas.height;

    const detected = detectTextOrientation(sourceCanvas);
    let orientation = detected.orientation;
    // 縦書き寄りと画素統計が判断した入力に限り、本文列と直交する細い帯（書籍の柱・
    // ページ番号）を認識前に背景で塗る。縦書きモデルは柱を列ごとに切り刻んで各列の
    // 先頭へ無意味な断片として出力し、それが読み上げられてしまう
    // （詳細と実測は findOcrOutlierInkBands のコメント参照）。
    // 塗った画像は「縦書きモデルへ渡す入力」にだけ使う。方向が未確定のときは
    // 縦横の比較でも縦書き側だけがこの画像を見るので、横書きに決まった場合は
    // 塗る前の画像がそのまま使われる（横書きの見出し行を消すことはない）。
    const outlierBands = detected.orientation === "vertical"
        ? findOcrOutlierInkBands(grayCanvas) : [];
    const maskedGrayCanvas = outlierBands.length
        ? fillOcrCanvasBands(grayCanvas, outlierBands) : grayCanvas;
    // 実際に採用した（＝以降の全ての認識入力の基準になる）帯。二値化版へ同じ帯を塗るのに使う。
    let appliedBands = [];
    if (detected.confident && outlierBands.length) {
        grayCanvas = maskedGrayCanvas;
        appliedBands = outlierBands;
    }
    let resolvedFullData = null;
    let resolvedFullMs = 0;
    if (!detected.confident) {
        // 精錬を許す面積（120万px）までは局所パッチの偏りを避けるため全体を比較する。
        // それを超える全画面級は CPU・メモリ回帰を避け、小領域比較を維持する。
        const compareFull = sourceArea <= OCR_ORIENTATION_FULL_COMPARE_MAX_AREA;
        // 局所パッチは余白の無い画像から選ぶ（格子が余白でずれると判定が変わる）。
        // 全体比較は認識入力（余白付き）をそのまま使い、主経路として再利用する。
        const comparisonCanvas = compareFull
            ? grayCanvas : pickOcrTextPatch(unpaddedGrayCanvas, OCR_ORIENTATION_PATCH_PX);
        // 縦書き側だけ柱を塗った画像で認識する（採用された側の結果がそのまま本文認識に
        // なるため、横書きに決まった場合は塗る前の画像の結果が使われる）。
        const verticalComparisonCanvas = compareFull && outlierBands.length
            ? maskedGrayCanvas : comparisonCanvas;
        const resolved = comparisonCanvas ? await resolveOcrOrientation(
            comparisonCanvas, workerProvider,
            compareFull ? outputFields : { text: true }, orientation,
            compareFull ? OCR_ORIENTATION_FULL_CONFIDENCE_MARGIN : 0,
            compareFull, verticalComparisonCanvas) : null;
        if (resolved) {
            orientation = resolved.orientation;
            resolvedFullData = resolved.fullData;
            resolvedFullMs = resolved.elapsedMs;
        }
        // 縦書きに決まったら、以降の認識入力も柱を塗った画像に揃える
        // （全体比較で再利用する縦書き側の結果と同じ画像座標系にする）。
        if (orientation === "vertical" && outlierBands.length && !appliedBands.length) {
            grayCanvas = maskedGrayCanvas;
            appliedBands = outlierBands;
        }
    }
    const primaryLang = orientation === "vertical" ? "jpn_vert" : "jpn";

    const primaryWorker = await workerProvider(primaryLang);
    const startedAt = Date.now();
    let primary;
    if (resolvedFullData?.[primaryLang]) {
        primary = { data: resolvedFullData[primaryLang] };
    } else {
        // 表示進捗の基準になる主経路（元寸・全文）の認識。目印の窓を認識の
        // 実行中だけ開き、例外時も必ず閉じる（詳細は ocrPrimaryPassLangs 参照）。
        ocrPrimaryPassLangs = [primaryLang];
        try {
            primary = await primaryWorker.recognize(grayCanvas, {}, outputFields);
        } finally {
            ocrPrimaryPassLangs = null;
        }
    }
    // 精錬1段のコストは元寸の認識1回分とほぼ同じ。予算に何回入るかを
    // 「元寸の所要時間から一度だけ」決め、以降は残り回数だけで判定する。
    // 段ごとに経過時間を見ると、そのときのマシン負荷で打ち切り位置が変わり、
    // 同じ選択なのに結果が変わってしまうため（過去に報告された不安定さの再発を防ぐ）。
    // ただし画面全体のような大きな入力では1段が7〜12秒かかり、1段でも走ると
    // 待ち時間が倍増して体感を大きく損なうため、面積で先に足切りする。
    const primaryMs = resolvedFullData
        ? resolvedFullMs
        : Math.max(1, Date.now() - startedAt);
    const refinable = sourceArea <= OCR_REFINE_MAX_AREA;
    let refinesLeft = refinable
        ? Math.max(0, Math.floor((OCR_REFINE_TIME_BUDGET_MS - primaryMs) / primaryMs))
        : 0;
    const canRefine = () => refinesLeft > 0;
    const useRefine = () => { refinesLeft--; };

    let best = primary.data;
    let bestLang = primaryLang;
    const glyphSize = estimateGlyphSizeFromBlocks(primary.data.blocks, orientation);
    // 2倍拡大版は「全文の乗り換え候補」と「文字単位融合の素材」の両方に使うため保持する
    let upscaled2x = null;
    const structuralUpscaledData = new Map();
    // 二値化版も、時間予算で新規倍率が不足したときの画像証拠として保持する。
    let preprocessedData = null;
    let preprocessedAttempted = false;

    const recognizePreprocessed = async () => {
        if (preprocessedAttempted || best.confidence >= OCR_PREPROCESS_SKIP_CONFIDENCE
            || !canRefine()) return;
        preprocessedAttempted = true;
        useRefine();
        // 二値化（大津のしきい値・インク率の判定）は余白の無い元画像で行い、その結果に
        // 余白を付けて認識へ渡す（余白の画素でしきい値が動かないようにする）。
        // 二値化版は2倍に拡大されているので、余白も元寸換算で同じ幅（倍率ぶん）にする。
        // 二値化の出力は黒文字・白背景に正規化されているので余白は白（255）。
        const prepared = prepareOcrCanvas(sourceCanvas);
        if (prepared === sourceCanvas) return;
        const preparedScale = prepared.width / Math.max(1, sourceCanvas.width);
        // gray側で柱・ページ番号の帯を塗った場合は、二値化版でも同じ帯を塗る
        // （候補どうしで見えている文字が違うと、後段の整列・融合がずれる）。
        // 帯の座標は余白付きgray基準なので、元寸へ戻してから二値化の倍率を掛ける。
        const preparedMasked = fillOcrCanvasBands(prepared, appliedBands.map((band) => ({
            y0: (band.y0 - inputInsets.top) * preparedScale,
            y1: (band.y1 - inputInsets.top) * preparedScale
        })), 1, 255);
        const preprocessed = await primaryWorker.recognize(padOcrCanvas(preparedMasked, {
            left: inputInsets.left * preparedScale,
            top: inputInsets.top * preparedScale,
            right: inputInsets.right * preparedScale,
            bottom: inputInsets.bottom * preparedScale
        }, 255), {}, outputFields);
        preprocessedData = preprocessed.data;
        if (preprocessed.data.confidence >= best.confidence + OCR_PREPROCESS_ADOPT_MARGIN) {
            best = preprocessed.data;
        }
    };

    const likelyVerticalInsertions = hasLikelyOcrLineInsertions(
        primary.data.blocks, orientation, glyphSize);
    const ensureStructuralEvidence = likelyVerticalInsertions
        && sourceArea <= OCR_ORIENTATION_FULL_COMPARE_MAX_AREA;

    let text;
    let bestOrientation;
    let bestGlyphSize;
    let localReplacements = [];
    // 横書きworkerは縦書き全文workerとは独立している。局所セル確認を全文精錬と
    // 並行開始し、追加の待ち時間をほぼ生じさせず、後段の予算枯渇によって短列補正
    // だけ到達不能になることも防ぐ。未ロードでも関数側で必ずロードする（プールの
    // 温まり具合で同じ画像の出力が変わらないようにする）。生成はtry直前に置き、
    // 合流(finally)まで例外を挟まず必ずawaitされるようにする。
    // 【不変条件】発火条件「confidence >= OCR_CONFIDENCE_ACCEPT || resolvedFullData?.jpn」は
    // 副方向認識（best.confidence < OCR_CONFIDENCE_ACCEPT のときだけ、かつ
    // resolvedFullDataがあれば再利用して認識しない）と排他であることを保証している。
    // これを崩すと同一jpn workerへの同時recognize（PSM=SINGLE_CHAR混線）が起こる。
    // 片側だけ条件や閾値を変更してはいけない。
    const localRescanPromise = orientation === "vertical" && primary.data.blocks
        && (primary.data.confidence >= OCR_CONFIDENCE_ACCEPT || resolvedFullData?.jpn)
        && refinable && canRefine()
        ? refineVerticalGlyphsWithHorizontalWorker(
            grayCanvas, primary.data.blocks, 1, workerProvider, inputInsets)
        : Promise.resolve([]);
    try {

    // 文字が小さい場合のみ、2倍拡大版でも認識して良い方を採用する
    // （縮小表示されたページ等の解像度不足による漢字誤認識への対策。
    //   実測値は OCR_UPSCALE_TRIGGER_GLYPH_PX のコメントを参照）
    if (best.confidence < OCR_PREPROCESS_SKIP_CONFIDENCE
        && glyphSize != null && glyphSize < OCR_UPSCALE_TRIGGER_GLYPH_PX && canRefine()) {
        useRefine();
        const upscaled2xCanvas = upscaleOcrCanvas(grayCanvas, 2);
        upscaled2x = (await primaryWorker.recognize(upscaled2xCanvas, {}, outputFields)).data;
        // 全文の乗り換えは元寸が明らかに信用できないときだけ
        // （理由は OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE のコメント参照）。
        // 乗り換えない場合も、この結果は文字単位融合の素材として使う。
        if (upscaled2x.confidence >= best.confidence + OCR_PREPROCESS_ADOPT_MARGIN
            && best.confidence < OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE) {
            best = upscaled2x;
        }
    }

    // 確信度が十分でなければ、前処理版（拡大＋二値化）でも認識して良い方を採用する
    // （ゴシック体の小さい文字はこちらが大きく改善する）
    await recognizePreprocessed();

    // 横書きで明らかに低品質なら、ページ分割を自動（PSM=AUTO）にして再認識する。
    // 横書き worker は「1ブロックの横書き」（SINGLE_BLOCK）を仮定するため、罫線付きの表の
    // ように全高を貫く縦線があると行分割が破綻する（実測: 罫線表で confidence 17・出力は
    // 無意味な文字列。横罫線だけなら 83、AUTO なら罫線ありでも 85 で CER 96.9%→6.3%）。
    // 壊れた結果のまま次の「もう一方の組版方向」に進むと、縦書き worker の結果（44）が
    // 素の大小比較で採用され、列を縦に読んだ文字列になっていた。
    // 【不変条件】横書き（primaryLang === "jpn"）に限る: 縦書き経路の局所漢字再確認は
    // 同じ jpn worker の PSM を SINGLE_CHAR に切り替えるため、そこと並行させてはならない
    // （縦書き経路では localRescanPromise が動き得るが、横書き経路では常に空）。
    // 既存の到達点（小説コーパス・kakushin・MS）は confidence 78〜92 でこの分岐に入らず、
    // 出力が変更前後で一致することを実測で確認済み。
    if (primaryLang === "jpn" && best.confidence < OCR_CONFIDENCE_ACCEPT && canRefine()) {
        useRefine();
        try {
            await primaryWorker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
            const auto = (await primaryWorker.recognize(grayCanvas, {}, outputFields)).data;
            if (auto.confidence >= best.confidence + OCR_PREPROCESS_ADOPT_MARGIN) best = auto;
        } catch (error) {
            console.warn("OCR: 自動ページ分割での再認識に失敗:", error?.message || error);
        } finally {
            try {
                await primaryWorker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
            } catch (error) {
                console.warn("OCR: PSM の復元に失敗:", error?.message || error);
            }
        }
    }

    // それでも明らかに低品質なときだけ、もう一方の組版方向も試す
    if (best.confidence < OCR_CONFIDENCE_ACCEPT) {
        const secondaryLang = primaryLang === "jpn" ? "jpn_vert" : "jpn";
        const resolvedSecondary = resolvedFullData?.[secondaryLang];
        const secondaryData = resolvedSecondary || (await (async () => {
            const secondaryWorker = await workerProvider(secondaryLang);
            return (await secondaryWorker.recognize(grayCanvas, {}, outputFields)).data;
        })());
        if (secondaryData.confidence > best.confidence) {
            best = secondaryData;
            bestLang = secondaryLang;
        }
    }

    // 重複挿入が疑われる小画像は、破壊的削除を1候補へ緩和せず、独立した倍率証拠を
    // 最大2件追加確保する。採用全文が二値化へ切り替わっても、このMapを共通利用する。
    // 認識は必ず時間予算(refinesLeft)の範囲内で行う。予算外の認識を許すと、予算が
    // 枯渇する低速端末でだけ待ち時間が延び、60秒の全体タイムアウトで認識全体が
    // 失敗し得る（証拠が不足した場合、重複削除は安全側=無変更に倒れる）。
    if (ensureStructuralEvidence) {
        const scales = glyphSize < OCR_FUSION_TRIGGER_GLYPH_PX
            ? OCR_FUSION_SCALES
            : OCR_CONSENSUS_TARGET_GLYPH_PX.map((target) =>
                Math.round((target / glyphSize) * 100) / 100);
        for (const scale of scales) {
            if (structuralUpscaledData.size >= 2) break;
            if (scale === 1 || scale === 2 || scale < 0.4 || scale > 3
                || structuralUpscaledData.has(scale)) continue;
            const area = sourceArea * scale * scale;
            if (area > OCR_FUSION_MAX_AREA) continue;
            if (!canRefine()) break;
            useRefine();
            const variant = await primaryWorker.recognize(
                upscaleOcrCanvas(grayCanvas, scale), {}, outputFields);
            structuralUpscaledData.set(scale, variant.data);
        }
    }

    // best.blocks から tesseract と同じ規則（単語=スペース・行=改行）でテキストを組み立てる。
    // best.text と内容は同一だが、後段の文字融合が symbol.text を書き換えるため
    // blocks から組み直す（置換前は best.text をそのまま使うのと等価）。段落境界の「間」は
    // buildTextFromBlocks では付けず、後段の normalizeOcrText が行の内容から推定して補う。
    // 段落境界の推定には best を生んだ画像の座標系・組版方向を使う
    bestOrientation = bestLang === "jpn_vert" ? "vertical" : "horizontal";
    bestGlyphSize = estimateGlyphSizeFromBlocks(best.blocks, bestOrientation);
    text = best.blocks
        ? buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize)
        : best.text;

    // 全文採用候補が元寸以外でも、取得済みの別画像2種以上があれば、列の物理文字数と
    // 候補ごとの挿入位置の違いからLSTMの重複出力だけを先に除く。置換融合より先に
    // 構造を直し、後段の文字整列が余分なsymbolでずれないようにする。
    if (best !== primary.data && best.blocks && bestLang === primaryLang) {
        const structuralVariants = [
            primary.data, upscaled2x, preprocessedData, ...structuralUpscaledData.values()
        ]
            .filter((data) => data?.blocks && data !== best)
            .map((data) => data.blocks);
        // 幾何（列の物理長）による重複除去に加え、整列一致による余剰文字の削除も一度行う
        // （詳細は OCR_PRUNE_INSERTION_MAX_CONFIDENCE のコメント参照）。
        const pruned = structuralVariants.length
            ? pruneOcrLineInsertions(
                best.blocks, structuralVariants, bestOrientation, bestGlyphSize)
                + pruneOcrConsensusInsertions(best.blocks, structuralVariants)
            : 0;
        if (pruned > 0) text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize);
    }

    // 信頼できる元寸から二値化版へ全文乗り換えした場合も、二値化版のレイアウト・
    // 仮名・句読点・挿入欠落の改善はそのまま維持する。その上で、同じ位置の漢字だけを
    // 元寸gray・2倍gray・二値化の局所confidenceで比較し、全文平均に隠れた上書き事故を戻す。
    // 空認識を含め有効な比較ができない場合は0件となり、従来の二値化結果を変更しない。
    if (best === preprocessedData
        && primary.data.confidence >= OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE
        && upscaled2x?.blocks) {
        const protectedCount = protectOcrSymbolsFromWholeSwap(
            best.blocks, primary.data.blocks, upscaled2x.blocks);
        if (protectedCount > 0) {
            text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize);
        }
    }

    // 認識し直した拡大版を集める共通処理。予算（refinesLeft）と面積上限を守り、
    // 既に持っている2倍拡大版は予算を使わずに再利用する。
    const collectUpscaledVariants = async (scales) => {
        const others = [];
        for (const scale of scales) {
            const area = sourceArea * scale * scale;
            if (area > OCR_FUSION_MAX_AREA) continue;
            // 2倍拡大版は既に持っているので予算を使わずに再利用する。
            // （面積の判定を先に置いても結果は変わらない: 2倍拡大版が存在するのは
            //   元画像が OCR_REFINE_MAX_AREA 以下のときだけで、その4倍でも上限に届かない）
            if (scale === 2 && upscaled2x) { others.push(upscaled2x.blocks); continue; }
            const structuralData = structuralUpscaledData.get(scale);
            if (structuralData) { others.push(structuralData.blocks); continue; }
            if (!canRefine()) break;
            useRefine();
            const variant = await primaryWorker.recognize(upscaleOcrCanvas(grayCanvas, scale), {}, outputFields);
            others.push(variant.data.blocks);
        }
        return others;
    };

    // 文字単位アンサンブル融合。元寸grayが採用され、かつ文字がLSTM最適域を下回るときだけ、
    // 複数倍率の認識結果で低確信度の漢字を精錬する（詳細は OCR_FUSION_* のコメント参照）。
    if (best === primary.data && glyphSize != null && glyphSize < OCR_FUSION_TRIGGER_GLYPH_PX
        && best.confidence < OCR_FUSION_SKIP_CONFIDENCE) {
        const others = await collectUpscaledVariants(OCR_FUSION_SCALES);
        if (others.length) {
            const pruned = pruneOcrLineInsertions(
                best.blocks, others, bestOrientation, bestGlyphSize);
            // 複数倍率の画像証拠だけで文字を融合する。置換したときだけblocksから組み直す
            // （置換ゼロなら tesseract の出力をそのまま使い、挙動を変えない）。
            // この<18px経路の強い多数一致は漢字限定にする。実測(2026-08-14, 9文書×3条件)では
            // 全文字種を許した場合の追加改善はゼロで、漢字限定がメロス13px「人一僅→人一倍」の
            // 改善を全て回収し悪化ゼロ。全文字種だと2/3一致だけで仮名・数字も置換され、
            // 実測済みベースラインの出力が変わるため許可しない。
            const fused = fuseOcrSymbols(best.blocks, others, { consensusClasses: ["kanji"] });
            // 融合の直後に一度だけ、整列一致による余剰文字の削除を行う。
            const consensusPruned = pruneOcrConsensusInsertions(best.blocks, others);
            if (pruned + fused + consensusPruned > 0) {
                text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize);
            }
        }
    } else if (best === primary.data && glyphSize != null
        && glyphSize >= OCR_FUSION_TRIGGER_GLYPH_PX
        && best.confidence < OCR_PREPROCESS_SKIP_CONFIDENCE) {
        // 文字が最適域以上のときは確信度合計による融合は行わないが、最適域を狙う
        // 複数倍率を認識し、全会一致または強い多数一致だけを画像証拠として採用する。
        // 実測では「覚悟→党悟」「鎌倉→鉄倉」のような一般語の誤りがこの領域で多発しており、
        // 従来はゲート（18px）に阻まれて一切補正されていなかった。
        const scales = [];
        const seen = new Set();
        for (const target of OCR_CONSENSUS_TARGET_GLYPH_PX) {
            const scale = Math.round((target / glyphSize) * 100) / 100;
            if (scale === 1 || scale < 0.4 || scale > 3 || seen.has(scale)) continue;
            seen.add(scale);
            scales.push(scale);
        }
        const others = await collectUpscaledVariants(scales);
        // 新規倍率が3件未満なら、既に認識した2倍・二値化画像を候補へ補う。元寸も1票に
        // 含めるため、低速端末で新規倍率が0件でも2つの先行結果があれば3画像で判定できる。
        // 全会一致は新規倍率だけで評価し、補充候補は漢字の強い多数一致にしか使わない。
        const variants = others.slice();
        if (others.length < 3) {
            const seen = new Set(variants);
            for (const data of [upscaled2x, preprocessedData]) {
                if (data?.blocks && data !== best && !seen.has(data.blocks)) {
                    seen.add(data.blocks);
                    variants.push(data.blocks);
                }
            }
        }
        // 確信度合計による漢字の融合はこの領域では悪化する（実測）ため行わない。
        // 整列と融合は候補全体に対して一度だけ行う。
        const pruned = variants.length ? pruneOcrLineInsertions(
            best.blocks, variants, bestOrientation, bestGlyphSize) : 0;
        const fused = variants.length ? fuseOcrSymbols(best.blocks, variants, {
            kanji: false,
            unanimousVariantCount: others.length,
            consensusClasses: others.length < 3 ? ["kanji"] : null,
            consensusIncludesBase: others.length < 3
        }) : 0;
        // 融合の直後に一度だけ、整列一致による余剰文字の削除を行う。
        const consensusPruned = variants.length
            ? pruneOcrConsensusInsertions(best.blocks, variants) : 0;
        if (pruned + fused + consensusPruned > 0) {
            text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize);
        }
    }

    } catch (error) {
        // 精錬段（拡大・二値化・副方向・構造証拠・融合）の失敗で、既に手元にある
        // 主経路の全文認識まで捨てて OCR 全体を失敗させない。text が未組み立てなら
        // その時点の採用結果（少なくとも主経路）から作り、組み立て済みならそれを使う。
        console.warn("OCR: 精錬段で失敗したため、その時点の認識結果を使用します:", error);
        if (text == null) {
            bestOrientation = bestLang === "jpn_vert" ? "vertical" : "horizontal";
            try {
                bestGlyphSize = estimateGlyphSizeFromBlocks(best.blocks, bestOrientation);
                text = best.blocks
                    ? buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize)
                    : best.text;
            } catch (rebuildError) {
                text = best.text ?? "";
            }
        }
    } finally {
        // 途中の全文認識が失敗しても、共有workerのPSM復元が終わるまで次要求へ進ませない。
        localReplacements = await localRescanPromise;
    }

    // 全文融合と局所OCRの完了後、採用結果が原寸縦書きの場合だけ置換案を一度適用する。
    // 別の全文候補へ乗り換えた場合は座標の異なる結果へ推測適用しない。
    if (localReplacements.length && best === primary.data && bestOrientation === "vertical") {
        applyVerticalGlyphRescanReplacements(localReplacements);
        text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize);
    }

    return { text, confidence: best.confidence };
}

// ===== 読み上げ用のテキスト整形 =====

/**
 * OCR結果の整形。
 * VOICEVOX は半角スペースを「間（ポーズ）」として読むため、そのままだと
 * 誤挿入スペースや画像上の折り返し位置で文が不自然に区切れてしまう。
 * - 日本語文字に隣接するスペースは除去する（「確認し ましょう」→「確認しましょう」）
 * - 画像上の折り返し（同じ段落内の改行）は日本語連続なら間を入れずに連結する
 * - 段落の境界（見出しと本文、箇条書きの項目など）には読点相当の「間」を補う。
 *   実機の Tesseract は行座標(bbox)が得られないことがあり、buildTextFromBlocks も
 *   段落境界の空行は付けないため、行の内容から段落境界を推定する: 箇条書きマーカー・
 *   文末・「短く句読点/ひらがなで終わらず次行が長い」見出しパターン（読み＝文字は不変）。
 * @param {string} rawText
 * @returns {string}
 */
function normalizeOcrText(rawText) {
    if (!rawText) return "";
    const cjk = "[\\u3001-\\u30FF\\u31F0-\\u31FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF01-\\uFF9F]";
    const spaceNextToCjk = new RegExp(`(?<=${cjk})[ \\t\\u3000]+|[ \\t\\u3000]+(?=${cjk})`, "g");
    const endsWithCjk = new RegExp(`${cjk}$`);
    const startsWithCjk = new RegExp(`^${cjk}`);
    // 行頭の箇条書きマーカー。全角ダッシュ/ハイフン類（‐‑‒–—―）は小説の行頭「――」等で
    // 多用され地の文を箇条書きと誤判定するため、マーカーには含めない（半角ハイフン - は維持）。
    const bulletStart = /^\s*(?:[-・･*+●○◦■□▪▶▷›»→◆◇☆★#]+\s*|[(（【\[]?\s*(?:\d{1,3}|[０-９]{1,3}|[一二三四五六七八九十]{1,3})\s*[.)）】\].、:：]\s*)/;
    // 「第1章」「第３条」のような番号付き見出し・条文（目次では1行1項目になる）
    const numberedHeading = /^\s*第\s*(?:\d{1,3}|[０-９]{1,3}|[一二三四五六七八九十百]{1,4})\s*[章節条項部編款回話]/;
    // 「価格：12,800円」「重量: 1.2kg」のような項目名＋値の行（スペック表・案内文で連続する）
    const labelLine = /^\s*[^\s：:]{1,10}\s*[：:]\s*\S/;
    const endsSentence = /[。．！？!?…]$/;
    const endsPunct = /[、，。．！？!?｡､：:；;]$/;
    const endsHiragana = /[ぁ-ゖ]$/;
    // 英文の折り返し: 小文字（または英文の読点）で終わる行に小文字で始まる行が続くなら
    // 同じ文の途中（Tesseract は行間が広いと行の間に空行を出すことがある）
    const englishWrap = (prev, cur) => /[a-z,]$/.test(prev) && /^[a-z]/.test(cur);

    const normalized = rawText.replace(/[ \t　]+/g, " ").replace(spaceNextToCjk, "");

    const isBoundary = (prev, cur) => {
        if (bulletStart.test(cur)) return true;
        if (bulletStart.test(prev)) return true;
        if (numberedHeading.test(cur) || numberedHeading.test(prev)) return true;
        if (labelLine.test(cur) || labelLine.test(prev)) return true;
        if (endsSentence.test(prev)) return true;
        // 見出しらしい短い行の後。折り返し（活用・助詞の途中で改行）の誤爆を避けるため、
        // 「短い」かつ「句読点で終わらない」かつ「ひらがなで終わらない（名詞的な語尾）」かつ
        // 「次の行の方が長い（見出し→本文の関係）」を全て満たす場合に限る。
        if (prev.length <= 8 && !endsPunct.test(prev) && !endsHiragana.test(prev) && cur.length > prev.length) return true;
        return false;
    };

    const rawLines = normalized.split("\n");
    let result = "";
    let prev = "";
    let blankBefore = false;
    for (const raw of rawLines) {
        const line = raw.trim();
        if (!line) { blankBefore = true; continue; }
        if (!result) { result = line; prev = line; blankBefore = false; continue; }
        if (englishWrap(prev, line)) {
            result += " " + line;
        } else if (blankBefore || isBoundary(prev, line)) {
            const needsPause = !endsPunct.test(result);
            result += (needsPause ? "、" : "") + line;
        } else {
            const joinDirectly = endsWithCjk.test(result) || startsWithCjk.test(line);
            result += (joinDirectly ? "" : " ") + line;
        }
        prev = line;
        blankBefore = false;
    }
    return result.trim();
}

// 崩れたダッシュの内側に紛れ込む字（l・I・1・スラッシュ・漢数字の一）。これらは本文の
// 文字でもあるため、「両側を棒に挟まれている」ときだけダッシュの一部として畳み込む
// （cleanForSpeech のコメント参照）。
const SPEECH_BAR_RUN_RE = /[ー―—–−|｜](?:[ー―—–−|｜lI1一/\\]*[ー―—–−|｜])+/g;

// 数を表す文脈の目印（漢数字・算用数字・序数の「第」）。この前後にある「一一」は
// 数（十一）とみなしてダッシュへ畳み込まない。
const SPEECH_NUMERAL_NEIGHBOR = "0-9０-９〇一二三四五六七八九十百千万億兆";
// 位取りの漢数字（二〇二六年 のような書き方）に続く助数詞。縦書きの本ではこの表記が
// 使われるため、「一一月」「明治一一年」「一一時」を数として保護する。語彙ではなく
// 「数の後ろに来る字」の並びなので、本文の語を判定に使っているわけではない。
const SPEECH_NUMERAL_COUNTER = "年月日時分秒人回番号個名";
// 横書きのダッシュ「――」は、OCRでは漢数字の「一」2つになりやすい（縦書きでは縦棒
// 「||」になる）。VOICEVOX は「一一」を**ジュウイチ**と読むため（実測）、そのままだと
// 本文に無い4モーラが挿入される。数を表す並び（第一一号・一一〇番・二〇一一年 など）
// には触れず、それ以外の「一」の2連以上だけをダッシュとして畳み込む。
// cleanForSpeech はOCR結果にしか適用されない（DOM本文は background の
// sanitizeSpeechText を通る）ため、ここでの「一一」は数字よりダッシュの崩れが優勢。
const SPEECH_KANJI_DASH_RUN_RE = new RegExp(
    `(?<![${SPEECH_NUMERAL_NEIGHBOR}第])一{2,}`
    + `(?![${SPEECH_NUMERAL_NEIGHBOR}${SPEECH_NUMERAL_COUNTER}])`, "gu");

/**
 * 読み上げ用の整形（content.js の cleanMessage と同等: URLの読み飛ばし・改行の空白化）。
 * 加えて、ダッシュ（――）の連続がOCRで縦棒・数字混じりに崩れたもの
 * （例: 「うわー|ー|1||っ」）を長音1つに正規化する。ダッシュ/長音を含む
 * 混合連続のみを対象とし、縦棒だけの並び（コード内の || 等）には触れない。
 *
 * 畳み込むのは「棒に見える字で始まり、棒に見える字で終わる」連続だけに限る。
 * 以前は l・I・1・スラッシュも連続の一部として無条件に飲み込んでいたため、ダッシュに
 * 隣接しただけの本文が読み上げから黙って消えていた（実測: 「―1972年」→「ー972年」、
 * 「1―2の関係」→「ー2の関係」、「第―1章」→「第ー章」、
 * 「サーバー/クライアント」→「サーバークライアント」）。
 *
 * 横書きのダッシュがまるごと漢数字になった「一一」も、数を表す並びでないときだけ
 * 畳み込む（SPEECH_KANJI_DASH_RUN_RE のコメント参照）。
 * @param {string} text
 * @returns {string}
 */
function cleanForSpeech(text) {
    if (!text) return "";
    return text
        .replace(/https?:\/\/[\w\/:%#\$&\?\(\)~\.=\+\-]+/g, "URL省略")
        .replace(SPEECH_BAR_RUN_RE, (run) => {
            const hasDash = /[―—–]/.test(run);
            const hasChoonAndBar = /ー/.test(run) && /[|｜]/.test(run);
            // ダッシュを含む連続、または長音と縦棒が混在する連続はOCR崩れとみなす。
            // 「サーバー1台」（ー1）やコードの「||」等はどちらの条件も満たさず変化しない。
            return (hasDash || hasChoonAndBar) ? "ー" : run;
        })
        .replace(SPEECH_KANJI_DASH_RUN_RE, "ー")
        .replace(/\n+/g, " ")
        .trim();
}
