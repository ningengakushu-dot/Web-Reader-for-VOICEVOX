// OCR共通処理:
// offscreen.html（ページ内範囲選択のOCR）と capture.html（タブでの範囲選択のOCR）の
// 両方から使う Tesseract.js ワーカー生成・画像切り出し・テキスト整形。
// 拡張機能ページ（extension_pages の CSP が適用されるコンテキスト）での実行を前提とする。

// OCRエンジン初期化のタイムアウト。アセット読み込み失敗時に createWorker が
// 解決も拒否もされないケースがあるため（tesseract.js v6 の既知の挙動）、
// 待ちっぱなしを防ぐ。
const OCR_WORKER_INIT_TIMEOUT_MS = 30000;

// OCR認識本体のタイムアウト。worker.recognize が返らない（極端な入力・WASM異常）ときに
// 進捗トーストや「実行中」表示が残り続けないよう、呼び出し側でこの時間で打ち切る。
const OCR_RECOGNIZE_TIMEOUT_MS = 60000;

// Promise をタイムアウト付きで待つ。超過時は isOcrTimeout 目印付きの Error で reject する
// （呼び出し側がタイムアウトとその他の失敗を区別し、ハングしたワーカーを破棄できるようにする）。
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


// 検出した組版方向での認識確信度がこの値を下回った場合のみ、もう一方の方向でも
// 認識を試して確信度の高い方を採用する。値を低め（55）に設定しているのは、
// 確信度が組版方向をまたいで比較できない（誤った方向でも高確信度になり得る）ため。
// 縦書きの正しい認識は確信度が控えめ（60〜75程度）に出ることが多く、これを安易に
// 横書きへ切り替えると縦書き文をバラバラに誤読した結果を掴む。基本は組版方向の
// 判定を信頼し、明確に低品質なときだけ再判定する。
const OCR_CONFIDENCE_ACCEPT = 55;

// 同梱アセットで日本語OCRワーカーを生成する（タイムアウト保護付き）。
// lang は "jpn"（横書き）または "jpn_vert"（縦書き）。
// すべてのアセット（worker/wasmコア/言語データ）は拡張機能に同梱したものを使う。
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

// 画像ソース（img要素・ImageBitmap等）の指定範囲を canvas に切り出す。
// ここでは原寸のまま切り出し、認識精度向上のための前処理（拡大＋二値化）は
// recognizeWithOrientation 内の prepareOcrCanvas で行う。
function cropToOcrCanvas(source, sx, sy, sw, sh) {
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
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
// 信用できる範囲の改善は下の文字単位融合（正しい文字を壊さない）に任せる。
// 実測: 壊滅的な領域（文字10px・元寸CER24%）では元寸の確信度が58程度まで落ちるため、
// 75 を境にすると壊滅ケースの救済（CER 24.31%→2.55%）は保ったまま上書き事故を防げる。
const OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE = 75;

// ルビ除去が有効なときの、全文乗り換えを許す元寸側の確信度の上限（通常より厳しくする）。
// ルビ判定は「行の bbox が本文より細いか」という幾何に依存するが、拡大版や二値化版へ
// 乗り換えるとこの幾何が崩れる（実測: 元寸なら ルビ8px / 本文17px と明確に分かれるのに、
// 2倍拡大版では ルビ31px / 本文34px とほぼ同幅になり判定不能。結果ルビが読み上げに混入）。
// そのためルビ除去時は元寸の結果を保ち、精度改善は幾何を変えない文字単位融合に任せる。
// 実測: この値を60にすると、狭い選択でもルビ除去に成功しつつ、極小文字の救済も
// 融合が肩代わりして維持される（para1@0.55倍 CER 3.9%。乗り換えを完全に禁止すると
// 二値化版が採用されて 21.6% まで悪化するため、下限としての乗り換えは残す）。
const OCR_RUBY_SWAP_MAX_BASE_CONFIDENCE = 60;

// もう一方の組版方向へ乗り換えるために必要な確信度の上積み。
// 小さい選択範囲では正しい方向でも確信度が低く出やすく（実測: 縦書き3文字の
// 「親譲り」で正解でも34〜44）、単純比較だと誤方向のゴミ（横書きモデルの「限てり」
// 確信度39等）に拮抗負けして採用されることがある。方向誤判定の壊滅ケースは
// 大差が付く（実測: 誤方向53に対し正方向84）ため、マージン10でも確実に救済され、
// 拮抗時は組版方向の判定結果を信頼する。
const OCR_ORIENTATION_SWITCH_MARGIN = 10;

// グレースケール変換。Windows のサブピクセルAA（ClearType）で文字の輪郭に付く
// 色フリンジが濁点・半濁点の幻覚を誘発するため、認識前に輝度のみへ落とす。
// 実測でサブピクセルAAの明朝体は改善（86.3%→88.7%）、その他のフォント・描画方式では
// 精度変化なし（劣化ケースなし）を確認。
function toGrayscale(source) {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const p = imageData.data;
    for (let i = 0; i < p.length; i += 4) {
        const l = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
        p[i] = p[i + 1] = p[i + 2] = l;
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

function prepareOcrCanvas(source) {
    // 巨大な選択範囲は拡大せず等倍で二値化のみ行う（処理時間・メモリの保護）
    const scale = source.width * source.height * 4 <= OCR_PREPROCESS_MAX_AREA ? 2 : 1;
    const canvas = document.createElement("canvas");
    canvas.width = source.width * scale;
    canvas.height = source.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const p = imageData.data;
    const n = p.length / 4;
    const lum = new Uint8Array(n);
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
        const l = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) | 0;
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

    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
        const isInk = darkIsInk ? lum[j] < threshold : lum[j] >= threshold;
        const v = isInk ? 0 : 255;
        p[i] = p[i + 1] = p[i + 2] = v;
        p[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

// 【未使用（実験実装）】現在この関数はどの認識経路（recognizeWithOrientation / offscreen /
// capture）からも呼ばれていない。結線には実測（CER評価）が必須で、憶測での結線は禁止する。
// 理由: 幾何の trim/snap は、既に OCR_PREPROCESS_ADOPT_MARGIN=3 で解決済みの「選択の数pxで
// 結果がフリップする不安定さ」と同じ軸に触れて再燃させ得るうえ、境界断片除去が本文の端文字を
// 落とすリスクもある。実測ハーネス再構築後に CER で評価してから結線可否を判断すること。
// 選択範囲の正規化: 手動ドラッグの数pxのブレを吸収する。
// 選択内のインク（文字）の外接矩形にスナップし、選択境界で切れた文字の断片
// （境界に接する薄いインク帯）を除去したうえで、背景色の余白を付けて返す。
// - 同じ文字列を狙った選択が数pxずれても同一の入力画像に収束するため、
//   認識結果が安定する（同一入力への認識は決定的であることを実測済み。
//   逆に数pxずれた入力は「譲/談/護」のように別の文字へ揺れることも実測済み）
// - 境界ぎりぎりの文字は認識精度が落ちるため、余白の付加は Tesseract 公式の
//   推奨でもある（実測: 右端に「(」を幻覚するケースが余白付加で消えた）
// - インク率が極端（ほぼ空白・写真等）でしきい値分離が信頼できない場合は
//   元の canvas をそのまま返す（誤ったトリムで本文を失わないための安全弁）
const OCR_SNAP_MARGIN_PX = 12;

function normalizeSelectionCanvas(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w < 4 || h < 4) return canvas;
    const srcCtx = canvas.getContext("2d");
    const p = srcCtx.getImageData(0, 0, w, h).data;

    const n = w * h;
    const lum = new Uint8Array(n);
    const hist = new Array(256).fill(0);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
        const l = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) | 0;
        lum[j] = l;
        hist[l]++;
    }

    // 大津の方法でインク/背景を分離（prepareOcrCanvas と同じ手順）
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

    let darkCount = 0;
    let darkSum = 0, lightSum = 0;
    for (let j = 0; j < n; j++) {
        if (lum[j] < threshold) { darkCount++; darkSum += lum[j]; } else { lightSum += lum[j]; }
    }
    const darkIsInk = darkCount * 2 <= n;
    const inkRatio = (darkIsInk ? darkCount : n - darkCount) / n;
    if (inkRatio < 0.002 || inkRatio > 0.5) return canvas;

    // 余白に使う背景色 = 背景クラスの平均輝度（ダークモードの黒背景にも追従）
    const bgCount = darkIsInk ? n - darkCount : darkCount;
    const bgMean = Math.round((darkIsInk ? lightSum : darkSum) / Math.max(1, bgCount));

    // 行・列のインクプロファイル
    const rowInk = new Array(h).fill(0);
    const colInk = new Array(w).fill(0);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const isInk = darkIsInk ? lum[y * w + x] < threshold : lum[y * w + x] >= threshold;
            if (isInk) { rowInk[y]++; colInk[x]++; }
        }
    }

    // プロファイルのインク帯（>0 の連続区間）から範囲を決める。
    // 選択境界に接し、かつ帯サイズの中央値の半分未満の帯は「境界で切れた文字の
    // 断片」とみなして除去する（帯が2つ以下のときは情報不足のため除去しない）。
    const trimAxis = (profile) => {
        const bands = [];
        let start = -1;
        for (let i = 0; i < profile.length; i++) {
            if (profile[i] > 0 && start < 0) start = i;
            if (profile[i] === 0 && start >= 0) { bands.push([start, i - 1]); start = -1; }
        }
        if (start >= 0) bands.push([start, profile.length - 1]);
        if (!bands.length) return null;
        if (bands.length >= 3) {
            const sizes = bands.map(([a, b]) => b - a + 1).sort((x, y) => x - y);
            const median = sizes[Math.floor(sizes.length / 2)];
            while (bands.length > 1 && bands[0][0] === 0 && (bands[0][1] - bands[0][0] + 1) < median * 0.5) {
                bands.shift();
            }
            const last = () => bands[bands.length - 1];
            while (bands.length > 1 && last()[1] === profile.length - 1 && (last()[1] - last()[0] + 1) < median * 0.5) {
                bands.pop();
            }
        }
        return [bands[0][0], bands[bands.length - 1][1]];
    };

    const ySpan = trimAxis(rowInk);
    const xSpan = trimAxis(colInk);
    if (!ySpan || !xSpan) return canvas;

    const bw = xSpan[1] - xSpan[0] + 1;
    const bh = ySpan[1] - ySpan[0] + 1;
    const out = document.createElement("canvas");
    out.width = bw + OCR_SNAP_MARGIN_PX * 2;
    out.height = bh + OCR_SNAP_MARGIN_PX * 2;
    const ctx = out.getContext("2d");
    ctx.fillStyle = `rgb(${bgMean}, ${bgMean}, ${bgMean})`;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, xSpan[0], ySpan[0], bw, bh, OCR_SNAP_MARGIN_PX, OCR_SNAP_MARGIN_PX, bw, bh);
    return out;
}

