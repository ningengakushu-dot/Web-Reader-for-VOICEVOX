// 出荷コード(constants/ocr-image/ocr-refine/ocr-common)そのものをNodeで実行する
// 実機相当OCR回帰ハーネス。Tesseract.js v6 + 同梱traineddata + @napi-rs/canvas。
// 使い方は README.md を参照。精度A/Bは必ず逐次実行すること
// （過去の教訓: 並行実行は時間依存分岐で測定を汚染する）。
import { createWorker, PSM } from "tesseract.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const langPath = resolve(repo, "vendor", "tesseract", "lang");

// ---- Tesseract shim: 出荷コードのcreateOcrWorker呼び出しをNode実行へ写像する ----
async function toInput(image) {
    if (image && typeof image.encode === "function") return await image.encode("png");
    if (image && typeof image.toBuffer === "function") return image.toBuffer("image/png");
    return image;
}
function makeTesseractShim() {
    return {
        PSM,
        createWorker: (lang, _oem, options = {}) => createWorker(lang, 1, {
            langPath,
            gzip: false,
            cacheMethod: "none",
            logger: typeof options.logger === "function" ? options.logger : () => {},
            errorHandler: typeof options.errorHandler === "function"
                ? options.errorHandler : () => {}
        }).then((worker) => ({
            recognize: async (image, opts, output) =>
                worker.recognize(await toInput(image), opts, output),
            setParameters: (params) => worker.setParameters(params),
            terminate: () => worker.terminate()
        }))
    };
}

