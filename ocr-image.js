// OCRの画像前処理と組版方向の判定。
// offscreen.html（ページ内範囲選択のOCR）と capture.html（タブでの範囲選択のOCR）の
// 両方から使う。認識そのものは ocr-common.js が行う。
//
// 拡張機能ページ（extension_pages の CSP が適用されるコンテキスト）での実行を前提とする。

// ===== canvas の共通ヘルパー =====

/**
 * 指定サイズの canvas を作る。
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement}
 */
function createOcrCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

/**
 * 拡大・縮小に補間を効かせた canvas とその 2D コンテキストを作る。
 * @param {number} width
 * @param {number} height
 * @param {boolean} [willReadFrequently] CPU側で画素を読む用途なら true
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}}
 */
function createSmoothOcrCanvas(width, height, willReadFrequently = false) {
    const canvas = createOcrCanvas(width, height);
    const ctx = canvas.getContext("2d",
        willReadFrequently ? { willReadFrequently: true } : undefined);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return { canvas, ctx };
}

/**
 * canvas 全体の画素（RGBA）を読み出す。
 * @param {HTMLCanvasElement} canvas
 * @returns {Uint8ClampedArray}
 */
function readOcrCanvasPixels(canvas) {
    return canvas.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, canvas.width, canvas.height).data;
}

/**
 * 平均輝度から「インク（文字）が暗い側か明るい側か」を決める。
 * ダークモードの白抜き文字にも対応するため、固定のしきい値ではなく画像ごとに判断する。
 * @param {Uint8ClampedArray} pixels RGBA の画素列
 * @returns {{mean: number, darkInk: boolean}}
 */
function measureOcrInkPolarity(pixels) {
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
    }
    const mean = sum / (pixels.length / 4);
    return { mean, darkInk: mean >= 128 };
}

// ===== 切り出し・拡大・余白 =====

/**
 * 画像ソース（img要素・ImageBitmap等）の指定範囲を canvas に切り出す。
 * ここでは原寸のまま切り出し、認識精度向上のための前処理（拡大＋二値化）は
 * recognizeWithOrientation 内の prepareOcrCanvas で行う。
 */
function cropToOcrCanvas(source, sx, sy, sw, sh) {
    const canvas = createOcrCanvas(sw, sh);
    canvas.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
}

// Tesseract へ渡す認識入力で、インク（文字）と画像端の間に最低限確保する背景の余白（px）。
// Tesseract は文字が画像端に接すると行分割・文字認識が崩れる（公式 FAQ も 10px 程度の
// 余白を推奨）。ユーザーの範囲選択は文字の枠ぎりぎりをなぞることが多く、選択枠に列の
// 右端や行の上端が接した入力がそのまま認識に渡っていた。
// 実測（tools/ocr-e2e、2026-08-17）: 33入力をインク境界ぴったりに切り詰めた入力では
// 誤り合計 362→119（全33入力で改善・悪化0）で、余白付きの元画像（123）と同じ水準まで
// 回復する。一方、既に十分な余白（12〜36px）がある画像へさらに一律 10px を足すと、
// 出力が別の形で揺れて 1 入力で悪化した（msgo_neko_v_19 1→3）。そのため余白は一律に足す
// のではなく、辺ごとに「インクまでの距離がこの値に満たない分だけ」足す（既に余白がある
// 画像は無変更＝出力バイト一致）。余白は「認識に渡す画像」にだけ付け、組版方向の判定
// （detectTextOrientation / pickOcrTextPatch）と面積によるしきい値の判定は元の無余白画像で
// 行う（余白を先に付けると局所パッチの格子がずれ、大きな縦書き画像の方向が
// 変わって全滅する事故を実測: ms_body 4→236。当時の上限 40万px・パッチ 240px）。
const OCR_INPUT_PAD_PX = 10;

// 背景輝度の推定に使う、画像端からの画素の帯の幅（px）
const OCR_INPUT_PAD_SAMPLE_PX = 2;

// 背景輝度からこれ以上離れた画素を「インク」とみなす（余白の測定用。AA の縁の薄い画素は
// 数えず、文字の芯（白地の黒文字で差 150 以上、薄いグレー文字でも 80 以上）だけを拾う）
const OCR_INPUT_INK_CONTRAST = 40;

/**
 * 画像の背景輝度を、外周の画素の輝度ヒストグラムの最頻値で推定する。
 * 余白の目的は「画像端との連続性」なので、画像全体の多数派ではなく端の画素だけを見る
 * （写真・グラデーション・2色背景でも端に段差を作りにくい）。暗背景の白抜き文字にも
 * そのまま追従する。透明な画素（alpha < 255）は集計から外す。
 * @param {HTMLCanvasElement} canvas
 * @param {Uint8ClampedArray|null} [pixels] 同じcanvasから取得済みのRGBA画素
 * @returns {number} 0-255
 */