// --- 文字単位アンサンブル融合 ---
// 同じ選択範囲でも、ドラッグの数pxの違いで縮小時のサブピクセル位相が変わり、
// 同じ漢字が「核/校/枝/槻」のように揺れる（実測: 同一箇所で正答率31%）。
// このとき、ページ全体の確信度では正誤を判別できない（正解92 / 誤り90と拮抗）が、
// 文字単位の確信度は明確に差が出る（実測: 正解「核」88〜96 / 誤り「校」54〜88）。
// さらに倍率を変えると弱点の位置が変わり、どれかの倍率が高確信度で正解を出す。
// そこで複数倍率の認識結果を文字単位で整列し、低確信度の漢字だけを
// 「確信度の合計」が上回る文字へ置き換える（音声認識のROVER方式に相当）。
// 実測（カクヨム明朝・選択位置を±3pxずらした13ケース×各縮小率）:
//   0.95倍 正答 7/13→11/13, CER 0.53%→0.15% / 0.85倍 4/13→9/13, 0.75%→0.30%
//   0.80倍 5/13→8/13, 1.21%→0.53% / 全群で悪化ゼロ。
// 適用は「元寸grayが採用され、かつ文字がLSTM最適域(20〜30px)を下回る」ときだけ。
// 文字が十分大きいと拡大版の方が誤りやすく、逆効果になるため（実測: MS明朝19px で
// 正しい「譲」が拡大版の「談」で上書きされ悪化。このゲートで解消）。
const OCR_FUSION_TRIGGER_GLYPH_PX = 18;
// この確信度未満の文字だけを置換対象にする
const OCR_FUSION_MIN_CONFIDENCE = 88;
// 融合に使う拡大倍率（2倍は上の再認識で得た結果を再利用する）
const OCR_FUSION_SCALES = [1.5, 2, 3];

// 融合ゲート（18px）より大きい文字でも、辞書リランクだけは走らせる。そのときの
// 変換先の文字サイズ（Tesseract LSTM の最適域 20-30px を狙う）。
// 実測では一般的なWebページの文字は 22〜39px で、従来はどの補正も発火していなかった
// （24枚中5枚のみ発火）。融合と違い辞書リランクは「非辞書語」かつ「2つ以上の倍率が
// 同じ辞書語で一致」のときしか置換しないため、この領域でも安全側に働く
// （実測: 26枚で改善6・悪化0）。
const OCR_RERANK_TARGET_GLYPH_PX = [20, 24, 30];

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
// 拡大後の画素数の上限（巨大な選択範囲で時間とメモリを浪費しないための保護）
const OCR_FUSION_MAX_AREA = 8400000;

// ===== 語彙辞書（リランキング用） =====
// SudachiDict(Apache-2.0) から抽出した高頻度の語（2-4字・漢字含む内容語）。
// 融合候補が「非語」か「辞書語」かの判定に使い、OCRの誤字で意味の通らない
// 熟語になった箇所を、複数倍率の認識結果の中の辞書語へ補正する（rerankOcrByDictionary）。
// 「任意」。取得に失敗しても従来動作を完全に保つ（機能を素通りさせる）。
let ocrWordSet = null;
let ocrDictionaryPromise = null;

// 拡張機能の同梱ファイルを一度だけ読み込む。offscreen/capture の拡張ページからは
// chrome.runtime.getURL で自分の同梱リソースを fetch できる（web_accessible_resources 不要）。
async function ensureOcrDictionaries() {
    if (ocrWordSet) return;
    if (ocrDictionaryPromise) return ocrDictionaryPromise;
    ocrDictionaryPromise = (async () => {
        try {
            if (typeof fetch === "undefined" || typeof chrome === "undefined"
                || !chrome.runtime || !chrome.runtime.getURL) return;
            const wordsText = await fetch(chrome.runtime.getURL("ocr-words.txt")).then((r) => r.text());
            ocrWordSet = new Set(wordsText.split("\n").filter(Boolean));
        } catch (error) {
            // 辞書は任意機能。失敗しても以降は素通りする
            ocrWordSet = ocrWordSet || new Set();
        }
    })();
    return ocrDictionaryPromise;
}

// テスト用に辞書を直接注入する（Node ハーネスから利用）。
function setOcrDictionaries(wordSet) {
    if (wordSet) ocrWordSet = wordSet;
}

// blocks から {symbol, word} の並びを取り出す（symbol を書き換えたときに
// 親 word のテキストも再構成できるように word を持たせる）
function collectOcrSymbols(blocks) {
    const out = [];
    for (const block of (blocks || [])) {
        for (const par of (block.paragraphs || [])) {
            for (const line of (par.lines || [])) {
                for (const word of (line.words || [])) {
                    for (const symbol of (word.symbols || [])) out.push({ symbol, word });
                }
            }
        }
    }
    return out;
}

// 段落の最終行を行の幾何から見分けるためのしきい値（文字サイズの何倍手前で
// 終わっていれば段落末とみなすか）。日本語の本文は行末（縦書きなら列の下端、
// 横書きなら行の右端）が揃うため、明らかに手前で終わる行は段落の最後といえる。
const OCR_PARAGRAPH_END_RATIO = 1.5;

// 段落の切れ目に空行を差し込む。空行は normalizeOcrText が明示的な段落境界として
// 扱い、読み上げに「間」を入れる（文字自体は変えない）。
// 実測（実ページを描画した24枚・段落境界60箇所）で 適合率100% / 再現率96.7%。
// 従来は行の幾何をまったく使っておらず、見出しと本文が続けて読まれていた。
function markOcrParagraphBreaks(items, orientation, glyphSize) {
    const texts = items.map((item) => item.text);
    if (items.length < 2 || !(glyphSize > 0)) return texts;
    const endOf = (bbox) => (orientation === "vertical" ? bbox.y1 : bbox.x1);
    let blockEnd = -Infinity;
    for (const item of items) {
        if (item.bbox) blockEnd = Math.max(blockEnd, endOf(item.bbox));
    }
    if (!isFinite(blockEnd)) return texts;
    const out = [];
    for (let i = 0; i < items.length; i++) {
        out.push(items[i].text);
        const bbox = items[i].bbox;
        if (i < items.length - 1 && bbox
            && blockEnd - endOf(bbox) > glyphSize * OCR_PARAGRAPH_END_RATIO) out.push("");
    }
    return out;
}

// ===== 漫画モード：コマの読み順に並べ替える =====
//
// 漫画は「右上のコマから左下のコマへ、コマの中では右上の吹き出しから左下へ、
// 吹き出しの中では右の列から左の列へ」という順で読む。Tesseract は紙面の
// レイアウトを知らないため、この順序では出力してくれない。文字認識そのものは
// 正しくても、並びが崩れると台詞が入れ替わって意味が通らなくなる。
//
// 解き方は、紙面を余白で再帰的に切り分ける方法（XY-cut）を漫画の向きに合わせたもの。
//   1. 全体を横切る横方向の余白があれば、そこで上下に切り、上を先に読む（コマの段）
//   2. なければ縦方向の余白で左右に切り、右を先に読む（同じ段の中のコマ）
//   3. どちらの余白も無ければ同じ吹き出しの中なので、縦書きなら右の列から読む
// 余白は常に「最も広いところ」で切るため、コマの間 → 吹き出しの間 → 列の間、と
// 大きい構造から順に分かれていく。

// ===== 吹き出しの検出 =====
//
// 漫画のページは面積の大半が絵で、文字は吹き出しの中にしかない。ページ全体を
// そのまま文字認識にかけると、髪・トーン・輪郭線から実在しない文字が作られる
// （実機で「ずっと謎の発音をする」状態になった）。
//
// 吹き出しと説明の枠は「線で囲まれた白い領域」として現れる。紙の白を連結成分と
// して数え上げ、外周に接しない・つぶれていない・中に文字らしい黒がある成分だけを
// 取り出せば、絵を読ませずに済む。
const OCR_MANGA_BALLOON_SCAN_MAX = 1000;   // 走査用に縮小する長辺の画素数
const OCR_MANGA_BALLOON_PAPER_LUM = 128;   // これ以上の輝度を紙（白）とみなす
const OCR_MANGA_BALLOON_MIN_SIDE = 12;     // 吹き出しと認める最小の辺（走査画像）
const OCR_MANGA_BALLOON_MAX_AREA = 0.4;    // 画面に対する面積の上限（背景の白を除く）
const OCR_MANGA_BALLOON_MIN_FILL = 0.5;    // 外接矩形に対する白の占有率の下限
const OCR_MANGA_BALLOON_MIN_INK = 0.02;    // 中の黒（文字）の割合の下限
const OCR_MANGA_BALLOON_MAX_INK = 0.6;     // 同上限（黒すぎる＝絵）
const OCR_MANGA_BALLOON_MAX_COUNT = 40;    // これを超えたら検出失敗とみなす
const OCR_MANGA_BALLOON_PAD = 3;           // 切り出しに付ける余白（走査画像）
const OCR_MANGA_BALLOON_MIN_GLYPHS = 2;    // 吹き出しと認めるのに必要な文字の数
const OCR_MANGA_BALLOON_MAX_OVERLAP = 0.5; // これ以上重なる候補は同じ吹き出しとみなす

function rectArea2(b) { return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0); }

// 白い領域の中身が「文字」かどうかを見る。
//
// 絵の線が囲んだ白い隙間も「線で囲まれた白」なので候補に挙がってしまう
// （実測: 1ページで真の吹き出し7個に対し誤検出が13個）。文字は、大きさの揃った
// 塊がいくつも並ぶという際立った性質を持つので、そこで見分ける。
// 絵の線は細長い塊になり、網点は小さすぎるため、どちらも文字とは見なされない。
const OCR_MANGA_GLYPH_MIN_RATIO = 0.10; // 短辺に対する文字の最小の大きさ
const OCR_MANGA_GLYPH_MAX_RATIO = 0.75; // 同 最大
const OCR_MANGA_GLYPH_MIN_FILL = 0.15;  // 外接矩形に対する黒の占有率（細い線を除く）
const OCR_MANGA_GLYPH_MAX_ASPECT = 4;   // 縦横比（細長い線を除く）