// ---- 出荷ソースの読み込みとバリアントパッチ ----
function mustReplace(source, from, to, label) {
    if (!source.includes(from)) throw new Error(`patch not applicable: ${label}`);
    return source.split(from).join(to);
}
function loadSources(dir, patches) {
    let source = ["constants.js", "ocr-image.js", "ocr-refine.js", "ocr-common.js"]
        .map((name) => readFileSync(join(dir, name), "utf8")).join("\n;\n");
    for (const patch of patches) {
        source = mustReplace(source, patch.from, patch.to, patch.label);
    }
    return source;
}
function makeApi(source) {
    const sandbox = {
        console, setTimeout, clearTimeout, Date, Math, JSON, Promise,
        Map, Set, RegExp, Number, Array, Object, String,
        Uint8Array, Uint8ClampedArray, Int32Array, Infinity, NaN, isFinite,
        document: { createElement: () => createCanvas(1, 1) },
        chrome: { runtime: { getURL: (path) => path } },
        // 同梱リソースの取得。公開版(main)の ocr-refine.js は語彙辞書 ocr-words.txt を
        // fetch(chrome.runtime.getURL(...)) で読み、失敗しても素通りする作りになっている。
        // shim が無いと**ベースライン側だけ辞書が無効**になり、公開版を不当に低く見積もる。
        // work/ を先に見るのは、辞書を消したブランチでも main のファイルを
        // `git show main:ocr-words.txt > work/ocr-words.txt` で置いて測れるようにするため。
        fetch: async (url) => {
            const name = basename(String(url));
            const candidates = [join(here, "work", name), join(repo, name)];
            const found = candidates.find((path) => existsSync(path));
            if (!found) return { ok: false, status: 404, headers: { get: () => null },
                text: async () => "" };
            const body = readFileSync(found, "utf8");
            return { ok: true, status: 200,
                headers: { get: (key) => (String(key).toLowerCase() === "content-length"
                    ? String(Buffer.byteLength(body)) : null) },
                text: async () => body };
        },
        Tesseract: makeTesseractShim()
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(source
        + "\n;globalThis.__api = { createOcrWorkerPool, recognizeWithOrientation };",
        context);
    return context.__api;
}

// CER比較用バリアントは時間予算を60秒へ固定し、精錬段数がマシン負荷で変わる
// 非決定性を排して純粋なアルゴリズム差だけを測る。予算挙動は budget* で別途測る。
const BUDGET_PATCH = (value) => ({
    from: "const OCR_REFINE_TIME_BUDGET_MS = 15000;",
    to: `const OCR_REFINE_TIME_BUDGET_MS = ${value};`,
    label: `budget=${value}`
});
const CONSENSUS_CURRENT = 'fuseOcrSymbols(best.blocks, others, { consensusClasses: ["kanji"] })';
// 整列一致による余剰文字の削除段(A)だけを外す。確信度の上限を0にすると
// どの文字も「確信度 < 上限」を満たさず、削除は一件も起きない。
const CONSENSUS_PRUNE_OFF = {
    from: "const OCR_PRUNE_INSERTION_MAX_CONFIDENCE = 95;",
    to: "const OCR_PRUNE_INSERTION_MAX_CONFIDENCE = 0;",
    label: "consensus-prune=off"
};
const FUSE_TRIGGER = "if (best === primary.data && glyphSize != null && glyphSize < OCR_FUSION_TRIGGER_GLYPH_PX) {";
const VARIANTS = {
    // 比較基準。OCR_E2E_BASELINE に旧版4ファイルを置いたディレクトリを指定する
    // （例: for f in constants.js ocr-image.js ocr-refine.js ocr-common.js;
    //        do git show "origin/develop:$f" > baseline/$f; done ）。
    baseline: () => loadSources(
        process.env.OCR_E2E_BASELINE || join(here, "baseline"), [BUDGET_PATCH(60000)]),
    head: () => loadSources(repo, [BUDGET_PATCH(60000)]),
    // 公開版(main)から**語彙辞書リランクだけ**を外したもの。辞書ファイルの取得先を
    // 存在しない名前にすると ocrWordSet が空集合になり、rerankOcrByDictionary が素通りする。
    // baseline と baseline-nodict の差＝辞書がもたらしていた効果そのもの
    // （他の変更が混じらない同一コード上での切り分け）。
    "baseline-nodict": () => loadSources(
        process.env.OCR_E2E_BASELINE || join(here, "baseline"), [BUDGET_PATCH(60000), {
            from: 'chrome.runtime.getURL("ocr-words.txt")',
            to: 'chrome.runtime.getURL("__ocr_words_absent__.txt")',
            label: "dictionary=off"
        }]),
    "head-consensus-off": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: CONSENSUS_CURRENT,
        to: "fuseOcrSymbols(best.blocks, others, { consensus: false })",
        label: "consensus=off"
    }]),
    "head-consensus-all": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: CONSENSUS_CURRENT,
        to: "fuseOcrSymbols(best.blocks, others)",
        label: "consensus=all"
    }]),
    "head-nocap": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_INSERTION_PRUNE_MAX_TOTAL_CANDIDATES = 50000;",
        to: "const OCR_INSERTION_PRUNE_MAX_TOTAL_CANDIDATES = Infinity;",
        label: "cap=inf"
    }]),
    // 二値化（拡大＋大津）段だけを一切走らせない。AAあり明朝で二値化が害になるかの測定用
    "head-nobinar": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "if (preprocessedAttempted || best.confidence >= OCR_PREPROCESS_SKIP_CONFIDENCE",
        to: "if (true || preprocessedAttempted || best.confidence >= OCR_PREPROCESS_SKIP_CONFIDENCE",
        label: "binarize=off"
    }]),
    "head-noprune": () => loadSources(repo, [BUDGET_PATCH(60000), CONSENSUS_PRUNE_OFF]),
    // 融合そのものを一切走らせない（複数倍率の結果で symbol を書き換えない）。
    // consensus-off は「全票一致による漢字の置換」だけを外すので、低確信度の置換は残る。
    // 融合が正味で効いているのかを媒体別に測るために、段ごと外した対照を用意する。
    // 罫線・枠線の除去だけを外す（最小長を無限大にすると1本も該当しない＝無変更）。
    "head-norule": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_RULE_MIN_LENGTH_PX = 24;",
        to: "const OCR_RULE_MIN_LENGTH_PX = Infinity;",
        label: "rule-removal=off"
    }]),
    // 主経路の確信度が十分高いときは複数倍率の融合段を丸ごと省く案（待ち時間の短縮）。
    // 前処理版を省く OCR_PREPROCESS_SKIP_CONFIDENCE=92 と同じ考え方。
    "head-fuseskip90": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: FUSE_TRIGGER,
        to: FUSE_TRIGGER.replace(") {", " && best.confidence < 90) {"),
        label: "fuse-skip>=90"
    }]),
    "head-fuseskip92": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: FUSE_TRIGGER,
        to: FUSE_TRIGGER.replace(") {", " && best.confidence < 92) {"),
        label: "fuse-skip>=92"
    }]),
    "head-prod-fuseskip92": () => loadSources(repo, [{
        from: FUSE_TRIGGER,
        to: FUSE_TRIGGER.replace(") {", " && best.confidence < 92) {"),
        label: "fuse-skip>=92 prod"
    }]),
    "head-prod-fuseskip90": () => loadSources(repo, [{
        from: FUSE_TRIGGER,
        to: FUSE_TRIGGER.replace(") {", " && best.confidence < 90) {"),
        label: "fuse-skip>=90 prod"
    }]),
    // 融合に使う倍率を固定 [1.5,2,3] ではなく、文字寸から LSTM 最適域(20/24/30px)を
    // 狙って決める案。小さい文字ほど3倍が最適域を通り越して重いだけになる。
    "head-fusescale": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const others = await collectUpscaledVariants(OCR_FUSION_SCALES);",
        to: "const others = await collectUpscaledVariants(OCR_CONSENSUS_TARGET_GLYPH_PX"
            + ".map((target) => Math.round((target / glyphSize) * 100) / 100)"
            + ".filter((scale) => scale > 1.05 && scale <= 3));",
        label: "fusion-scales=adaptive"
    }]),
    "head-prod-fusescale": () => loadSources(repo, [{
        from: "const others = await collectUpscaledVariants(OCR_FUSION_SCALES);",
        to: "const others = await collectUpscaledVariants(OCR_CONSENSUS_TARGET_GLYPH_PX"
            + ".map((target) => Math.round((target / glyphSize) * 100) / 100)"
            + ".filter((scale) => scale > 1.05 && scale <= 3));",
        label: "fusion-scales=adaptive prod"
    }]),
    // 前処理版（2倍＋大津二値化）を省く確信度のしきい値を下げる案（待ち時間の短縮）。
    // 実測の一例: 確信度91の縦書き入力で、二値化版は確信度61しか出さないのに2.96秒使う。
    "head-binskip88": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_PREPROCESS_SKIP_CONFIDENCE = 92;",
        to: "const OCR_PREPROCESS_SKIP_CONFIDENCE = 88;",
        label: "binarize-skip>=88"
    }]),
    "head-binskip85": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_PREPROCESS_SKIP_CONFIDENCE = 92;",
        to: "const OCR_PREPROCESS_SKIP_CONFIDENCE = 85;",
        label: "binarize-skip>=85"
    }]),
    "head-nofuse": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: CONSENSUS_CURRENT,
        to: "(void 0)",
        label: "fuse=off"
    }]),
    // 認識入力の余白付与だけを外す（余白 0px = 付与しない）
    "head-nopad": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_INPUT_PAD_PX = 10;",
        to: "const OCR_INPUT_PAD_PX = 0;",
        label: "pad=off"
    }]),
    // 余白を「文字の並ぶ向き」だけ広げる/直交方向だけ広げる（縦書きなら上下/左右）。
    // 45px 一律では大きなページで改善・小さな切り出しで悪化したため、方向別に切り分ける。
    "head-padtb45": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "        top: Math.max(0, minMargin - margins.top),",
        to: "        top: Math.max(0, 45 - margins.top),",
        label: "pad-top=45"
    }, {
        from: "        bottom: Math.max(0, minMargin - margins.bottom)",
        to: "        bottom: Math.max(0, 45 - margins.bottom)",
        label: "pad-bottom=45"
    }]),
    "head-padlr45": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "        left: Math.max(0, minMargin - margins.left),",
        to: "        left: Math.max(0, 45 - margins.left),",
        label: "pad-left=45"
    }, {
        from: "        right: Math.max(0, minMargin - margins.right),",
        to: "        right: Math.max(0, 45 - margins.right),",
        label: "pad-right=45"
    }]),
    // グレースケール化のときにガンマで暗部を持ち上げる（明朝の細線が小さい字で
    // 消えかける仮説の検証用。単発認識の実測では 1.5 が最良）。
    "head-gamma15": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "        pixels[i] = pixels[i + 1] = pixels[i + 2] = l;",
        to: "        pixels[i] = pixels[i + 1] = pixels[i + 2] = 255 * Math.pow(l / 255, 1.5);",
        label: "gamma=1.5"
    }]),
    "head-gamma18": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "        pixels[i] = pixels[i + 1] = pixels[i + 2] = l;",
        to: "        pixels[i] = pixels[i + 1] = pixels[i + 2] = 255 * Math.pow(l / 255, 1.8);",
        label: "gamma=1.8"
    }]),
    // 認識入力の余白付与の量を変える（列頭・列末の文字が不安定な仮説の検証用）
    "head-pad20": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_INPUT_PAD_PX = 10;",
        to: "const OCR_INPUT_PAD_PX = 20;",
        label: "pad=20"
    }]),
    "head-pad30": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_INPUT_PAD_PX = 10;",
        to: "const OCR_INPUT_PAD_PX = 30;",
        label: "pad=30"
    }]),
    "head-pad45": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_INPUT_PAD_PX = 10;",
        to: "const OCR_INPUT_PAD_PX = 45;",
        label: "pad=45"
    }]),
    // 「全票が base 以上」の漢字多数一致だけを外す（票の下限を Infinity にすると成立しない）
    "head-noconseq": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE = 95;",
        to: "const OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE = Infinity;",
        label: "consensus-equal=off"
    }]),
    // 列ピッチの基準を「長い列の span/文字数 の上位四分位」から「中央値」へ変える。
    // 上位四分位は文字が欠落した列（比が大きくなる）に引っ張られ、正しい列まで
    // 「1文字余分」と見なして削除していた（実測は work/prune-detail.json）。
    "head-pitchmed": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.75)];",
        to: "    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.5)];",
        label: "pitch=median"
    }]),
    // 上の中央値ピッチに加えて、列の先頭・末尾の文字を削除候補から外す
    // （pruneOcrConsensusInsertions が行頭・行末を対象外にしているのと同じ安全弁）。
    "head-pitchmed-noedge": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.75)];",
        to: "    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.5)];",
        label: "pitch=median"
    }, {
        from: "            const target = [...candidate.text];",
        to: "            if (candidate.deletedIndices.includes(0)"
            + " || candidate.deletedIndices.includes(baseLength - 1)) return;\n"
            + "            const target = [...candidate.text];",
        label: "prune-noedge"
    }]),
    // 物理セル数を「幾何（span/ピッチ）」だけで決めず、候補（別倍率の認識結果）の
    // 文字数の中央値と多い方を採る。幾何が1つ少なく出る系統誤差に対する二重の歯止め。
    "head-votecount": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "        const physicalCount = Math.round(baseLine.span / nominalPitch);\n"
            + "        const deleteCount = baseLength - physicalCount;\n"
            + "        if (deleteCount < 1 || deleteCount > 3) return;\n"
            + "\n"
            + "        const variantTexts = variants.map((lines) =>\n"
            + "            lines[lineIndex].entries.map((entry) => entry.symbol.text));",
        to: "        const variantTexts = variants.map((lines) =>\n"
            + "            lines[lineIndex].entries.map((entry) => entry.symbol.text));\n"
            + "        const variantLengths = variantTexts.map((chars) => chars.length)\n"
            + "            .sort((a, b) => a - b);\n"
            + "        const votedCount = variantLengths[Math.floor((variantLengths.length - 1) / 2)];\n"
            + "        const physicalCount = Math.max(\n"
            + "            Math.round(baseLine.span / nominalPitch), votedCount);\n"
            + "        const deleteCount = baseLength - physicalCount;\n"
            + "        if (deleteCount < 1 || deleteCount > 3) return;",
        label: "votecount"
    }]),
    "head-pitchmed-vote": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.75)];",
        to: "    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.5)];",
        label: "pitch=median"
    }, {
        from: "        const physicalCount = Math.round(baseLine.span / nominalPitch);\n"
            + "        const deleteCount = baseLength - physicalCount;\n"
            + "        if (deleteCount < 1 || deleteCount > 3) return;\n"
            + "\n"
            + "        const variantTexts = variants.map((lines) =>\n"
            + "            lines[lineIndex].entries.map((entry) => entry.symbol.text));",
        to: "        const variantTexts = variants.map((lines) =>\n"
            + "            lines[lineIndex].entries.map((entry) => entry.symbol.text));\n"
            + "        const variantLengths = variantTexts.map((chars) => chars.length)\n"
            + "            .sort((a, b) => a - b);\n"
            + "        const votedCount = variantLengths[Math.floor((variantLengths.length - 1) / 2)];\n"
            + "        const physicalCount = Math.max(\n"
            + "            Math.round(baseLine.span / nominalPitch), votedCount);\n"
            + "        const deleteCount = baseLength - physicalCount;\n"
            + "        if (deleteCount < 1 || deleteCount > 3) return;",
        label: "votecount"
    }]),
    // 短列の局所再確認が使うセル格子のピッチも中央値に揃える（同じ系統誤差の残り1か所）
    "head-rescanmed": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "        ? longPitches[Math.floor((longPitches.length - 1) * 0.75)]",
        to: "        ? longPitches[Math.floor((longPitches.length - 1) * OCR_LINE_PITCH_QUANTILE)]",
        label: "rescan-pitch=median"
    }]),
    "head-budget12": () => loadSources(repo, [BUDGET_PATCH(12000)]),
    "head-budget9": () => loadSources(repo, [BUDGET_PATCH(9000)]),
    "head-prod": () => loadSources(repo, []),
    // 実運用予算での待ち時間比較用（baseline の無改造版）
    "baseline-prod": () => loadSources(
        process.env.OCR_E2E_BASELINE || join(here, "baseline"), [])
};