function estimateOcrBackgroundLuminance(canvas, pixels = null) {
    const width = canvas.width;
    const height = canvas.height;
    const sourcePixels = pixels || readOcrCanvasPixels(canvas);
    const hist = new Int32Array(256);
    const band = OCR_INPUT_PAD_SAMPLE_PX;
    const count = (x, y) => {
        const i = (y * width + x) * 4;
        if (sourcePixels[i + 3] < 255) return;
        hist[(0.299 * sourcePixels[i] + 0.587 * sourcePixels[i + 1]
            + 0.114 * sourcePixels[i + 2]) | 0]++;
    };
    for (let y = 0; y < height; y++) {
        if (y < band || y >= height - band) {
            for (let x = 0; x < width; x++) count(x, y);
            continue;
        }
        for (let x = 0; x < Math.min(band, width); x++) count(x, y);
        for (let x = Math.max(band, width - band); x < width; x++) count(x, y);
    }
    let best = 255;
    for (let l = 0; l < 256; l++) if (hist[l] > hist[best]) best = l;
    return best;
}

/**
 * 画像の各辺から、最も近いインク画素までの距離（px）を測る。
 * インクが無ければ各辺とも画像の幅/高さを返す。
 * @param {HTMLCanvasElement} canvas
 * @param {number} background 背景輝度（estimateOcrBackgroundLuminance）
 * @param {Uint8ClampedArray|null} [pixels] 同じcanvasから取得済みのRGBA画素
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
function measureOcrInkMargins(canvas, background, pixels = null) {
    const width = canvas.width;
    const height = canvas.height;
    const sourcePixels = pixels || readOcrCanvasPixels(canvas);
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (sourcePixels[i + 3] < 255) continue;
            const l = 0.299 * sourcePixels[i] + 0.587 * sourcePixels[i + 1]
                + 0.114 * sourcePixels[i + 2];
            if (Math.abs(l - background) < OCR_INPUT_INK_CONTRAST) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return { left: width, top: height, right: width, bottom: height };
    return { left: minX, top: minY, right: width - 1 - maxX, bottom: height - 1 - maxY };
}

/**
 * 認識入力の各辺に、指定した幅の背景色の余白を付ける。
 * 4辺とも 0 なら元の canvas をそのまま返す（無変更）。
 * @param {HTMLCanvasElement} source
 * @param {{left: number, top: number, right: number, bottom: number}} insets 各辺の余白（px）
 * @param {number} [background] 背景輝度（省略時は source から推定）
 * @returns {HTMLCanvasElement}
 */