function countMangaGlyphs(paper, W, box, limit) {
    const inset = 2;
    const x0 = box.x0 + inset;
    const y0 = box.y0 + inset;
    const x1 = box.x1 - inset;
    const y1 = box.y1 - inset;
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw < 4 || bh < 4) return 0;
    const short = Math.min(bw, bh);
    const minSide = Math.max(2, short * OCR_MANGA_GLYPH_MIN_RATIO);
    const maxSide = short * OCR_MANGA_GLYPH_MAX_RATIO;
    const seen = new Uint8Array(bw * bh);
    const stack = new Int32Array(bw * bh);
    let glyphs = 0;
    for (let s = 0; s < seen.length; s++) {
        if (seen[s]) continue;
        const sx = s % bw;
        const sy = (s - sx) / bw;
        if (paper[(y0 + sy) * W + (x0 + sx)]) { seen[s] = 1; continue; }
        let top = 0;
        stack[top++] = s;
        seen[s] = 1;
        let gx0 = sx, gy0 = sy, gx1 = sx + 1, gy1 = sy + 1, area = 0;
        let touches = false;
        while (top > 0) {
            const at = stack[--top];
            const x = at % bw;
            const y = (at - x) / bw;
            area++;
            if (x < gx0) gx0 = x;
            if (y < gy0) gy0 = y;
            if (x >= gx1) gx1 = x + 1;
            if (y >= gy1) gy1 = y + 1;
            // 外周に接する黒は吹き出しの輪郭線であり、文字ではない
            if (x === 0 || y === 0 || x === bw - 1 || y === bh - 1) touches = true;
            const push = (nx, ny) => {
                if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) return;
                const ni = ny * bw + nx;
                if (seen[ni] || paper[(y0 + ny) * W + (x0 + nx)]) return;
                seen[ni] = 1;
                stack[top++] = ni;
            };
            push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
        }
        if (touches) continue;
        const gw = gx1 - gx0;
        const gh = gy1 - gy0;
        if (gw < minSide && gh < minSide) continue;
        if (gw > maxSide || gh > maxSide) continue;
        if (area < gw * gh * OCR_MANGA_GLYPH_MIN_FILL) continue;
        if (gw > gh * OCR_MANGA_GLYPH_MAX_ASPECT || gh > gw * OCR_MANGA_GLYPH_MAX_ASPECT) continue;
        glyphs++;
        if (glyphs >= limit) break;
    }
    return glyphs;
}

// 画像を縮小し、紙（白）と絵・文字（黒）の2値配列を作る
function toMangaScanMask(canvas, maxSide) {
    const w = canvas.width;
    const h = canvas.height;
    if (!(w > 0 && h > 0)) return null;
    // 縮小に canvas の平均化を使うと、吹き出しやコマの枠線（1〜2画素）が薄まって
    // 消え、囲いが破れて白がつながってしまう。区画内の最も暗い画素を残す縮小に
    // することで、細い線が残る。
    let data;
    try {
        const src = document.createElement("canvas");
        src.width = w;
        src.height = h;
        const sctx = src.getContext("2d", { willReadFrequently: true });
        sctx.drawImage(canvas, 0, 0);
        data = sctx.getImageData(0, 0, w, h).data;
    } catch (e) {
        return null;
    }
    const step = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
    const W = Math.max(1, Math.ceil(w / step));
    const H = Math.max(1, Math.ceil(h / step));
    const lum = new Uint8Array(W * H).fill(255);
    for (let y = 0; y < h; y++) {
        const oy = ((y / step) | 0) * W;
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            const v = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
            const at = oy + ((x / step) | 0);
            if (v < lum[at]) lum[at] = v;
        }
    }
    return { lum, W, H, scale: 1 / step };
}

// 吹き出し・説明枠の矩形を元画像の座標で返す。見つからなければ null。
function detectMangaBalloons(canvas) {
    const scan = toMangaScanMask(canvas, OCR_MANGA_BALLOON_SCAN_MAX);
    if (!scan) return null;
    const { lum, W, H, scale } = scan;
    const paper = new Uint8Array(W * H);
    for (let i = 0; i < paper.length; i++) paper[i] = lum[i] >= OCR_MANGA_BALLOON_PAPER_LUM ? 1 : 0;

    const label = new Int32Array(W * H).fill(-1);
    const stack = new Int32Array(W * H);
    const boxes = [];
    const maxArea = W * H * OCR_MANGA_BALLOON_MAX_AREA;

    for (let seed = 0; seed < paper.length; seed++) {
        if (!paper[seed] || label[seed] >= 0) continue;
        const id = boxes.length;
        let top = 0;
        stack[top++] = seed;
        label[seed] = id;
        let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, touchesEdge = false;
        while (top > 0) {
            const at = stack[--top];
            const x = at % W;
            const y = (at - x) / W;
            area++;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x >= x1) x1 = x + 1;
            if (y >= y1) y1 = y + 1;
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesEdge = true;
            if (x > 0 && paper[at - 1] && label[at - 1] < 0) { label[at - 1] = id; stack[top++] = at - 1; }
            if (x + 1 < W && paper[at + 1] && label[at + 1] < 0) { label[at + 1] = id; stack[top++] = at + 1; }
            if (y > 0 && paper[at - W] && label[at - W] < 0) { label[at - W] = id; stack[top++] = at - W; }
            if (y + 1 < H && paper[at + W] && label[at + W] < 0) { label[at + W] = id; stack[top++] = at + W; }
        }
        // 外周に届く白は紙の地。線で閉じられていないので吹き出しではない。
        if (touchesEdge) continue;
        const bw = x1 - x0;
        const bh = y1 - y0;
        if (bw < OCR_MANGA_BALLOON_MIN_SIDE || bh < OCR_MANGA_BALLOON_MIN_SIDE) continue;
        if (area > maxArea) continue;
        // つぶれた細長い形・複雑な形は絵の一部（服の白など）である可能性が高い
        if (area < bw * bh * OCR_MANGA_BALLOON_MIN_FILL) continue;
        // 中に文字らしい黒があるか
        let ink = 0;
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) if (!paper[y * W + x]) ink++;
        }
        const inkRatio = ink / (bw * bh);
        if (inkRatio < OCR_MANGA_BALLOON_MIN_INK || inkRatio > OCR_MANGA_BALLOON_MAX_INK) continue;
        // 中身が文字らしいか（大きさの揃った塊が複数あるか）で、絵の隙間を除く
        if (countMangaGlyphs(paper, W, { x0, y0, x1, y1 }, OCR_MANGA_BALLOON_MIN_GLYPHS)
            < OCR_MANGA_BALLOON_MIN_GLYPHS) continue;
        boxes.push({ x0, y0, x1, y1 });
    }

    // コマの中の白地も「線で囲まれた白い領域」なので候補に挙がる。そのまま読むと
    // コマ全体を認識してしまい、絵から文字が作られる。吹き出しを内側に含む候補は
    // コマ側なので落とす（吹き出しがコマを含むことはない）。
    // 重なり合う候補は、絵の線が作った大きめの領域が本物の吹き出しを巻き込んだもの。
    // 小さい方（＝吹き出しそのもの）を残すと、同じ台詞を二度読む事故も防げる。
    const kept = [];
    for (const cand of boxes.slice().sort((x, y) => rectArea2(x) - rectArea2(y))) {
        const dup = kept.some((k) => {
            const ow = Math.min(k.x1, cand.x1) - Math.max(k.x0, cand.x0);
            const oh = Math.min(k.y1, cand.y1) - Math.max(k.y0, cand.y0);
            if (ow <= 0 || oh <= 0) return false;
            return ow * oh >= Math.min(rectArea2(k), rectArea2(cand)) * OCR_MANGA_BALLOON_MAX_OVERLAP;
        });
        if (!dup) kept.push(cand);
    }
    if (!kept.length || kept.length > OCR_MANGA_BALLOON_MAX_COUNT) return null;
    boxes.length = 0;
    boxes.push(...kept);
    const inv = 1 / scale;
    const pad = OCR_MANGA_BALLOON_PAD;
    return boxes.map((b) => ({
        x0: Math.max(0, (b.x0 - pad) * inv),
        y0: Math.max(0, (b.y0 - pad) * inv),
        x1: Math.min(canvas.width, (b.x1 + pad) * inv),
        y1: Math.min(canvas.height, (b.y1 + pad) * inv)
    }));
}

// ===== コマ割りの検出 =====
//
// 吹き出しの座標だけでは、どこがコマの境界なのか分からない。
// 例えば「右にぶち抜きの縦長コマ、左を上下2段に割る」構図では、台詞の座標には
// 上下の隙間があるので横に切ってしまうが、実際には右のコマが上下をまたいでいる
// ため、横に切ってはいけない（実測: この構図で読み順が A→C→D→B→E と崩れた）。
//
// コマの境界は紙面の余白（ガター）として画像に現れる。そこで、実際の画像から
// 「その領域を端から端まで貫く白い帯」を探して再帰的に切り分ける。
// 貫く帯が無ければ、そこは1つのコマである。

const OCR_MANGA_PANEL_SCAN_MAX = 700;   // 走査用に縮小する長辺の画素数
const OCR_MANGA_PANEL_INK_LUM = 200;    // これ未満の輝度を「絵・文字がある」とみなす
const OCR_MANGA_PANEL_INK_RATIO = 0.01; // 行/列のこの割合未満なら余白とみなす
const OCR_MANGA_PANEL_MIN_GUTTER = 0.012; // 余白と認める帯の幅（短辺に対する比）
const OCR_MANGA_PANEL_MIN_SIDE = 0.06;    // コマと認める最小の辺（短辺に対する比）
const OCR_MANGA_PANEL_MAX_DEPTH = 8;

// 領域内の各行・各列の「絵がある画素数」を数え、貫く余白の帯を返す
function findMangaGutter(ink, W, box, minGutter) {
    const scan = (isRow) => {
        const lo = isRow ? box.y0 : box.x0;
        const hi = isRow ? box.y1 : box.x1;
        const span = (isRow ? box.x1 - box.x0 : box.y1 - box.y0);
        const limit = Math.max(1, Math.floor(span * OCR_MANGA_PANEL_INK_RATIO));
        const runs = [];
        let start = -1;
        for (let i = lo; i < hi; i++) {
            let count = 0;
            for (let j = (isRow ? box.x0 : box.y0); j < (isRow ? box.x1 : box.y1); j++) {
                if (ink[isRow ? i * W + j : j * W + i]) {
                    count++;
                    if (count > limit) break;
                }
            }
            const blank = count <= limit;
            if (blank && start < 0) start = i;
            if (!blank && start >= 0) { runs.push([start, i]); start = -1; }
        }
        if (start >= 0) runs.push([start, hi]);
        // 端に接する余白は外側の余白であり、コマの境界ではない
        let best = null;
        for (const [a, b] of runs) {
            if (a <= lo || b >= hi) continue;
            if (b - a < minGutter) continue;
            if (!best || b - a > best[1] - best[0]) best = [a, b];
        }
        return best;
    };
    // 漫画は「段」が先。横に貫く余白があればそこで上下に切る。
    const row = scan(true);
    if (row) return { axis: "y", at: (row[0] + row[1]) / 2 };
    const col = scan(false);
    if (col) return { axis: "x", at: (col[0] + col[1]) / 2 };
    return null;
}