// ---- 入力画像 ----
// 等倍(scale=1)のときは実機の cropToOcrCanvas と同じく「画素完全」で取り込む。
// @napi-rs/canvas は imageSmoothingQuality="high" だと1:1のdrawImageでも再標本化し、
// 2値ビットマップ描画のコーパスで階調が 2 → 33 に増えていた（実測 2026-08-16）。
// 出荷 ocr-image.js の cropToOcrCanvas は smoothing 品質を指定せず、
// 1:1 では画素完全（実測で差分0）なので等倍は smoothing を切って一致させる。
// 縮小/拡大(scale≠1)は「低解像度キャプチャの再現」であり、実機の
// createSmoothOcrCanvas と同じ高品質補間を従来どおり使う。
async function loadInputCanvas(spec) {
    const image = await loadImage(spec.file);
    const crop = spec.crop || { left: 0, top: 0, width: image.width, height: image.height };
    const scale = spec.scale || 1;
    const canvas = createCanvas(
        Math.round(crop.width * scale), Math.round(crop.height * scale));
    const context = canvas.getContext("2d");
    if (scale === 1) {
        context.imageSmoothingEnabled = false;
    } else {
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
    }
    context.drawImage(image, crop.left, crop.top, crop.width, crop.height,
        0, 0, canvas.width, canvas.height);
    if (Number.isFinite(spec.tight)) return tightCropCanvas(canvas, spec.tight);
    return canvas;
}