function padOcrCanvas(source, insets, background = null) {
    const left = Math.max(0, Math.round(insets?.left || 0));
    const top = Math.max(0, Math.round(insets?.top || 0));
    const right = Math.max(0, Math.round(insets?.right || 0));
    const bottom = Math.max(0, Math.round(insets?.bottom || 0));
    if (left + top + right + bottom === 0) return source;
    const fill = Number.isFinite(background) ? background : estimateOcrBackgroundLuminance(source);
    const canvas = createOcrCanvas(source.width + left + right, source.height + top + bottom);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = `rgb(${fill},${fill},${fill})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, left, top);
    return canvas;
}

/**
 * インクと画像端の間に最低 minMargin px の背景を確保する（OCR_INPUT_PAD_PX のコメント参照）。
 * 既にその余白がある辺には何も足さない。全辺に余白があれば canvas は元のまま返る。
 * @param {HTMLCanvasElement} source
 * @param {number} minMargin
 * @returns {{canvas: HTMLCanvasElement, insets: {left: number, top: number, right: number, bottom: number}}}
 *   insets は各辺に足した余白（元の画像端が新しい canvas のどこにあるか）
 */
function padOcrCanvasToMargin(source, minMargin) {
    const none = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!(minMargin > 0)) return { canvas: source, insets: none };
    // 背景推定と余白測定は同じ全画面画素を使う。別々にgetImageDataすると、
    // 大きな選択範囲ほどCPU転送が重複し、Chromeのreadback警告も発生しやすい。
    const pixels = readOcrCanvasPixels(source);
    const background = estimateOcrBackgroundLuminance(source, pixels);
    const margins = measureOcrInkMargins(source, background, pixels);
    const insets = {
        left: Math.max(0, minMargin - margins.left),
        top: Math.max(0, minMargin - margins.top),
        right: Math.max(0, minMargin - margins.right),
        bottom: Math.max(0, minMargin - margins.bottom)
    };
    return { canvas: padOcrCanvas(source, insets, background), insets };
}

// 縦書きの選択範囲に混じる「本文列と直交する細いインクの帯」（書籍の柱＝ページ上部の
// 書名・章名、ページ番号、下端のノンブル）を認識前に背景で塗りつぶすためのしきい値。
//
// 縦書きページでは柱は本文列の上を横切るため、縦書きモデルは柱を列ごとに切り刻んで
// 各列の先頭へ1〜2文字ぶんの断片として出力する。断片は本文として読み上げられ、
// 「ホソ」「エイエイ」「ク」のような無意味な語が文の間に入る（実測: 新潮社の試し読み
// ページの右9列の選択で余剰8文字のうち4文字が柱の断片、全体の選択では9文字）。
// 柱そのものは横書きなので縦書きモデルでは読めておらず（実測: 柱16文字はどの倍率でも
// 出力に現れない）、塗りつぶしても読み上げから失われる文字は無い。
//
// 判定は「行ごとのインク量から帯を切り出し、主帯（最も高い帯）に対して十分に薄く、
// 主帯と明確に離れている帯」だけを対象にする。横書きの複数行テキストは帯が多数に
// なるため OCR_OUTLIER_BAND_MAX_BANDS で除外され、1行だけの選択は主帯しか無く
// 対象にならない（＝この処理は縦書きの本文ブロック＋柱の形にだけ発火する）。
const OCR_OUTLIER_BAND_MAX_RATIO = 0.25;
const OCR_OUTLIER_BAND_MIN_GAP_PX = 4;
const OCR_OUTLIER_BAND_MAX_BANDS = 4;
const OCR_OUTLIER_BAND_MAX_COUNT = 2;
// 主帯が入力の高さのこの割合以上を占めていなければ（＝本文ブロックが支配的でなければ）
// 何も塗らない
const OCR_OUTLIER_BAND_MAIN_MIN_RATIO = 0.4;
// 帯のインクの横幅が帯の高さのこの倍数以上であることを要求する。柱は本文列を横切って
// 伸びる（横幅≫高さ）が、縦に数文字だけ離れて置かれた縦書きの短い添え書きは
// 横幅が1文字ぶんしかないため対象外になる。
const OCR_OUTLIER_BAND_MIN_ASPECT = 3;

/**
 * 本文ブロックから外れた細いインクの帯（柱・ページ番号）を探す。
 * @param {HTMLCanvasElement} canvas グレースケール化・余白付与済みの認識入力
 * @returns {Array<{y0: number, y1: number}>} 塗りつぶす帯（無ければ空配列）
 */
function findOcrOutlierInkBands(canvas) {
    const width = canvas.width;
    const height = canvas.height;
    if (!(width > 0) || !(height > 0)) return [];
    const pixels = readOcrCanvasPixels(canvas);
    const { mean, darkInk } = measureOcrInkPolarity(pixels);
    const rowInk = new Int32Array(height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (pixels[i + 3] < 255) continue;
            const l = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            const ink = darkInk
                ? l < mean - OCR_INPUT_INK_CONTRAST : l > mean + OCR_INPUT_INK_CONTRAST;
            if (ink) rowInk[y]++;
        }
    }
    // インクのある行の連なりを帯にする（1〜2pxの隙間は同じ帯として繋げる）
    const bands = [];
    let start = -1;
    let lastInk = -1;
    for (let y = 0; y <= height; y++) {
        const hasInk = y < height && rowInk[y] > 0;
        if (hasInk) {
            if (start < 0) start = y;
            lastInk = y;
        } else if (start >= 0 && (y - lastInk > 2 || y === height)) {
            bands.push({ y0: start, y1: lastInk });
            start = -1;
        }
    }
    if (bands.length < 2 || bands.length > OCR_OUTLIER_BAND_MAX_BANDS) return [];
    let main = bands[0];
    for (const band of bands) {
        if (band.y1 - band.y0 > main.y1 - main.y0) main = band;
    }
    const mainHeight = main.y1 - main.y0 + 1;
    if (mainHeight < height * OCR_OUTLIER_BAND_MAIN_MIN_RATIO) return [];
    const outliers = [];
    for (const band of bands) {
        if (band === main) continue;
        const bandHeight = band.y1 - band.y0 + 1;
        const gap = band.y1 < main.y0 ? main.y0 - band.y1 : band.y0 - main.y1;
        if (bandHeight > mainHeight * OCR_OUTLIER_BAND_MAX_RATIO) return [];
        if (gap < OCR_OUTLIER_BAND_MIN_GAP_PX) return [];
        // 帯のインクが本文列を横切って伸びているか（柱かどうか）を横幅で確かめる
        let minX = width;
        let maxX = -1;
        for (let y = band.y0; y <= band.y1; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                if (pixels[i + 3] < 255) continue;
                const l = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
                const ink = darkInk
                    ? l < mean - OCR_INPUT_INK_CONTRAST : l > mean + OCR_INPUT_INK_CONTRAST;
                if (!ink) continue;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
        }
        if (maxX < 0 || (maxX - minX + 1) < bandHeight * OCR_OUTLIER_BAND_MIN_ASPECT) return [];
        outliers.push(band);
    }
    if (!outliers.length || outliers.length > OCR_OUTLIER_BAND_MAX_COUNT) return [];
    return outliers;
}

/**
 * 指定した帯（画像の全幅）を背景色で塗りつぶした canvas を返す。
 * 帯が無ければ元の canvas をそのまま返す（無変更）。
 * @param {HTMLCanvasElement} source
 * @param {Array<{y0: number, y1: number}>} bands
 * @param {number} [scale] source が bands の座標系から拡大されている場合の倍率
 * @param {number} [background] 背景輝度（省略時は source から推定）
 * @returns {HTMLCanvasElement}
 */
function fillOcrCanvasBands(source, bands, scale = 1, background = null) {
    if (!bands || !bands.length) return source;
    const fill = Number.isFinite(background) ? background : estimateOcrBackgroundLuminance(source);
    const canvas = createOcrCanvas(source.width, source.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);
    ctx.fillStyle = `rgb(${fill},${fill},${fill})`;
    for (const band of bands) {
        const y0 = Math.max(0, Math.floor(band.y0 * scale));
        const y1 = Math.min(source.height, Math.ceil((band.y1 + 1) * scale));
        if (y1 > y0) ctx.fillRect(0, y0, source.width, y1 - y0);
    }
    return canvas;
}

// 小さい文字の再認識用: canvas を高品質補間で拡大する（二値化はしない。
// 明朝体等では二値化が裏目に出るため、拡大のみの候補として確信度で競わせる）。
// 罫線・枠線（表の罫線、ボタンやカードの枠、リンクの下線）を認識前に消すためのしきい値。
//
// 横書きの worker は「1ブロックの横書き」（PSM=SINGLE_BLOCK）を仮定するため、全高を貫く
// 縦の罫線があると行分割そのものが破綻する。実測（2026-08-18、游ゴシック15pxの料金表
// 538x201）: 原画では確信度43・出力が無意味な記号列で、表の行ラベル「標準」「上位」が
// **丸ごと欠落**した。罫線を消すと確信度85、欠落なし。枠で囲んだボタンの中の
// 「キャンセル」も、枠を消して初めて認識結果に現れる（原画ではどのPSMでも出ない）。
//
// 文字の画と罫線は**長さ**で区別できる。1文字ぶんを超えて伸びる画は無いので、その画像に
// 実際に現れているインクの連なりの長さの分布から基準を作る（書体・文字寸・表示倍率に
// 依存しない）。長い連なりが1本も無い画像では**1画素も変えない**ので、罫線の無い文書の
// 出力は変わらない。
const OCR_RULE_LENGTH_RATIO = 3;
// 分布のどこを「その画像でいちばん長い普通の画」とみなすか。
// 上位10%（0.9）では短い画やアンチエイリアスの端点に引きずられて基準が小さくなりすぎ、
// 見出しのような大きい文字の横画まで罫線と誤判定した（実測: 26pxの見出しで
// 「機」→「北」、「方」が欠落）。1文字ぶんの画の長さを拾うため上位1%を見る。
const OCR_RULE_LENGTH_QUANTILE = 0.99;
// これより短い連なりは、分布がどうであれ罫線とみなさない（小さい画像での誤爆防止）
const OCR_RULE_MIN_LENGTH_PX = 24;
// 罫線の太さの上限。CSSの罫線は1〜2px、表示倍率1.5〜2でも3px程度に収まる。
// 太い画（大きな文字の横棒）を巻き込まないための上限でもある。
const OCR_RULE_MAX_THICKNESS_PX = 3;
// 長さの分布を数えるときの上限（これ以上は同じ階級にまとめる）
const OCR_RULE_LENGTH_HISTOGRAM_MAX = 512;
// 太さを測る点の数（連なりに沿って等間隔）。交点で太く見える場所を避けるため複数点で測る。
const OCR_RULE_THICKNESS_SAMPLES = 9;

/**
 * インクの有無を画素単位で表すマスクを作る。
 * @returns {{mask: Uint8Array, background: number}} background は塗り戻しに使う輝度
 */
function buildOcrInkMask(pixels, width, height) {
    const { mean, darkInk } = measureOcrInkPolarity(pixels);
    const mask = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        if (pixels[i + 3] < 255) continue;
        const l = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        const ink = darkInk
            ? l < mean - OCR_INPUT_INK_CONTRAST : l > mean + OCR_INPUT_INK_CONTRAST;
        if (ink) mask[p] = 1;
    }
    return { mask, background: darkInk ? 255 : 0 };
}

/**
 * インクの連なり（run）を走査する。horizontal なら行方向、そうでなければ列方向。
 * @param {(start: number, end: number, line: number) => void} onRun end は非包含
 */
function forEachOcrInkRun(mask, width, height, horizontal, onRun) {
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    for (let a = 0; a < outer; a++) {
        let start = -1;
        for (let b = 0; b <= inner; b++) {
            const ink = b < inner && mask[horizontal ? a * width + b : b * width + a];
            if (ink) {
                if (start < 0) start = b;
                continue;
            }
            if (start >= 0) {
                onRun(start, b, a);
                start = -1;
            }
        }
    }
}

/**
 * 表の罫線・枠線・下線を背景色で塗って消した canvas を返す。
 * 消す対象が1つも無ければ元の canvas をそのまま返す（無変更を保証する）。
 * @param {HTMLCanvasElement} canvas グレースケール化済みの認識入力
 * @returns {HTMLCanvasElement}
 */
function removeOcrRuleLines(canvas) {
    const width = canvas.width;
    const height = canvas.height;
    if (!(width > 1) || !(height > 1)) return canvas;
    const pixels = readOcrCanvasPixels(canvas);
    const { mask, background } = buildOcrInkMask(pixels, width, height);

    // 連なりの長さの分布（縦横をまとめて1つの分布として扱う。文字の画は縦横どちらも
    // 1文字ぶんを超えない）。
    const histogram = new Int32Array(OCR_RULE_LENGTH_HISTOGRAM_MAX + 1);
    let runCount = 0;
    const count = (start, end) => {
        histogram[Math.min(end - start, OCR_RULE_LENGTH_HISTOGRAM_MAX)]++;
        runCount++;
    };
    forEachOcrInkRun(mask, width, height, true, count);
    forEachOcrInkRun(mask, width, height, false, count);
    if (!runCount) return canvas;
    let seen = 0;
    let quantileLength = 1;
    const target = runCount * OCR_RULE_LENGTH_QUANTILE;
    for (let length = 0; length < histogram.length; length++) {
        seen += histogram[length];
        if (seen >= target) { quantileLength = Math.max(1, length); break; }
    }
    const minLength = Math.max(OCR_RULE_MIN_LENGTH_PX, quantileLength * OCR_RULE_LENGTH_RATIO);

    // 連なりの各所で直交方向にインクが何画素続くか＝その位置での太さ。
    const thicknessAt = (position, line, horizontal) => {
        let thickness = 1;
        if (horizontal) {
            for (let d = 1; line - d >= 0 && mask[(line - d) * width + position]; d++) thickness++;
            for (let d = 1; line + d < height && mask[(line + d) * width + position]; d++) thickness++;
        } else {
            for (let d = 1; line - d >= 0 && mask[position * width + (line - d)]; d++) thickness++;
            for (let d = 1; line + d < width && mask[position * width + (line + d)]; d++) thickness++;
        }
        return thickness;
    };
    // 太さは連なりに沿って何点か測り、その**最小**を使う。1点（中央）だけで測ると、
    // 罫線の交点や、罫線に文字が接している場所を引いたときに「太い」と誤判定して
    // その罫線が消え残る。消し残りの断片は縦棒 | として認識され、読み上げに混ざる
    // （実測: 中央1点だけの版では表の各セル区切りに | が出て誤りが増えた）。
    // 文字の画は全長にわたって太いので、最小をとっても細いと判定されることはない。
    const minThickness = (start, end, line, horizontal) => {
        let min = Infinity;
        for (let i = 1; i <= OCR_RULE_THICKNESS_SAMPLES; i++) {
            const position = start + Math.floor(((end - start) * i) / (OCR_RULE_THICKNESS_SAMPLES + 1));
            min = Math.min(min, thicknessAt(position, line, horizontal));
            if (min <= 1) break;
        }
        return min;
    };
    const doomed = new Uint8Array(width * height);
    let removed = 0;
    const mark = (horizontal) => (start, end, line) => {
        if (end - start < minLength) return;
        if (minThickness(start, end, line, horizontal) > OCR_RULE_MAX_THICKNESS_PX) return;
        for (let b = start; b < end; b++) {
            doomed[horizontal ? line * width + b : b * width + line] = 1;
            removed++;
        }
    };
    forEachOcrInkRun(mask, width, height, true, mark(true));
    forEachOcrInkRun(mask, width, height, false, mark(false));
    if (!removed) return canvas;

    const out = createOcrCanvas(width, height);
    const context = out.getContext("2d", { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let p = 0, i = 0; p < doomed.length; p++, i += 4) {
        if (!doomed[p]) continue;
        data[i] = background;
        data[i + 1] = background;
        data[i + 2] = background;
        data[i + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    return out;
}

function upscaleOcrCanvas(source, scale) {
    const { canvas, ctx } = createSmoothOcrCanvas(source.width * scale, source.height * scale);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
}

// canvas の一部を切り出しつつ拡大する（組版方向の追加判定用）。
function cropOcrCanvas(source, x, y, width, height, scale) {
    if (!(width > 0) || !(height > 0)) return null;
    const { canvas, ctx } = createSmoothOcrCanvas(
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)));
    ctx.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas;
}

// ===== グレースケール・二値化 =====

// グレースケール変換。Windows のサブピクセルAA（ClearType）で文字の輪郭に付く
// 色フリンジが濁点・半濁点の幻覚を誘発するため、認識前に輝度のみへ落とす。
// 実測でサブピクセルAAの明朝体は改善（86.3%→88.7%）、その他のフォント・描画方式では
// 精度変化なし（劣化ケースなし）を確認。
function toGrayscale(source) {
    const canvas = createOcrCanvas(source.width, source.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
        const l = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        pixels[i] = pixels[i + 1] = pixels[i + 2] = l;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

// 大津の方法でしきい値を求める（クラス間分散の最大化）。
// hist は輝度0-255のヒストグラム、n は総画素数。返り値は 0-255 のしきい値。
function computeOtsuThreshold(hist, n) {
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, threshold = 127;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = n - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sumAll - sumB) / wF;
        const v = wB * wF * (mB - mF) * (mB - mF);
        if (v > maxVar) { maxVar = v; threshold = t; }
    }
    return threshold;
}

// 認識前の画像前処理: 2倍拡大（補間）＋大津の二値化＋極性正規化（黒文字/白背景へ）。
// 補間拡大単体はにじみで精度が落ちるが（実測済み）、二値化で輪郭が再鮮鋭化される
// 組み合わせでは小さい文字の漢字誤認識が改善する。ただし効果はフォント依存で、
// ゴシック体では改善（縦書き14pxで92.9%→100%）する一方、明朝体は細い横画が
// 潰れて悪化（実画像で97.2%→93.3%）する。このため常時適用はせず、
// recognizeWithOrientation で「元画像の確信度が低いときの再試行」として使い、
// 確信度の高い方を採用する（確信度はこの選択で正しく序列した: 88/84, 82/90 等）。
// 写真背景等で二値化が破綻した場合（インク率が極端）は元画像をそのまま返す。
const OCR_PREPROCESS_MAX_AREA = 8400000; // 2倍拡大を許す上限画素数（FullHD の2倍相当）

function prepareOcrCanvas(source) {
    // 巨大な選択範囲は拡大せず等倍で二値化のみ行う（処理時間・メモリの保護）
    const scale = source.width * source.height * 4 <= OCR_PREPROCESS_MAX_AREA ? 2 : 1;
    const { canvas, ctx } = createSmoothOcrCanvas(
        source.width * scale, source.height * scale, true);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    const n = pixels.length / 4;
    const lum = new Uint8Array(n);
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
        const l = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) | 0;
        lum[j] = l;
        hist[l]++;
    }

    // 大津の方法でしきい値を決める（クラス間分散の最大化）
    const threshold = computeOtsuThreshold(hist, n);

    // 文字（インク）は少数派の側とみなし、黒文字・白背景に正規化する
    let darkCount = 0;
    for (let j = 0; j < n; j++) if (lum[j] < threshold) darkCount++;
    const darkIsInk = darkCount * 2 <= n;
    const inkRatio = (darkIsInk ? darkCount : n - darkCount) / n;
    // インク率が極端（ほぼ空白 or 写真等で塗り潰し状）なら二値化失敗として元画像を使う
    if (inkRatio < 0.002 || inkRatio > 0.4) return source;

    for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
        const isInk = darkIsInk ? lum[j] < threshold : lum[j] >= threshold;
        const v = isInk ? 0 : 255;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
        pixels[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

// ===== 組版方向の判定 =====

// 「本当に1行/1列」とみなす、インク帯の厚みの上限（文字の送りの何倍まで許すか）。
// 実測（縦書き/横書き・明朝/ゴシック・15〜24px の61枚）では、1行/2行の画像が
// 0.9〜1.1、複数行のページが 11.3〜41.7 と大きく離れており、その間に値は無い。
const OCR_SINGLE_LINE_THICKNESS_RATIO = 3;

// 「列方向の連続性 ÷ 行方向の連続性」の比で組版方向を推定するときの、確実に言い切れる境界。
// 実サイトの全画面キャプチャ（画像・サイドバー・広告が混在）は、写真やベタ塗りの
// ブロックが縦に長いインクとして効くため、本文が横書きでもこの比が 1.0 を超える。
// 一方、縦書きページから本文だけを切り出すと比が下がる。実測では
//   横書き … 0.39〜1.55（Yahoo 1.55 / Wikipedia 1.51 / 青空索引 1.51）
//   縦書き … 1.54〜2.56（MS明朝の本文切り出し 1.54 / 小説ビューア 2.16〜2.56）
// と**帯が重なっており、画素の統計だけでは分けられない**。
// そこで、確実な範囲だけをこの比で即決し、中間の帯に入ったときは
// 小～中規模は選択範囲全体、大画像は本文小領域を両モデルに掛けて決める。
const OCR_ORIENTATION_SURE_HORIZONTAL = 1.15; // これ以下なら横書きで確定
const OCR_ORIENTATION_SURE_VERTICAL = 1.8;    // これ以上なら縦書きで確定

// 中間帯の入力は、この画素数までは選択範囲全体を縦横2モデルで比較して決める
// （勝った側の認識結果は本文認識として再利用するので、追加コストは負けた側の1回分。
// 精錬（拡大・二値化）を許す上限 OCR_REFINE_MAX_AREA と同じ値にしてあり、精錬1段ぶんの
// 予算を方向の確定に使う）。これを超える全画面級は、縦横2モデルへ全体を同時投入すると
// 低コア端末のCPU・メモリを圧迫するため、文字密度が高い小領域だけで確認する。
// 実測（2026-08-17、ユーザー報告の小説ページを再現した 552x796=44万px の縦書き明朝20px・
// ルビ付き）: 旧上限 40万px を超えていたため 240px パッチで比較され、jpn 77 / jpn_vert 76 と
// 差が付かず横書きに倒れて全文が崩壊（CER 99%）。全体比較なら 72 / 87 で縦書きに決まる。
// 縦書き4枚・横書き5枚の全体比較は差 13〜58 で全て正しく、240px パッチは差 1〜14 で
// 4枚に1枚が誤る。
const OCR_ORIENTATION_FULL_COMPARE_MAX_AREA = 1200000;
// 全画面級で比較に使う小領域の一辺。240px では 20px 明朝の縦書きで縦横の差が 1 しか付かず
// 誤判定した（上記）。480px なら同じ入力で差 9〜18（縦書き6枚・横書き1枚とも正しい方向）。
// 認識コストは 240px の約4倍（実測 1〜1.5秒 → 4秒、2モデル並行）だが、全画面級は元寸の
// 認識だけで 7〜12 秒かかるため、方向を誤って全文が崩れるよりは待ち時間を優先しない。
const OCR_ORIENTATION_PATCH_PX = 480;

/**
 * 切り出した画像の組版方向（横書き/縦書き）をインクの分布から推定する。
 * 横書きは「行間の横方向の空白帯」、縦書きは「列間の縦方向の空白帯」が多く
 * 現れることを利用する。
 * 判定を誤っても、確信度による再認識フォールバックで救済される前提の軽量判定。
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{orientation: "vertical"|"horizontal", confident: boolean}}
 *   confident=false のときは呼び出し側で認識による確認（resolveOcrOrientation）を行う。
 */
function detectTextOrientation(canvas) {
    const width = canvas.width;
    const height = canvas.height;

    const data = readOcrCanvasPixels(canvas);
    const { mean, darkInk } = measureOcrInkPolarity(data);

    const rowInk = new Array(height).fill(0);
    const colInk = new Array(width).fill(0);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
            const isInk = darkInk ? lum < mean - 30 : lum > mean + 30;
            if (isInk) {
                rowInk[y]++;
                colInk[x]++;
            }
        }
    }

    // インクが連続する帯を数え、本数・中央ピッチ（帯の開始間隔）・最大の厚みを得る。
    const inkBands = (profile) => {
        let count = 0;
        let thick = 0;
        let start = -1;
        let prevStart = -1;
        const pitches = [];
        for (let i = 0; i <= profile.length; i++) {
            const on = i < profile.length && profile[i] > 0;
            if (on && start < 0) {
                start = i;
                if (prevStart >= 0) pitches.push(start - prevStart);
                prevStart = start;
            } else if (!on && start >= 0) {
                count++;
                if (i - start > thick) thick = i - start;
                start = -1;
            }
        }
        pitches.sort((a, b) => a - b);
        return { count, thick, pitch: pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0 };
    };
    const rowBands = inkBands(rowInk);
    const colBands = inkBands(colInk);

    // アスペクト比だけで決めてよいのは「本当に1行/1列」のときだけ。
    // ビューポート全体のキャプチャ（例 1920x950 ＝ 比2.0）は複数行/複数列なので、
    // 比で決め打ちすると縦書きページを必ず横書きと誤判定して読み上げが破綻する
    // （実測: 縦書き 1544x724 で CER 102.7%、横書き 444x960 で 99.1%）。
    // 1行/1列かどうかは、テキストの進行方向に直交する側（＝帯の本数が少ない側）の
    // インクの厚みが、進行方向の繰り返しピッチ（＝文字の送り）数個分に収まるかで見る。
    const minorIsRow = rowBands.count <= colBands.count;
    const minorThickness = minorIsRow ? rowBands.thick : colBands.thick;
    const advance = minorIsRow ? colBands.pitch : rowBands.pitch;
    if (advance > 0 && minorThickness <= advance * OCR_SINGLE_LINE_THICKNESS_RATIO) {
        // 1行の横書きと複数列の縦書きは投影プロファイルでは区別できないため、
        // この場合に限りアスペクト比で決める。
        if (height > width * 1.8) return { orientation: "vertical", confident: true };
        if (width > height * 1.8) return { orientation: "horizontal", confident: true };
    }

    // テキストの進行方向にはインクが長く連続する（横書き＝行に沿って横方向、
    // 縦書き＝列に沿って縦方向）。行/列プロファイルのピーク充填率
    // （その行/列の何割がインクか）を比較して方向を推定する。
    // 外れ値（罫線等）の影響を避けるため最大値ではなく上位5%点を使う。
    const peakFillRatio = (profile, denominator) => {
        const sorted = [...profile].sort((a, b) => b - a);
        const peak = sorted[Math.floor(sorted.length * 0.05)] || 0;
        return peak / denominator;
    };

    const rowPeak = peakFillRatio(rowInk, width);   // 高ければ横書き（行方向に連続）
    const colPeak = peakFillRatio(colInk, height);  // 高ければ縦書き（列方向に連続）
    const ratio = colPeak / (rowPeak || 1e-9);
    if (ratio <= OCR_ORIENTATION_SURE_HORIZONTAL) return { orientation: "horizontal", confident: true };
    if (ratio >= OCR_ORIENTATION_SURE_VERTICAL) return { orientation: "vertical", confident: true };
    // 中間帯。暫定値は返すが、呼び出し側で認識による確認を行う。
    return { orientation: ratio > 1.5 ? "vertical" : "horizontal", confident: false };
}

/**
 * 大画像の方向確認用に、文字らしい領域を1か所だけ小さく切り出す。
 * 小さいキャプチャでは使わず、選択範囲全体の比較を優先する。
 * 「インクの切り替わりが多い」＝文字。写真やベタ塗りは切り替わりが少なく、
 * インク率も極端になるので除外できる。
 * @param {HTMLCanvasElement} canvas
 * @param {number} size 切り出す正方形の一辺（画素）
 * @returns {HTMLCanvasElement|null} 文字らしい場所が無ければ null
 */
function pickOcrTextPatch(canvas, size) {
    const width = canvas.width;
    const height = canvas.height;
    const data = readOcrCanvasPixels(canvas);
    const { mean, darkInk } = measureOcrInkPolarity(data);

    const cell = 40;
    const gw = Math.max(1, Math.floor(width / cell));
    const gh = Math.max(1, Math.floor(height / cell));
    const score = new Float64Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
            let transitions = 0;
            let ink = 0;
            // 2行おきに走査して計算量を抑える（傾向を見るだけなので十分）
            for (let y = gy * cell; y < Math.min((gy + 1) * cell, height); y += 2) {
                let prev = false;
                for (let x = gx * cell; x < Math.min((gx + 1) * cell, width); x++) {
                    const i = (y * width + x) * 4;
                    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    const cur = darkInk ? lum < mean - 30 : lum > mean + 30;
                    if (cur !== prev) transitions++;
                    if (cur) ink++;
                    prev = cur;
                }
            }
            const ratio = ink / (cell * cell / 2);
            score[gy * gw + gx] = (ratio > 0.03 && ratio < 0.6) ? transitions : 0;
        }
    }

    const pw = Math.min(size, width);
    const ph = Math.min(size, height);
    const cw = Math.max(1, Math.round(pw / cell));
    const ch = Math.max(1, Math.round(ph / cell));
    let bestX = 0, bestY = 0, bestScore = -1;
    for (let gy = 0; gy + ch <= gh; gy++) {
        for (let gx = 0; gx + cw <= gw; gx++) {
            let s = 0;
            for (let j = 0; j < ch; j++) {
                for (let i = 0; i < cw; i++) s += score[(gy + j) * gw + gx + i];
            }
            if (s > bestScore) { bestScore = s; bestX = gx * cell; bestY = gy * cell; }
        }
    }
    if (bestScore <= 0) return null; // 文字らしい場所が見つからない
    return cropOcrCanvas(canvas, Math.min(bestX, Math.max(0, width - pw)),
        Math.min(bestY, Math.max(0, height - ph)), pw, ph, 1);
}