// 画像からコマを読み順（右上→左下）に並べて返す。
// 切れ目が見つからない場合は、画像全体を1コマとして返す。
function detectMangaPanels(canvas) {
    const scan = toMangaScanMask(canvas, OCR_MANGA_PANEL_SCAN_MAX);
    if (!scan) return null;
    const { lum, W, H, scale } = scan;
    const ink = new Uint8Array(W * H);
    for (let i = 0; i < ink.length; i++) ink[i] = lum[i] < OCR_MANGA_PANEL_INK_LUM ? 1 : 0;

    const short = Math.min(W, H);
    const minGutter = Math.max(2, Math.round(short * OCR_MANGA_PANEL_MIN_GUTTER));
    const minSide = Math.max(4, Math.round(short * OCR_MANGA_PANEL_MIN_SIDE));
    const panels = [];
    const split = (box, depth) => {
        const cut = (depth >= OCR_MANGA_PANEL_MAX_DEPTH
            || box.x1 - box.x0 < minSide * 2 || box.y1 - box.y0 < minSide * 2)
            ? null
            : findMangaGutter(ink, W, box, minGutter);
        if (!cut) { panels.push(box); return; }
        if (cut.axis === "y") {
            // 上の段を先に読む
            split({ ...box, y1: cut.at }, depth + 1);
            split({ ...box, y0: cut.at }, depth + 1);
        } else {
            // 右のコマを先に読む
            split({ ...box, x0: cut.at }, depth + 1);
            split({ ...box, x1: cut.at }, depth + 1);
        }
    };
    split({ x0: 0, y0: 0, x1: W, y1: H }, 0);
    if (panels.length <= 1) return null;
    // 元の画像の座標系に戻す
    const inv = 1 / scale;
    return panels.map((p) => ({
        x0: p.x0 * inv, y0: p.y0 * inv, x1: p.x1 * inv, y1: p.y1 * inv
    }));
}

// 切れ目とみなす余白の最小幅（文字サイズに対する比）。これ未満の隙間では切らない。
// 同じ吹き出しの中の列間（実測で文字サイズの0.2〜0.4倍）で切ってしまわないための下限。
const OCR_MANGA_MIN_GAP_RATIO = 0.5;
// 読み上げに「間」を入れる、吹き出しどうしの距離（文字サイズに対する比）
const OCR_MANGA_PAUSE_GAP_RATIO = 1.5;

// 矩形の集合を軸に射影し、最も広い空白を見つけて2つに分ける。
// 分けられない場合は null。
function findMangaCut(items, axis, minGap) {
    const lo = axis === "y" ? (b) => b.y0 : (b) => b.x0;
    const hi = axis === "y" ? (b) => b.y1 : (b) => b.x1;
    const sorted = items.slice().sort((a, b) => lo(a.bbox) - lo(b.bbox));
    let best = null;
    let reach = hi(sorted[0].bbox);
    for (let i = 1; i < sorted.length; i++) {
        const gap = lo(sorted[i].bbox) - reach;
        // 全体を貫く余白でなければコマの境界ではない（reach を越える要素があると貫かない）
        if (gap >= minGap && (!best || gap > best.gap)) best = { gap, index: i };
        reach = Math.max(reach, hi(sorted[i].bbox));
    }
    if (!best) return null;
    return { first: sorted.slice(0, best.index), second: sorted.slice(best.index) };
}

// 漫画の読み順に並べ替える。orientation は吹き出しの中の並びに使う。
function orderMangaItems(items, orientation, minGap) {
    if (items.length <= 1) return items.slice();
    // 1. コマの段（横方向の余白）。上の段を先に読む。
    const rows = findMangaCut(items, "y", minGap);
    if (rows) {
        return orderMangaItems(rows.first, orientation, minGap)
            .concat(orderMangaItems(rows.second, orientation, minGap));
    }
    // 2. 同じ段の中のコマ・吹き出し（縦方向の余白）。右から左へ読む。
    const cols = findMangaCut(items, "x", minGap);
    if (cols) {
        return orderMangaItems(cols.second, orientation, minGap)
            .concat(orderMangaItems(cols.first, orientation, minGap));
    }
    // 3. 切れ目が無い＝同じ吹き出しの中。縦書きは右の列から、横書きは上の行から。
    return items.slice().sort((a, b) => (orientation === "vertical"
        ? b.bbox.x1 - a.bbox.x1 || a.bbox.y0 - b.bbox.y0
        : a.bbox.y0 - b.bbox.y0 || b.bbox.x1 - a.bbox.x1));
}

// 漫画モードの行の組み立て。読み順に並べ替えたうえで、離れた吹き出しの間には
// 空行を入れる（normalizeOcrText が「間」に変える）。
function buildMangaLines(lines, orientation, glyphSize, panels) {
    const usable = lines.filter((line) => line.bbox);
    // 座標が取れない行が混じる場合は並べ替えを行わない（順序を壊さないため）
    if (usable.length !== lines.length || usable.length < 2 || !(glyphSize > 0)) {
        return lines.map((line) => line.text);
    }
    const ordered = arrangeMangaItems(lines, orientation, glyphSize * OCR_MANGA_MIN_GAP_RATIO, panels);
    const pauseGap = glyphSize * OCR_MANGA_PAUSE_GAP_RATIO;
    const out = [];
    for (let i = 0; i < ordered.length; i++) {
        out.push(ordered[i].text);
        if (i === ordered.length - 1) continue;
        const a = ordered[i].bbox;
        const b = ordered[i + 1].bbox;
        // 矩形どうしの隙間（重なっていれば0）
        const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
        const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
        if (Math.hypot(dx, dy) > pauseGap) out.push("");
    }
    return out;
}

// 矩形をコマの読み順に並べる。コマ割りが分かっていればコマ単位に振り分けてから並べる。
function arrangeMangaItems(items, orientation, minGap, panels) {
    let ordered;
    if (panels && panels.length > 1) {
        // コマごとに振り分け、コマの読み順どおりに並べる。
        // どのコマにも入らない行（欄外の見出し・効果音など）は最も近いコマに寄せる。
        const groups = panels.map(() => []);
        for (const item of items) {
            const cx = (item.bbox.x0 + item.bbox.x1) / 2;
            const cy = (item.bbox.y0 + item.bbox.y1) / 2;
            let at = -1;
            let bestDist = Infinity;
            for (let i = 0; i < panels.length; i++) {
                const p = panels[i];
                if (cx >= p.x0 && cx < p.x1 && cy >= p.y0 && cy < p.y1) { at = i; break; }
                const dx = Math.max(p.x0 - cx, 0, cx - p.x1);
                const dy = Math.max(p.y0 - cy, 0, cy - p.y1);
                const d = Math.hypot(dx, dy);
                if (d < bestDist) { bestDist = d; at = i; }
            }
            groups[at].push(item);
        }
        ordered = [];
        for (const group of groups) {
            if (group.length) ordered = ordered.concat(orderMangaItems(group, orientation, minGap));
        }
    } else {
        ordered = orderMangaItems(items, orientation, minGap);
    }
    return ordered;
}

// blocks からテキストを再構成する（tesseract と同じ: 単語をスペース、行を改行で連結）。
// orientation と glyphSize を渡した場合は、段落の切れ目に空行を差し込む。
// manga が true のときは、代わりに漫画のコマ順へ並べ替える。
function buildTextFromBlocks(blocks, orientation, glyphSize, manga, panels) {
    const lines = [];
    for (const block of (blocks || [])) {
        for (const par of (block.paragraphs || [])) {
            for (const line of (par.lines || [])) {
                const words = (line.words || [])
                    .map((w) => (w.symbols || []).map((s) => s.text).join(""))
                    .filter(Boolean);
                if (words.length) lines.push({ text: words.join(" "), bbox: line.bbox });
            }
        }
    }
    if (manga) return buildMangaLines(lines, orientation, glyphSize, panels).join("\n");
    if (!orientation) return lines.map((line) => line.text).join("\n");
    return markOcrParagraphBreaks(lines, orientation, glyphSize).join("\n");
}

// 2つのシンボル列を編集距離で整列し、[baseIndex, otherSymbol] の対応を返す
function alignOcrSymbols(baseEntries, otherEntries) {
    const n = baseEntries.length;
    const m = otherEntries.length;
    const dp = [];
    for (let i = 0; i <= n; i++) {
        dp.push(new Int32Array(m + 1));
        dp[i][0] = i;
    }
    for (let j = 0; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const cost = baseEntries[i - 1].symbol.text === otherEntries[j - 1].symbol.text ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    const pairs = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
        const cost = baseEntries[i - 1].symbol.text === otherEntries[j - 1].symbol.text ? 0 : 1;
        if (dp[i][j] === dp[i - 1][j - 1] + cost) { pairs.push([i - 1, otherEntries[j - 1].symbol]); i--; j--; }
        else if (dp[i][j] === dp[i - 1][j] + 1) { i--; }
        else { j--; }
    }
    return pairs;
}