// 実利用の「タイトな選択」（文字が選択枠に接する）を模すため、インク境界 + margin px で
// 切り詰める。極性は平均輝度で決め、平均から30以上離れた画素をインクとみなす。
// コーパス画像は四辺に 12〜36px の余白があり、余白付与（padOcrCanvas）の効果は
// この入力でしか測れない。
function tightCropCanvas(canvas, margin) {
    const width = canvas.width;
    const height = canvas.height;
    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    const mean = sum / (width * height);
    const darkInk = mean >= 128;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
            const ink = darkInk ? l < mean - 30 : l > mean + 30;
            if (!ink) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return canvas;
    const x0 = Math.max(0, minX - margin);
    const y0 = Math.max(0, minY - margin);
    const x1 = Math.min(width - 1, maxX + margin);
    const y1 = Math.min(height - 1, maxY + margin);
    const out = createCanvas(x1 - x0 + 1, y1 - y0 + 1);
    const context = out.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
}

// ---- CER（読み上げに影響しない括弧の全角半角差は比較前に正規化する） ----
function normalizeForCer(text) {
    return (text || "").replace(/\s+/g, "")
        .replace(/\(/g, "（").replace(/\)/g, "）")
        // 箇条書きの中黒（CSSの • と全角中黒 ・）の違いは読み上げに影響しない（どちらも無音）
        .replace(/[•·‧･]/g, "・");
}
function levenshtein(a, b) {
    const s = [...a];
    const t = [...b];
    let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
    for (let i = 1; i <= s.length; i++) {
        const cur = [i];
        for (let j = 1; j <= t.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[t.length];
}

// ---- 実行 ----
const planFile = process.argv[2];
if (!planFile) throw new Error("usage: node harness.mjs <plan.json>");
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const results = [];
for (const run of plan.runs) {
    const api = makeApi(VARIANTS[run.variant]());
    const canvas = await loadInputCanvas(plan.inputs[run.input]);
    const pool = api.createOcrWorkerPool();
    const startedAt = Date.now();
    let outcome;
    try {
        outcome = await api.recognizeWithOrientation(canvas, pool.get);
    } finally {
        pool.terminate();
        // terminateはfire-and-forgetなのでワーカー破棄を少し待つ
        await new Promise((done) => setTimeout(done, 300));
    }
    const elapsedMs = Date.now() - startedAt;
    const gt = plan.inputs[run.input].gt || null;
    const entry = {
        input: run.input, variant: run.variant, elapsedMs,
        confidence: outcome.confidence, text: outcome.text
    };
    if (gt) {
        const gtNorm = normalizeForCer(gt);
        entry.errors = levenshtein(normalizeForCer(outcome.text), gtNorm);
        entry.gtLength = [...gtNorm].length;
        entry.cer = Math.round((entry.errors / entry.gtLength) * 10000) / 100;
    }
    results.push(entry);
    console.log(`${run.input} ${run.variant}: cer=${entry.cer ?? "-"} err=${entry.errors ?? "-"} conf=${outcome.confidence} ${elapsedMs}ms`);
}
const outFile = join(dirname(resolve(planFile)), `results_${basename(planFile, ".json")}.json`);
writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`wrote ${outFile}`);
