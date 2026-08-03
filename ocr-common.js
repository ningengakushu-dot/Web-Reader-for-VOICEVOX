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

/**
 * 同梱アセットで日本語OCRワーカーを生成する（タイムアウト保護付き）。
 * すべてのアセット（worker/wasmコア/言語データ）は拡張機能に同梱したものを使う。
 * @param {"jpn"|"jpn_vert"} lang jpn=横書き / jpn_vert=縦書き
 * @param {(message: object) => void} [logger] 認識の進捗ログ
 * @returns {Promise<object>} Tesseract のワーカー
 */
function createOcrWorker(lang, logger) {
    const created = Tesseract.createWorker(lang, 1, {
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
        // （既定のままだと縦の行（列）分割が正しく行われない）
        if (lang === "jpn_vert") {
            await worker.setParameters({
                tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT
            });
        }
        return worker;
    });

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

/**
 * 組版方向ごとのワーカーを初回利用時に生成し、以降のOCRで使い回すプール。
 * offscreen（ページ内範囲選択）と capture（タブでの範囲選択）が同じ管理をしていたため共通化する。
 *
 * get はそのまま recognizeWithOrientation の workerProvider として渡せる。
 * @param {(message: object) => void} [logger] 認識の進捗ログ
 * @returns {{get: (lang: string) => Promise<object>, terminate: () => void}}
 */
function createOcrWorkerPool(logger) {
    const workerPromises = {};
    return {
        get(lang) {
            if (!workerPromises[lang]) {
                workerPromises[lang] = createOcrWorker(lang, logger).catch((err) => {
                    // 失敗したPromiseをキャッシュしない（次回のOCRで再試行できるようにする）
                    workerPromises[lang] = null;
                    throw err;
                });
            }
            return workerPromises[lang];
        },
        // ハングした可能性のあるワーカーを破棄し、次回のOCRで作り直させる
        // （ページ離脱時・認識タイムアウト時・一定時間の未使用時に呼ぶ）。
        terminate() {
            for (const lang of Object.keys(workerPromises)) {
                const promise = workerPromises[lang];
                workerPromises[lang] = null;
                if (promise) promise.then((worker) => worker.terminate()).catch(() => {});
            }
        }
    };
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

// 認識全体をこの時間に収めることを目標に、精錬（拡大再認識・二値化・融合・辞書リランク）の
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

/**
 * 本文パッチを横書き・縦書きの両モデルで認識し、確信度の高い方の向きを返す。
 * 画素の統計では分けられない中間帯でだけ呼ぶ（1回の認識が2つ増えるため）。
 * @returns {Promise<"horizontal"|"vertical"|null>} 判定できないときは null
 */
async function resolveOcrOrientation(grayCanvas, workerProvider) {
    try {
        const patch = pickOcrTextPatch(grayCanvas, OCR_ORIENTATION_PATCH_PX);
        if (!patch) return null;
        const horizontalWorker = await workerProvider("jpn");
        const verticalWorker = await workerProvider("jpn_vert");
        const h = await horizontalWorker.recognize(patch, {}, { text: true });
        const v = await verticalWorker.recognize(patch, {}, { text: true });
        return h.data.confidence >= v.data.confidence ? "horizontal" : "vertical";
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
    // blocks は文字サイズの実測、文字融合、辞書リランク、段落境界の推定に使う。
    const outputFields = { text: true, blocks: true };

    // 語彙辞書を一度だけ読み込む（任意。失敗しても従来動作）
    await ensureOcrDictionaries();

    // まずグレースケール化した元寸画像を作る（拡大・二値化はしない。
    // 明朝体等、強い前処理が裏目に出るフォントがあるため）
    const grayCanvas = toGrayscale(sourceCanvas);

    const detected = detectTextOrientation(sourceCanvas);
    let orientation = detected.orientation;
    if (!detected.confident) {
        // 画素の統計だけでは決められない範囲。本文の密な小領域を両方のモデルで
        // 認識し、確信度の高い方を採る（理由は OCR_ORIENTATION_SURE_* のコメント参照）。
        const resolved = await resolveOcrOrientation(grayCanvas, workerProvider);
        if (resolved) orientation = resolved;
    }
    const primaryLang = orientation === "vertical" ? "jpn_vert" : "jpn";

    const primaryWorker = await workerProvider(primaryLang);
    const startedAt = Date.now();
    const primary = await primaryWorker.recognize(grayCanvas, {}, outputFields);
    // 精錬1段のコストは元寸の認識1回分とほぼ同じ。予算に何回入るかを
    // 「元寸の所要時間から一度だけ」決め、以降は残り回数だけで判定する。
    // 段ごとに経過時間を見ると、そのときのマシン負荷で打ち切り位置が変わり、
    // 同じ選択なのに結果が変わってしまうため（過去に報告された不安定さの再発を防ぐ）。
    // ただし画面全体のような大きな入力では1段が7〜12秒かかり、1段でも走ると
    // 待ち時間が倍増して体感を大きく損なうため、面積で先に足切りする。
    const primaryMs = Math.max(1, Date.now() - startedAt);
    const sourceArea = grayCanvas.width * grayCanvas.height;
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
    if (best.confidence < OCR_PREPROCESS_SKIP_CONFIDENCE && canRefine()) {
        useRefine();
        const prepared = prepareOcrCanvas(sourceCanvas);
        if (prepared !== sourceCanvas) {
            const preprocessed = await primaryWorker.recognize(prepared, {}, outputFields);
            if (preprocessed.data.confidence >= best.confidence + OCR_PREPROCESS_ADOPT_MARGIN) {
                best = preprocessed.data;
            }
        }
    }

    // それでも明らかに低品質なときだけ、もう一方の組版方向も試す
    if (best.confidence < OCR_CONFIDENCE_ACCEPT) {
        const secondaryLang = primaryLang === "jpn" ? "jpn_vert" : "jpn";
        const secondaryWorker = await workerProvider(secondaryLang);
        const secondary = await secondaryWorker.recognize(grayCanvas, {}, outputFields);
        if (secondary.data.confidence > best.confidence) {
            best = secondary.data;
            bestLang = secondaryLang;
        }
    }

    // best.blocks から tesseract と同じ規則（単語=スペース・行=改行）でテキストを組み立てる。
    // best.text と内容は同一だが、後段の融合・辞書リランクが symbol.text を書き換えるため
    // blocks から組み直す（置換前は best.text をそのまま使うのと等価）。段落境界の「間」は
    // buildTextFromBlocks では付けず、後段の normalizeOcrText が行の内容から推定して補う。
    // 段落境界の推定には best を生んだ画像の座標系・組版方向を使う
    const bestOrientation = bestLang === "jpn_vert" ? "vertical" : "horizontal";
    const bestGlyphSize = estimateGlyphSizeFromBlocks(best.blocks, bestOrientation);
    let text = best.blocks
        ? buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize)
        : best.text;

    // 認識し直した拡大版を集める共通処理。予算（refinesLeft）と面積上限を守り、
    // 既に持っている2倍拡大版は予算を使わずに再利用する。
    const collectUpscaledVariants = async (scales) => {
        const others = [];
        for (const scale of scales) {
            const area = grayCanvas.width * scale * grayCanvas.height * scale;
            if (area > OCR_FUSION_MAX_AREA) continue;
            // 2倍拡大版は既に持っているので予算を使わずに再利用する。
            // （面積の判定を先に置いても結果は変わらない: 2倍拡大版が存在するのは
            //   元画像が OCR_REFINE_MAX_AREA 以下のときだけで、その4倍でも上限に届かない）
            if (scale === 2 && upscaled2x) { others.push(upscaled2x.blocks); continue; }
            if (!canRefine()) break;
            useRefine();
            const variant = await primaryWorker.recognize(upscaleOcrCanvas(grayCanvas, scale), {}, outputFields);
            others.push(variant.data.blocks);
        }
        return others;
    };

    // 文字単位アンサンブル融合。元寸grayが採用され、かつ文字がLSTM最適域を下回るときだけ、
    // 複数倍率の認識結果で低確信度の漢字を精錬する（詳細は OCR_FUSION_* のコメント参照）。
    if (best === primary.data && glyphSize != null && glyphSize < OCR_FUSION_TRIGGER_GLYPH_PX) {
        const others = await collectUpscaledVariants(OCR_FUSION_SCALES);
        if (others.length) {
            // 融合（低確信度の漢字を精錬）→ 辞書リランキング（残った非語を辞書語へ）の順に適用。
            // どちらかが置換したときだけ blocks からテキストを組み直す
            // （置換ゼロなら tesseract の出力をそのまま使い、挙動を変えない）。
            const fused = fuseOcrSymbols(best.blocks, others);
            const reranked = rerankOcrByDictionary(best.blocks, others);
            if (fused > 0 || reranked > 0) {
                text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize);
            }
        }
    } else if (best === primary.data && glyphSize != null
        && glyphSize >= OCR_FUSION_TRIGGER_GLYPH_PX
        && best.confidence < OCR_PREPROCESS_SKIP_CONFIDENCE) {
        // 文字が最適域以上のときは拡大しても精度が上がらないため融合は行わないが、
        // 最適域を狙った倍率で認識し直して辞書リランクの材料にする。
        // 実測では「覚悟→党悟」「鎌倉→鉄倉」のような一般語の誤りがこの領域で多発しており、
        // 従来はゲート（18px）に阻まれて一切補正されていなかった。
        const scales = [];
        const seen = new Set();
        for (const target of OCR_RERANK_TARGET_GLYPH_PX) {
            const scale = Math.round((target / glyphSize) * 100) / 100;
            if (scale === 1 || scale < 0.4 || scale > 3 || seen.has(scale)) continue;
            seen.add(scale);
            scales.push(scale);
        }
        const others = await collectUpscaledVariants(scales);
        // 確信度による漢字の融合はこの領域では悪化する（実測）ため行わないが、
        // 全会一致による置換は文字サイズによらず有効なので、そちらだけ適用する。
        const fused = others.length ? fuseOcrSymbols(best.blocks, others, { kanji: false }) : 0;
        // 2つ以上の倍率が同じ辞書語で一致したときだけ置換する（多数決の最低条件）
        const reranked = others.length >= 2 ? rerankOcrByDictionary(best.blocks, others) : 0;
        if (fused > 0 || reranked > 0) {
            text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize);
        }
    }

    // 複数倍率が同じ字形誤認を返すケースは多数決では救えないため、最後に辞書で一意に
    // 確定できる視覚的混同だけを補正する。追加のOCRは行わないので、高確信度で精錬を
    // 省略した入力にも適用でき、処理時間への影響は辞書検索だけに限られる。
    const visuallyCorrected = best.blocks
        ? correctOcrVisualConfusionsByDictionary(best.blocks) : 0;
    if (visuallyCorrected > 0) {
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
    const endsSentence = /[。．！？!?…]$/;
    const endsPunct = /[、，。．！？!?｡､：:；;]$/;
    const endsHiragana = /[ぁ-ゖ]$/;

    const normalized = rawText.replace(/[ \t　]+/g, " ").replace(spaceNextToCjk, "");

    const isBoundary = (prev, cur) => {
        if (bulletStart.test(cur)) return true;
        if (bulletStart.test(prev)) return true;
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
        if (blankBefore || isBoundary(prev, line)) {
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

/**
 * 読み上げ用の整形（content.js の cleanMessage と同等: URLの読み飛ばし・改行の空白化）。
 * 加えて、ダッシュ（――）の連続がOCRで縦棒・数字混じりに崩れたもの
 * （例: 「うわー|ー|1||っ」）を長音1つに正規化する。ダッシュ/長音を含む
 * 混合連続のみを対象とし、縦棒だけの並び（コード内の || 等）には触れない。
 * @param {string} text
 * @returns {string}
 */
function cleanForSpeech(text) {
    if (!text) return "";
    return text
        .replace(/https?:\/\/[\w\/:%#\$&\?\(\)~\.=\+\-]+/g, "URL省略")
        .replace(/[ー―—–−|｜lI1\/\\]{2,}/g, (run) => {
            const hasDash = /[―—–]/.test(run);
            const hasChoonAndBar = /ー/.test(run) && /[|｜\/\\]/.test(run);
            // ダッシュを含む連続、または長音と縦棒が混在する連続はOCR崩れとみなす。
            // 「サーバー1台」（ー1）やコードの「||」等はどちらの条件も満たさず変化しない。
            return (hasDash || hasChoonAndBar) ? "ー" : run;
        })
        .replace(/\n+/g, " ")
        .trim();
}