// 複数倍率の認識結果で元寸の文字を精錬する。判断の根拠は2つ。
// (1) 全会一致: すべての倍率が揃って「元寸とは違う同じ文字」を出した場合、そちらを採る。
//     元寸は高い確信度のまま誤ることがあり、確信度ではゲートできない
//     （実測: 誤った「バ」が確信度94、一方で全倍率が正しい「パ」を出していた。
//      濁点・半濁点の取り違えは読み上げで別語になるため影響が大きい）。
//     独立した複数倍率が全会一致した事実そのものを根拠にする。
//     実ページ24枚の実測で 改善13・悪化0。
// (2) 低確信度の漢字: 確信度の合計が上回る漢字へ置き換える（従来からの機能）。
// options.kanji / options.unanimous で対象を切り替える（既定は両方）。
// 置換した文字数を返す（0 なら呼び出し側は元のテキストをそのまま使う）。
function fuseOcrSymbols(baseBlocks, otherBlocksList, options = {}) {
    const useKanji = options.kanji !== false;
    const useUnanimous = options.unanimous !== false;
    const isKanji = (t) => OCR_KANJI_ONE_RE.test(t);
    const baseEntries = collectOcrSymbols(baseBlocks);
    if (!baseEntries.length) return 0;

    const candidates = new Map();
    for (const otherBlocks of otherBlocksList) {
        const otherEntries = collectOcrSymbols(otherBlocks);
        if (!otherEntries.length) continue;
        for (const [index, symbol] of alignOcrSymbols(baseEntries, otherEntries)) {
            if (!candidates.has(index)) candidates.set(index, []);
            candidates.get(index).push(symbol);
        }
    }

    const touchedWords = new Set();
    let replaced = 0;
    baseEntries.forEach((entry, index) => {
        const symbol = entry.symbol;
        const alts = candidates.get(index) || [];

        // (1) 全会一致による置換。確信度ではゲートしない（上のコメント参照）。
        if (useUnanimous && alts.length >= 2) {
            const first = alts[0].text;
            if (first !== symbol.text && alts.every((a) => a.text === first)) {
                symbol.text = first;
                touchedWords.add(entry.word);
                replaced++;
                return;
            }
        }

        // (2) 低確信度の漢字。同じ文字を出したバリアントの確信度を合計し、最大の文字を選ぶ。
        if (!useKanji || symbol.confidence >= OCR_FUSION_MIN_CONFIDENCE || !isKanji(symbol.text)) return;
        const scores = new Map();
        const add = (text, confidence) => scores.set(text, (scores.get(text) || 0) + confidence);
        add(symbol.text, symbol.confidence);
        for (const cand of alts) add(cand.text, cand.confidence);

        let best = null;
        for (const [text, score] of scores) {
            if (!best || score > best.score) best = { text, score };
        }
        if (best && best.text !== symbol.text && isKanji(best.text)
            && best.score > (scores.get(symbol.text) || 0)) {
            symbol.text = best.text;
            touchedWords.add(entry.word);
            replaced++;
        }
    });

    // 置換した文字を含む単語の text を再構成する（ルビ除去が word.text を見るため）
    for (const word of touchedWords) {
        word.text = (word.symbols || []).map((s) => s.text).join("");
    }
    return replaced;
}

// 語彙辞書によるリランキング。
// 融合の残存誤りは「非語」になることが多い（実測: 條恨は非語／悔恨は語）。しかも誤字が
// 高確信度（實測: 誤り「條」94）だと融合の確信度ゲートに掛からず救えない。そこで、
// 「元寸で非辞書語の漢字連続」を「複数の拡大版が揃って出す辞書語」へ置き換える。
// Tesseract の語分割は縦書きで1字ずつに割れることがある（実測）ため語境界には依存せず、
// 漢字連続の2-4字窓を辞書と照合する。安全のため:
// - base が既に辞書語なら触れない（正解の保護）
// - 各字が漢字で、2つ以上の拡大版が同一の辞書語で一致したときだけ置換（偶発誤りの排除）
// - 長い窓・支持の多い順に貪欲適用し、文字の重複置換を避ける
// 読みを捏造せず OCR 自身が出した候補から選ぶだけなので回帰リスクが低い
// （実測: 條恨→悔恨を修正し、ルビなしコーパスで悪化ゼロ・複数ケースでCER改善）。
function rerankOcrByDictionary(baseBlocks, otherBlocksList) {
    if (!ocrWordSet || !ocrWordSet.size) return 0;
    const isKanji = (t) => OCR_KANJI_ONE_RE.test(t);
    const baseEntries = collectOcrSymbols(baseBlocks);
    if (!baseEntries.length) return 0;

    // 各拡大版について base シンボルへの対応表（baseIndex→文字）を作る
    const variantMaps = [];
    for (const otherBlocks of otherBlocksList) {
        const otherEntries = collectOcrSymbols(otherBlocks);
        if (!otherEntries.length) continue;
        const map = new Map();
        for (const [index, symbol] of alignOcrSymbols(baseEntries, otherEntries)) {
            if (!map.has(index)) map.set(index, symbol.text);
        }
        variantMaps.push(map);
    }
    if (!variantMaps.length) return 0;

    const kanji = baseEntries.map((e) => isKanji(e.symbol.text));
    const candidates = [];
    let i = 0;
    while (i < baseEntries.length) {
        if (!kanji[i]) { i++; continue; }
        let j = i;
        while (j < baseEntries.length && kanji[j]) j++;
        // 漢字連続 [i, j) の中で 4→2字の窓を評価
        for (let len = Math.min(4, j - i); len >= 2; len--) {
            for (let start = i; start + len <= j; start++) {
                const baseStr = baseEntries.slice(start, start + len).map((e) => e.symbol.text).join("");
                if (ocrWordSet.has(baseStr)) continue; // 既に辞書語なら保護
                const votes = new Map();
                for (const map of variantMaps) {
                    let str = "";
                    let ok = true;
                    for (let k = 0; k < len; k++) {
                        const t = map.get(start + k);
                        if (!t || t.length !== 1 || !isKanji(t)) { ok = false; break; }
                        str += t;
                    }
                    if (ok) votes.set(str, (votes.get(str) || 0) + 1);
                }
                for (const [str, support] of votes) {
                    if (str !== baseStr && support >= 2 && ocrWordSet.has(str)) {
                        candidates.push({ start, len, str, support });
                    }
                }
            }
        }
        i = j;
    }
    // 長い窓・支持の多い順に貪欲適用（文字の重複を避ける）
    candidates.sort((a, b) => (b.len - a.len) || (b.support - a.support));
    const used = new Uint8Array(baseEntries.length);
    const touchedWords = new Set();
    let replaced = 0;
    for (const cand of candidates) {
        let free = true;
        for (let k = 0; k < cand.len; k++) if (used[cand.start + k]) { free = false; break; }
        if (!free) continue;
        for (let k = 0; k < cand.len; k++) {
            baseEntries[cand.start + k].symbol.text = cand.str[k];
            used[cand.start + k] = 1;
            touchedWords.add(baseEntries[cand.start + k].word);
        }
        replaced++;
    }
    for (const word of touchedWords) {
        word.text = (word.symbols || []).map((s) => s.text).join("");
    }
    return replaced;
}

// 認識結果の行bboxから文字サイズ（縦書き=行の幅、横書き=行の高さ）の中央値を求める。
// インク分布からの自前推定はルビ・傍点・句読点の細い帯に引きずられて過小評価しやすく、
// Tesseract 自身が検出した行の実測値を使う方が頑健（実測で確認）。
function estimateGlyphSizeFromBlocks(blocks, orientation) {
    const sizes = [];
    for (const block of (blocks || [])) {
        for (const par of (block.paragraphs || [])) {
            for (const line of (par.lines || [])) {
                const s = orientation === "vertical"
                    ? line.bbox.x1 - line.bbox.x0
                    : line.bbox.y1 - line.bbox.y0;
                if (s > 0) sizes.push(s);
            }
        }
    }
    if (!sizes.length) return null;
    sizes.sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)];
}

// ルビ除去を有効にしたときだけ、認識前に付ける背景色の余白。
// 選択範囲の端がルビ列を切っていると Tesseract の行bboxが画像の端まで広がり
// （実測: 実際8pxのルビ列が23pxと報告され、本文17pxより太くなってサイズ判定が
// 完全に外れる）、ルビを除去できない。余白を足すと bbox が正しくなり除去できる
// （実測: 端で切れる狭い選択2種がいずれも除去成功）。
// 一方この余白は通常の認識結果をわずかに変え、悪化する場合がある
// （実測: CER 0.98%→1.18%、2.29%→2.37%）。そのためルビ除去がOFFのときは
// 付けない。OFF時の挙動・精度は完全に従来どおりになる。
const OCR_RUBY_MARGIN_PX = 8;

