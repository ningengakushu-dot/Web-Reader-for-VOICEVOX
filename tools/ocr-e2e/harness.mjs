// 出荷コード(constants/ocr-image/ocr-refine/ocr-common)そのものをNodeで実行する
// 実機相当OCR回帰ハーネス。Tesseract.js v6 + 同梱traineddata + @napi-rs/canvas。
// 使い方は README.md を参照。精度A/Bは必ず逐次実行すること
// （過去の教訓: 並行実行は時間依存分岐で測定を汚染する）。
import { createWorker, PSM } from "tesseract.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
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
const VARIANTS = {
    // 比較基準。OCR_E2E_BASELINE に旧版4ファイルを置いたディレクトリを指定する
    // （例: for f in constants.js ocr-image.js ocr-refine.js ocr-common.js;
    //        do git show "origin/develop:$f" > baseline/$f; done ）。
    baseline: () => loadSources(
        process.env.OCR_E2E_BASELINE || join(here, "baseline"), [BUDGET_PATCH(60000)]),
    head: () => loadSources(repo, [BUDGET_PATCH(60000)]),
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
    // 認識入力の余白付与だけを外す（余白 0px = 付与しない）
    "head-nopad": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_INPUT_PAD_PX = 10;",
        to: "const OCR_INPUT_PAD_PX = 0;",
        label: "pad=off"
    }]),
    // 「全票が base 以上」の漢字多数一致だけを外す（票の下限を Infinity にすると成立しない）
    "head-noconseq": () => loadSources(repo, [BUDGET_PATCH(60000), {
        from: "const OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE = 95;",
        to: "const OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE = Infinity;",
        label: "consensus-equal=off"
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
        .replace(/\(/g, "（").replace(/\)/g, "）");
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