// canvas の周囲に背景色の余白を足す。余白色は元画像の外周1pxの平均輝度とし、
// 暗い背景のページ（白抜き文字）でも不自然な境界を作らないようにする。
function padOcrCanvas(source, margin) {
    const { width, height } = source;
    const data = source.getContext("2d").getImageData(0, 0, width, height).data;
    const lum = (x, y) => {
        const i = (y * width + x) * 4;
        return (data[i] + data[i + 1] + data[i + 2]) / 3;
    };
    let sum = 0, count = 0;
    for (let x = 0; x < width; x++) { sum += lum(x, 0) + lum(x, height - 1); count += 2; }
    for (let y = 0; y < height; y++) { sum += lum(0, y) + lum(width - 1, y); count += 2; }
    const bg = Math.round(sum / count);

    const canvas = document.createElement("canvas");
    canvas.width = width + margin * 2;
    canvas.height = height + margin * 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `rgb(${bg}, ${bg}, ${bg})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, margin, margin);
    return canvas;
}

// 小さい文字の再認識用: canvas を高品質補間で拡大する（二値化はしない。
// 明朝体等では二値化が裏目に出るため、拡大のみの候補として確信度で競わせる）。
function upscaleOcrCanvas(source, scale) {
    const canvas = document.createElement("canvas");
    canvas.width = source.width * scale;
    canvas.height = source.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
}

// canvas の一部を切り出しつつ拡大する（ルビ列の再認識用）。
function cropOcrCanvas(source, x, y, width, height, scale) {
    if (!(width > 0) || !(height > 0)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas;
}

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
// resolveOcrOrientation で本文パッチを両モデルに掛けて決める。
const OCR_ORIENTATION_SURE_HORIZONTAL = 1.15; // これ以下なら横書きで確定
const OCR_ORIENTATION_SURE_VERTICAL = 1.8;    // これ以上なら縦書きで確定

// 中間帯のときに方向を決めるために切り出す、本文らしい領域の一辺（画素）。
// 実測（実サイト・切り出し・整形コーパスの22枚）で 240px・1箇所なら 22/22 正解、
// 確信度の差は 13〜58 と明確。200px では 20/22 に落ちる。所要は約1.6秒。
const OCR_ORIENTATION_PATCH_PX = 240;

// 切り出した画像の組版方向（横書き/縦書き）をインクの分布から推定する。
// 横書きは「行間の横方向の空白帯」、縦書きは「列間の縦方向の空白帯」が多く
// 現れることを利用する。
// 判定を誤っても、確信度による再認識フォールバックで救済される前提の軽量判定。
function detectTextOrientation(canvas) {
    const width = canvas.width;
    const height = canvas.height;

    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;

    // 平均輝度からインク判定の向きを決める（ダークモード＝明るい文字にも対応）
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    const mean = sum / (data.length / 4);
    const darkInk = mean >= 128;

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

// 文字らしい領域を1か所選んで切り出す。
// 「インクの切り替わりが多い」＝文字。写真やベタ塗りは切り替わりが少なく、
// インク率も極端になるので除外できる。方向判定の材料に本文だけを使うためのもの。
function pickOcrTextPatch(canvas, size) {
    const width = canvas.width;
    const height = canvas.height;
    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    const mean = sum / (data.length / 4);
    const darkInk = mean >= 128;

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

// 本文パッチを横書き・縦書きの両モデルで認識し、確信度の高い方の向きを返す。
// 画素の統計では分けられない中間帯でだけ呼ぶ（1回の認識が2つ増えるため）。
// 判定できないときは null を返し、呼び出し側の暫定値を使わせる。
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

// 組版方向を自動判定してOCRを実行する。確信度が低い場合はもう一方の方向でも
// 認識し、良い方の結果を返す。workerProvider(lang) はワーカーを返す関数
// （呼び出し側でキャッシュ管理する）。
// options.removeRuby が true の場合、ルビ（ふりがな）を優先して読む処理を行う
// （ふりがなの付いた漢字をルビの読みに差し替え、読めないルビは捨てる）。
// 戻り値は { text, confidence }（text は処理後の生テキスト。整形は呼び出し側で行う）。
// 吹き出しの中身が「読み上げる価値のある文字」かどうか。
// 絵を誤って吹き出しと判定してしまった場合、認識結果は日本語にならないか、
// 確信度が極端に低い。ここで落とさないと意味のない音が読み上げられる。
const OCR_MANGA_TEXT_RE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
const OCR_MANGA_SHORT_CONFIDENCE = 70;
// 吹き出しの縦横比がこれを超えたら横書きとみなす
const OCR_MANGA_HORIZONTAL_RATIO = 1.8;

function isMangaSpeech(text, confidence) {
    const body = (text || "").replace(/\s/g, "");
    if (!body || !OCR_MANGA_TEXT_RE.test(body)) return false;
    // 絵を吹き出しと誤検出した場合、認識の確信度は低いところに落ちる
    if (confidence < OCR_CONFIDENCE_ACCEPT) return false;
    // 1文字だけの吹き出し（「あ」「え？」等）は実際に多いが、絵の誤検出とも
    // 紛らわしい。短いものは確信度で足切りする。
    return body.length >= 2 || confidence >= OCR_MANGA_SHORT_CONFIDENCE;
}

// 吹き出しの中だけを、コマの読み順で認識する。
// 吹き出しを見つけられなかった場合は null を返し、従来どおりページ全体を認識する。
async function recognizeMangaPage(sourceCanvas, workerProvider, options) {
    const gray = toGrayscale(sourceCanvas);
    const balloons = detectMangaBalloons(gray);
    if (!balloons || balloons.length < 2) return null;

    const panels = detectMangaPanels(gray);
    // 並べ替えの「近い／遠い」の基準は吹き出しの大きさから取る
    const sides = balloons.map((b) => Math.min(b.x1 - b.x0, b.y1 - b.y0)).sort((a, b) => a - b);
    const minGap = sides[Math.floor(sides.length / 2)] * 0.3;
    const items = balloons.map((b) => ({ bbox: b }));
    const ordered = arrangeMangaItems(items, "vertical", minGap, panels);

    // ページ全体で使える精錬時間を吹き出しの数で分け合う
    const perBalloonBudget = Math.max(600, Math.floor(OCR_REFINE_TIME_BUDGET_MS / ordered.length));
    const parts = [];
    let confidenceSum = 0;
    let confidenceCount = 0;
    for (const item of ordered) {
        const b = item.bbox;
        const w = Math.round(b.x1 - b.x0);
        const h = Math.round(b.y1 - b.y0);
        if (w < 1 || h < 1) continue;
        const crop = cropOcrCanvas(sourceCanvas, Math.round(b.x0), Math.round(b.y0), w, h, 1);
        // 吹き出しごとに、通常どおりの認識（組版方向の判定・拡大再認識・融合・
        // 辞書リランク・ルビ処理）をそのまま適用する。範囲が小さいぶん速い。
        // 日本の漫画の台詞は縦書きが基本。明らかに横長の吹き出しだけ横書き扱いにする。
        const forceOrientation = w > h * OCR_MANGA_HORIZONTAL_RATIO ? "horizontal" : "vertical";
        const one = await recognizeWithOrientation(crop, workerProvider,
            { removeRuby: options.removeRuby, manga: false, forceOrientation, refineBudgetMs: perBalloonBudget });
        if (!isMangaSpeech(one.text, one.confidence)) continue;
        parts.push(one.text.trim());
        confidenceSum += one.confidence;
        confidenceCount++;
    }
    if (!parts.length) return null;
    // 吹き出しの区切りは空行にする（normalizeOcrText が「間」に変える）
    return {
        text: parts.join("\n\n"),
        confidence: confidenceCount ? confidenceSum / confidenceCount : 0
    };
}

async function recognizeWithOrientation(sourceCanvas, workerProvider, options = {}) {
    const removeRuby = !!options.removeRuby;
    const manga = !!options.manga;
    // 精錬に使える時間。漫画モードでは吹き出しの数だけ認識を繰り返すため、
    // 呼び出し側がページ全体の予算を分けて渡す（1つあたりに満額を与えると
    // 吹き出しの数だけ待ち時間が積み上がる）。
    const refineBudgetMs = options.refineBudgetMs > 0
        ? options.refineBudgetMs
        : OCR_REFINE_TIME_BUDGET_MS;

    // 漫画モードでは、まず吹き出しを見つけてその中だけを読む。
    // ページ全体を認識させると絵から実在しない文字が作られるため。
    if (manga) {
        const page = await recognizeMangaPage(sourceCanvas, workerProvider, options);
        if (page) return page;
    }
    // blocks はルビ除去（行ごとの座標）と文字サイズの実測（行bbox）に使う
    const output = { text: true, blocks: true };

    // 語彙辞書を一度だけ読み込む（任意。失敗しても従来動作）
    await ensureOcrDictionaries();

    // ルビ除去時のみ余白を付ける（理由は OCR_RUBY_MARGIN_PX のコメント参照）。
    // OFF のときは元の canvas をそのまま使うため、従来と完全に同じ結果になる。
    const canvas = removeRuby ? padOcrCanvas(sourceCanvas, OCR_RUBY_MARGIN_PX) : sourceCanvas;
    // 全文乗り換えを許す元寸側の確信度の上限。ルビ除去時は行の幾何を保つため厳しくする。
    const swapMaxBaseConfidence = removeRuby
        ? OCR_RUBY_SWAP_MAX_BASE_CONFIDENCE
        : OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE;

    // まずグレースケール化した元寸画像を作る（拡大・二値化はしない。
    // 明朝体等、強い前処理が裏目に出るフォントがあるため）
    const grayCanvas = toGrayscale(canvas);

    // 漫画モードでは、吹き出しごとの小さな切り出しで組版方向を測ると外れやすい
    // （縦横比がほぼ1になるため）。ページ全体から決めた方向を呼び出し側が渡す。
    const detected = options.forceOrientation
        ? { orientation: options.forceOrientation, confident: true }
        : detectTextOrientation(canvas);
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
    const primary = await primaryWorker.recognize(grayCanvas, {}, output);
    // 精錬1段のコストは元寸の認識1回分とほぼ同じ。予算に何回入るかを
    // 「元寸の所要時間から一度だけ」決め、以降は残り回数だけで判定する。
    // 段ごとに経過時間を見ると、そのときのマシン負荷で打ち切り位置が変わり、
    // 同じ選択なのに結果が変わってしまうため（過去に報告された不安定さの再発を防ぐ）。
    const primaryMs = Math.max(1, Date.now() - startedAt);
    // 精錬1段のコストは元寸の認識1回分と同程度。予算に何回入るかを
    // 「元寸の所要時間から一度だけ」決め、以降は残り回数だけで判定する。
    // 段ごとに経過時間を見ると、そのときのマシン負荷で打ち切り位置が変わり、
    // 同じ選択なのに結果が変わってしまうため（過去に報告された不安定さの再発を防ぐ）。
    // ただし画面全体のような大きな入力では1段が7〜12秒かかり、1段でも走ると
    // 待ち時間が倍増して体感を大きく損なうため、面積で先に足切りする。
    const sourceArea = grayCanvas.width * grayCanvas.height;
    const refinable = sourceArea <= OCR_REFINE_MAX_AREA;
    let refinesLeft = refinable
        ? Math.max(0, Math.floor((refineBudgetMs - primaryMs) / primaryMs))
        : 0;
    const canRefine = () => refinesLeft > 0;
    const useRefine = () => { refinesLeft--; };

    let best = primary.data;
    let bestLang = primaryLang;
    // best.blocks の bbox が乗る座標系（＝best を生んだ画像）。ルビ列の再認識で
    // この canvas から切り出すため、best とセットで追跡する。
    let bestCanvas = grayCanvas;
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
        upscaled2x = (await primaryWorker.recognize(upscaled2xCanvas, {}, output)).data;
        // 全文の乗り換えは元寸が明らかに信用できないときだけ
        // （理由は OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE のコメント参照）。
        // 乗り換えない場合も、この結果は文字単位融合の素材として使う。
        if (upscaled2x.confidence >= best.confidence + OCR_PREPROCESS_ADOPT_MARGIN
            && best.confidence < swapMaxBaseConfidence) {
            best = upscaled2x;
            bestCanvas = upscaled2xCanvas;
        }
    }

    // 確信度が十分でなければ、前処理版（拡大＋二値化）でも認識して良い方を採用する
    // （ゴシック体の小さい文字はこちらが大きく改善する）
    if (best.confidence < OCR_PREPROCESS_SKIP_CONFIDENCE && canRefine()) {
        useRefine();
        const prepared = prepareOcrCanvas(canvas);
        if (prepared !== canvas) {
            const preprocessed = await primaryWorker.recognize(prepared, {}, output);
            // ルビ除去時のみ、元寸の確信度による制限を課す（OFF時は従来どおり無条件）。
            // 二値化版へ乗り換えても行の幾何が崩れてルビ判定が外れるため。
            if (preprocessed.data.confidence >= best.confidence + OCR_PREPROCESS_ADOPT_MARGIN
                && (!removeRuby || best.confidence < OCR_RUBY_SWAP_MAX_BASE_CONFIDENCE)) {
                best = preprocessed.data;
                bestCanvas = prepared;
            }
        }
    }

    // それでも明らかに低品質なときだけ、もう一方の組版方向も試す
    if (best.confidence < OCR_CONFIDENCE_ACCEPT) {
        const secondaryLang = primaryLang === "jpn" ? "jpn_vert" : "jpn";
        const secondaryWorker = await workerProvider(secondaryLang);
        const secondary = await secondaryWorker.recognize(grayCanvas, {}, output);
        if (secondary.data.confidence > best.confidence) {
            best = secondary.data;
            bestLang = secondaryLang;
            bestCanvas = grayCanvas;
        }
    }

    // best.blocks から tesseract と同じ規則（単語=スペース・行=改行）でテキストを組み立てる。
    // best.text と内容は同一だが、後段の融合・辞書リランクが symbol.text を書き換えるため
    // blocks から組み直す（置換前は best.text をそのまま使うのと等価）。段落境界の「間」は
    // buildTextFromBlocks では付けず、後段の normalizeOcrText が行の内容から推定して補う。
    // 段落境界の推定には best を生んだ画像の座標系・組版方向を使う
    const bestOrientation = bestLang === "jpn_vert" ? "vertical" : "horizontal";
    const bestGlyphSize = estimateGlyphSizeFromBlocks(best.blocks, bestOrientation);
    // コマ割りの検出は画像の走査を伴うため、必要になったとき一度だけ行う。
    let mangaPanelsCache;
    const mangaPanels = () => {
        if (mangaPanelsCache === undefined) {
            mangaPanelsCache = manga ? detectMangaPanels(bestCanvas) : null;
        }
        return mangaPanelsCache;
    };
    let text = best.blocks
        ? buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize, manga, mangaPanels())
        : best.text;

    // 文字単位アンサンブル融合。元寸grayが採用され、かつ文字がLSTM最適域を下回るときだけ、
    // 複数倍率の認識結果で低確信度の漢字を精錬する（詳細は OCR_FUSION_* のコメント参照）。
    if (best === primary.data && glyphSize != null && glyphSize < OCR_FUSION_TRIGGER_GLYPH_PX) {
        const others = [];
        for (const scale of OCR_FUSION_SCALES) {
            if (scale === 2 && upscaled2x) { others.push(upscaled2x.blocks); continue; }
            const area = grayCanvas.width * scale * grayCanvas.height * scale;
            if (area > OCR_FUSION_MAX_AREA) continue;
            if (!canRefine()) break;
            useRefine();
            const variant = await primaryWorker.recognize(upscaleOcrCanvas(grayCanvas, scale), {}, output);
            others.push(variant.data.blocks);
        }
        if (others.length) {
            // 融合（低確信度の漢字を精錬）→ 辞書リランキング（残った非語を辞書語へ）の順に適用。
            // どちらかが置換したときだけ blocks からテキストを組み直す
            // （置換ゼロなら tesseract の出力をそのまま使い、挙動を変えない）。
            const fused = fuseOcrSymbols(best.blocks, others);
            const reranked = rerankOcrByDictionary(best.blocks, others);
            if (fused > 0 || reranked > 0) {
                text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize, manga, mangaPanels());
            }
        }
    } else if (best === primary.data && glyphSize != null
        && glyphSize >= OCR_FUSION_TRIGGER_GLYPH_PX
        && best.confidence < OCR_PREPROCESS_SKIP_CONFIDENCE) {
        // 文字が最適域以上のときは拡大しても精度が上がらないため融合は行わないが、
        // 最適域を狙った倍率で認識し直して辞書リランクの材料にする。
        // 実測では「覚悟→党悟」「鎌倉→鉄倉」のような一般語の誤りがこの領域で多発しており、
        // 従来はゲート（18px）に阻まれて一切補正されていなかった。
        const others = [];
        const seen = new Set();
        for (const target of OCR_RERANK_TARGET_GLYPH_PX) {
            const scale = Math.round((target / glyphSize) * 100) / 100;
            if (scale === 1 || scale < 0.4 || scale > 3 || seen.has(scale)) continue;
            seen.add(scale);
            const area = grayCanvas.width * scale * grayCanvas.height * scale;
            if (area > OCR_FUSION_MAX_AREA) continue;
            // 2倍拡大版は既にあるので予算を消費しない
            if (scale === 2 && upscaled2x) { others.push(upscaled2x.blocks); continue; }
            if (!canRefine()) break;
            useRefine();
            const variant = await primaryWorker.recognize(upscaleOcrCanvas(grayCanvas, scale), {}, output);
            others.push(variant.data.blocks);
        }
        // 確信度による漢字の融合はこの領域では悪化する（実測）ため行わないが、
        // 全会一致による置換は文字サイズによらず有効なので、そちらだけ適用する。
        const fused = others.length ? fuseOcrSymbols(best.blocks, others, { kanji: false }) : 0;
        // 2つ以上の倍率が同じ辞書語で一致したときだけ置換する（多数決の最低条件）
        const reranked = others.length >= 2 ? rerankOcrByDictionary(best.blocks, others) : 0;
        if (fused > 0 || reranked > 0) {
            text = buildTextFromBlocks(best.blocks, bestOrientation, bestGlyphSize, manga, mangaPanels());
        }
    }

    if (removeRuby && best.blocks) {
        const rubyOrientation = bestLang === "jpn_vert" ? "vertical" : "horizontal";
        // best.blocks と同じ座標系の画像（bestCanvas）からルビ列を切り出して
        // 再認識する。再認識には best と同じ言語のワーカーを使う。
        const rubyWorker = await workerProvider(bestLang);
        const filtered = await applyRubyReadings(
            best.blocks, rubyOrientation, bestCanvas, rubyWorker, output, manga, mangaPanels());
        if (filtered != null) text = filtered;
    }
    return { text, confidence: best.confidence };
}

// ===== ルビ（ふりがな）優先読み =====
// ルビは「その漢字を作者の意図どおりに読ませる」ために振られるので、読み上げでは
// 漢字の一般的な読みではなくルビの読みが正解になる。そこで、ルビが振られた漢字は
// ルビの文字列に差し替え、漢字自体は読み上げない（例:「鯨幕」→「くじらまく」）。
// ルビを信頼できる形で読み取れなかった場合は、そのルビを捨てて漢字のまま読む
// （＝従来のルビ除去と同じ挙動）。縦書きではルビ列が本文列の右側にあり Tesseract は
// 右の列から出力するため、ここで処理しないとルビだけが先に読み上げられてしまう。

const OCR_RUBY_SIZE_RATIO = 0.6;   // 本文サイズのこの割合未満の行をルビ候補とする
const OCR_RUBY_MIN_KEEP_RATIO = 0.3; // 残存文字がこれ未満なら誤検出とみなし中止
// ルビ列は極端に小さく（実測8px幅）、そのままでは Tesseract の最適域20-30pxを
// 大きく下回って化ける（実測: つぶて→「っtet」、くじらまく→「くじにらまく」）。
// ルビ列だけを切り出してこのサイズまで拡大し直すと正読できる
// （実測: 同じ列が x1「つよはてくじらまく」→ x4「つぶてくじらまく」で完全一致）。
const OCR_RUBY_TARGET_GLYPH_PX = 28;
const OCR_RUBY_RESCAN_MIN_SCALE = 2;
const OCR_RUBY_RESCAN_MAX_SCALE = 8;
const OCR_RUBY_RESCAN_MAX_AREA = 4000000; // 再認識画像の面積上限（処理時間の保護）
const OCR_RUBY_MAX_RESCAN_LINES = 16;     // 1回のOCRで再認識するルビ列数の上限
// ルビ列の中で、本文1文字のこの割合を超える空きがあれば別の親文字のルビとみなす
const OCR_RUBY_GROUP_GAP_RATIO = 0.6;
// 親文字がルビ群と重なっているとみなす割合（親文字1字の長さに対する比）
const OCR_RUBY_OVERLAP_RATIO = 0.35;
// 親文字1字あたりのルビ長の上限。これを超える対応付けは誤りとみなして差し替えない
const OCR_RUBY_MAX_KANA_PER_KANJI = 4;

// CJK統合漢字（U+4E00–U+9FFF）＋拡張A（U+3400–U+4DBF）の判定を1か所に集約する。
const OCR_KANJI_CLASS = "㐀-䶿一-鿿";
const OCR_KANJI_RE = new RegExp(`[${OCR_KANJI_CLASS}]`);       // 部分一致（漢字を含むか）
const OCR_KANJI_ONE_RE = new RegExp(`^[${OCR_KANJI_CLASS}]$`);  // 単一文字が漢字か
// ルビとして採用してよい文字（かな・長音・繰り返し記号のみ）。
// 化けたルビ（ラテン文字混じり等）を本文に差し込まないための門番。
const OCR_RUBY_TEXT_RE = /^[ぁ-ゖァ-ヺーゝゞヽヾ]+$/;

// blocks から行の一覧を取り出す。
// サイズは必ず「行の bbox」から測る。単語単位の bbox は縦書きで信用できず、
// 実測ではルビ行（実際の行幅8px）の単語幅が 8,8,8,6,22,22,22,22 と乱れ、その
// 中央値22が本文（17px）より大きくなってルビ判定が完全に外れていた。
function collectOcrLines(blocks, orientation) {
    const lines = [];
    for (const block of (blocks || [])) {
        for (const par of (block.paragraphs || [])) {
            for (const line of (par.lines || [])) {
                const words = (line.words || []).filter((w) => (w.text || "").trim());
                if (!words.length) continue;
                const text = words.map((w) => w.text).join(" ").trim();
                lines.push({
                    text,
                    // 文字位置は等間隔で見積もるため、空白を除いた文字列で数える
                    chars: Array.from(text.replace(/\s+/g, "")),
                    bbox: line.bbox,
                    size: orientation === "vertical"
                        ? line.bbox.x1 - line.bbox.x0
                        : line.bbox.y1 - line.bbox.y0,
                    hasKanji: OCR_KANJI_RE.test(text),
                    subs: []
                });
            }
        }
    }
    return lines;
}

// 本文サイズ = 行代表サイズの文字数重み付き中央値。
// ルビ行は短いため、文字数で重み付けすると本文サイズに引き寄せられにくい。
// サイズ情報が乏しい場合は null（判定せず生テキストにフォールバックさせる）。
function estimateOcrBodySize(lines) {
    const weighted = [];
    for (const line of lines) {
        if (line.size > 0) {
            for (let i = 0; i < line.chars.length; i++) weighted.push(line.size);
        }
    }
    if (weighted.length < 4) return null;
    weighted.sort((a, b) => a - b);
    return weighted[Math.floor(weighted.length / 2)];
}

// ルビ行の判定条件は次の2つ:
// (1) 行の bbox サイズ（縦書き=幅／横書き=高さ）が本文サイズより十分小さい
// (2) 行に漢字を含まない（ルビは かな。漢字を含む小さい行＝傍注等は残す）
// かつては「すべて かな」を要求していたが、ルビがOCRで化けると条件を外れて
// 除去できなかったため「漢字を含まない」に緩めた。サイズ判定が幾何的で
// 信頼できるため、これで足りる。
function isOcrRubyLine(line, bodySize) {
    return !line.hasKanji && line.size > 0 && line.size < bodySize * OCR_RUBY_SIZE_RATIO;
}

// 拡大再認識したルビ列から「親文字ごとのルビ群」を切り出す。
// 群の区切りは語 bbox の主軸方向の空きだけで決める（ルビ列内の語の並び順は
// そのまま読み順なので、順序は Tesseract の出力に従う）。語 bbox は入れ子に
// なることがある（実測: 「くじ」が群全体を覆い、その中に「ら」「ま」「く」）ため、
// 群の範囲は和집合として広げる。
// offset/scale は切り出し画像の座標を元の canvas 座標へ戻すための値。
function extractOcrRubyGroups(blocks, orientation, offset, scale, bodySize) {
    const words = [];
    for (const block of (blocks || [])) {
        for (const par of (block.paragraphs || [])) {
            for (const line of (par.lines || [])) {
                for (const word of (line.words || [])) {
                    const text = (word.text || "").replace(/\s+/g, "");
                    if (!text) continue;
                    const bbox = word.bbox;
                    const [a, b] = orientation === "vertical"
                        ? [bbox.y0, bbox.y1]
                        : [bbox.x0, bbox.x1];
                    words.push({ text, start: offset + a / scale, end: offset + b / scale });
                }
            }
        }
    }
    const maxGap = bodySize * OCR_RUBY_GROUP_GAP_RATIO;
    const groups = [];
    let current = null;
    for (const word of words) {
        if (current && word.start - current.end > maxGap) {
            groups.push(current);
            current = null;
        }
        if (!current) current = { text: "", start: word.start, end: word.end };
        current.text += word.text;
        current.start = Math.min(current.start, word.start);
        current.end = Math.max(current.end, word.end);
    }
    if (current) groups.push(current);
    return groups;
}

// ルビ行の親（本文）行を探す。縦書きではルビは親文字の右側、横書きでは上側に
// 置かれるため、それぞれ「左隣」「下」で主軸方向に重なる本文行を選ぶ。
function findOcrRubyParent(ruby, bodyLines, orientation, bodySize) {
    let best = null;
    let bestDistance = Infinity;
    for (const line of bodyLines) {
        let distance;
        let overlap;
        if (orientation === "vertical") {
            distance = ruby.bbox.x0 - line.bbox.x1;
            overlap = Math.min(line.bbox.y1, ruby.bbox.y1) - Math.max(line.bbox.y0, ruby.bbox.y0);
        } else {
            distance = line.bbox.y0 - ruby.bbox.y1;
            overlap = Math.min(line.bbox.x1, ruby.bbox.x1) - Math.max(line.bbox.x0, ruby.bbox.x0);
        }
        // わずかな食い込みは許すが、離れすぎているものは親とみなさない
        if (distance < -bodySize || distance > bodySize * 1.5) continue;
        if (overlap <= 0) continue;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = line;
        }
    }
    return best;
}

// ルビ群を親行の漢字に対応付けて差し替え予約を積む。
// 日本語の縦組み・横組みは全角等幅なので、親行の主軸方向の長さを文字数で等分すると
// 各文字の位置を精度よく見積もれる（記号単位の bbox は縦書きで x が 0-0 になるなど
// 完全に壊れており使えない。実測で確認済み）。
// 見積もった窓の中から「最もルビ群と重なる漢字の連続」を親文字として選ぶ。
function planOcrRubySubstitution(parent, group, orientation) {
    const [p0, p1] = orientation === "vertical"
        ? [parent.bbox.y0, parent.bbox.y1]
        : [parent.bbox.x0, parent.bbox.x1];
    const n = parent.chars.length;
    if (n === 0 || !(p1 > p0)) return false;
    if (!OCR_RUBY_TEXT_RE.test(group.text)) return false;

    const unit = (p1 - p0) / n;
    const overlapOf = (i) => {
        const s = p0 + i * unit;
        return Math.min(s + unit, group.end) - Math.max(s, group.start);
    };

    // ルビ群と十分重なる文字の窓を求め、その中の漢字の連続を親文字候補にする
    let bestStart = -1;
    let bestLength = 0;
    let bestScore = 0;
    let runStart = -1;
    let runScore = 0;
    for (let i = 0; i <= n; i++) {
        const inWindow = i < n
            && overlapOf(i) > unit * OCR_RUBY_OVERLAP_RATIO
            && OCR_KANJI_RE.test(parent.chars[i]);
        if (inWindow) {
            if (runStart < 0) { runStart = i; runScore = 0; }
            runScore += overlapOf(i);
        } else if (runStart >= 0) {
            if (runScore > bestScore) {
                bestScore = runScore;
                bestStart = runStart;
                bestLength = i - runStart;
            }
            runStart = -1;
        }
    }
    if (bestStart < 0) return false;
    // ルビが親文字数に対して不自然に長い対応付けは誤りとみなす
    if (group.text.length > bestLength * OCR_RUBY_MAX_KANA_PER_KANJI) return false;

    parent.subs.push({ start: bestStart, length: bestLength, text: group.text });
    return true;
}

// 予約した差し替えを行テキストに反映する（後ろから適用して添字のずれを防ぐ）
function applyOcrRubySubstitutions(line) {
    if (!line.subs.length) return line.text;
    const chars = line.chars.slice();
    const subs = line.subs.slice().sort((a, b) => b.start - a.start);
    let limit = chars.length;
    for (const sub of subs) {
        if (sub.start + sub.length > limit) continue; // 重複した対応付けは捨てる
        chars.splice(sub.start, sub.length, sub.text);
        limit = sub.start;
    }
    return chars.join("");
}

// ルビ列を切り出して拡大し、認識し直してルビ群を得る
async function rescanOcrRubyLine(ruby, orientation, canvas, worker, output, bodySize) {
    if (!(ruby.size > 0)) return [];
    let scale = Math.round(OCR_RUBY_TARGET_GLYPH_PX / ruby.size);
    scale = Math.max(OCR_RUBY_RESCAN_MIN_SCALE, Math.min(OCR_RUBY_RESCAN_MAX_SCALE, scale));

    // 主軸方向は広めに、直交方向は隣の本文列を巻き込まないよう狭めに余白を取る
    const along = Math.max(2, Math.round(ruby.size));
    const cross = Math.max(2, Math.round(ruby.size * 0.4));
    const [mx, my] = orientation === "vertical" ? [cross, along] : [along, cross];
    const x = Math.max(0, Math.floor(ruby.bbox.x0 - mx));
    const y = Math.max(0, Math.floor(ruby.bbox.y0 - my));
    const width = Math.min(canvas.width, Math.ceil(ruby.bbox.x1 + mx)) - x;
    const height = Math.min(canvas.height, Math.ceil(ruby.bbox.y1 + my)) - y;
    while (scale > OCR_RUBY_RESCAN_MIN_SCALE
        && width * scale * height * scale > OCR_RUBY_RESCAN_MAX_AREA) scale--;
    if (width * scale * height * scale > OCR_RUBY_RESCAN_MAX_AREA) return [];

    const cropped = cropOcrCanvas(canvas, x, y, width, height, scale);
    if (!cropped) return [];
    const rescanned = await worker.recognize(cropped, {}, output);
    const offset = orientation === "vertical" ? y : x;
    return extractOcrRubyGroups(rescanned.data.blocks, orientation, offset, scale, bodySize);
}

// ルビを親文字に差し替えたテキストを返す。ルビが見つからない場合や、
// 除去しすぎ（本文の大半が消える）・情報不足の場合は null を返し、呼び出し側で
// 生テキストにフォールバックさせる（誤検出による本文欠落を防ぐ安全弁）。
async function applyRubyReadings(blocks, orientation, canvas, worker, output, manga, mangaPanels) {
    const lines = collectOcrLines(blocks, orientation);
    const bodySize = estimateOcrBodySize(lines);
    if (bodySize == null) return null;

    const rubyLines = [];
    const bodyLines = [];
    for (const line of lines) {
        (isOcrRubyLine(line, bodySize) ? rubyLines : bodyLines).push(line);
    }
    // ルビが無ければ何もしない（ルビの無いページで挙動を変えないため）
    if (!rubyLines.length || !bodyLines.length) return null;

    const rescanCount = Math.min(rubyLines.length, OCR_RUBY_MAX_RESCAN_LINES);
    for (let i = 0; i < rescanCount; i++) {
        const ruby = rubyLines[i];
        const parent = findOcrRubyParent(ruby, bodyLines, orientation, bodySize);
        if (!parent) continue;
        let groups;
        try {
            groups = await rescanOcrRubyLine(ruby, orientation, canvas, worker, output, bodySize);
        } catch (error) {
            // 再認識に失敗しても、ルビ行を落とすだけの従来動作は成立させる
            continue;
        }
        for (const group of groups) planOcrRubySubstitution(parent, group, orientation);
    }

    let totalChars = 0;
    let keptChars = 0;
    const kept = [];
    for (const line of lines) {
        totalChars += line.chars.length;
        // ルビ行は落とす（差し替えできたルビは親行に入っている）
        if (isOcrRubyLine(line, bodySize)) continue;
        keptChars += line.chars.length;
        const text = applyOcrRubySubstitutions(line);
        if (text) kept.push({ text, bbox: line.bbox });
    }
    if (totalChars === 0 || keptChars < totalChars * OCR_RUBY_MIN_KEEP_RATIO) return null;
    // ルビ経路でも同じ規則で段落境界を入れる（本文行だけで判定する）
    if (manga) return buildMangaLines(kept, orientation, bodySize, mangaPanels).join("\n");
    return markOcrParagraphBreaks(kept, orientation, bodySize).join("\n");
}

// OCR結果の整形。
// VOICEVOX は半角スペースを「間（ポーズ）」として読むため、そのままだと
// 誤挿入スペースや画像上の折り返し位置で文が不自然に区切れてしまう。
// - 日本語文字に隣接するスペースは除去する（「確認し ましょう」→「確認しましょう」）
// - 画像上の折り返し（同じ段落内の改行）は日本語連続なら間を入れずに連結する
// - 段落の境界（見出しと本文、箇条書きの項目など）には読点相当の「間」を補う。
//   実機の Tesseract は行座標(bbox)が得られないことがあり、buildTextFromBlocks も
//   段落境界の空行は付けないため、行の内容から段落境界を推定する: 箇条書きマーカー・
//   文末・「短く句読点/ひらがなで終わらず次行が長い」見出しパターン（読み＝文字は不変）。
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

// 読み上げ用の整形（content.js の cleanMessage と同等: URLの読み飛ばし・改行の空白化）。
// 加えて、ダッシュ（――）の連続がOCRで縦棒・数字混じりに崩れたもの
// （例: 「うわー|ー|1||っ」）を長音1つに正規化する。ダッシュ/長音を含む
// 混合連続のみを対象とし、縦棒だけの並び（コード内の || 等）には触れない。
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
