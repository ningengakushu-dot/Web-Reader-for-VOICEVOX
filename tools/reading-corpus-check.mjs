// 多様なテキストを出荷コードの整形・分割にかけ、実際の VOICEVOX エンジンで1件ずつ合成して、
// 「途切れ（無音）」「失敗」「不自然な読み」を計測する実機検証ツール。
//
//   node tools/reading-corpus-check.mjs [--only name,name] [--no-synth] [--json out.json]
//
// - 出荷コード（background.js の splitText / ocr-common.js の normalizeOcrText・cleanForSpeech）を
//   vm で読み込んで使う（コピーではなく実物）。content.js の cleanMessage は 2 行なので同等処理を置く。
// - 各件について audio_query（読み仮名・モーラ数・見積もり秒数・所要時間）と synthesis（所要時間・
//   実音声長）を測る。
// - 再生パイプライン（再生中の1件＋先読み）を模擬し、文の間の無音（gap）と開始までの待ち時間を出す。
//   旧方式（先読み1件）と現行方式（件数・秒数の上限まで先読み）の両方を計算して比較する。
// - CI では動かない（ローカルのエンジン http://127.0.0.1:50021 が必要）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { CORPUS } from "./reading-corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const only = opt("--only")?.split(",") || null;
const noSynth = args.includes("--no-synth");
const jsonOut = opt("--json");
const speaker = Number(opt("--speaker") || 3);
const BASE = "http://127.0.0.1:50021";

// ---- 出荷コードの読み込み ----
function loadBackground() {
    const source = readFileSync(resolve(repo, "background.js"), "utf8")
        + "\n;globalThis.__api = { splitText, sanitizeSpeechText, speechCost, SPEECH_SOFT_COST };";
    const noop = () => {};
    const chrome = {
        runtime: { id: "x", getURL: (p) => p, getContexts: async () => [], sendMessage: async () => ({}), onInstalled: { addListener: noop }, onMessage: { addListener: noop }, openOptionsPage: noop },
        scripting: { executeScript: async () => {} },
        storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
        contextMenus: { removeAll: (cb) => cb && cb(), create: noop, onClicked: { addListener: noop } },
        action: { onClicked: { addListener: noop }, setBadgeBackgroundColor: noop, setBadgeText: noop, setTitle: noop },
        commands: { onCommand: { addListener: noop } },
        tabs: { sendMessage: async () => {}, query: async () => [], create: async () => {}, captureVisibleTab: async () => "", onRemoved: { addListener: noop }, onUpdated: { addListener: noop } },
        offscreen: { createDocument: async () => {} }
    };
    const ctx = vm.createContext({ console, chrome, importScripts: noop, setTimeout, clearTimeout, Promise, Date,
        VOICEVOX_BASE_URL: BASE, VOICEVOX_FETCH_TIMEOUT_MS: 1, SETTING_DEFAULTS: {}, CAPTURE_STORAGE_KEY: "c",
        CAPTURE_MAX_DATAURL_LENGTH: 1, PLAYBACK_TAB_STORAGE_KEY: "p", fetch: async () => { throw new Error(); },
        OffscreenCanvas: function () {}, createImageBitmap: async () => ({}), btoa: () => "" });
    vm.runInContext(source, ctx, { filename: "background.js" });
    return ctx.__api;
}
function loadOcrText() {
    const source = ["constants.js", "ocr-image.js", "ocr-refine.js", "ocr-common.js"]
        .map((f) => readFileSync(resolve(repo, f), "utf8")).join("\n;\n")
        + "\n;globalThis.__api = { normalizeOcrText, cleanForSpeech };";
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Set, RegExp,
        Number, Array, Object, String, Uint8Array, Uint8ClampedArray, Int32Array, Infinity, NaN, isFinite,
        document: { createElement: () => ({ getContext: () => null }) }, chrome: { runtime: { getURL: (p) => p } },
        Tesseract: { PSM: {}, createWorker: async () => ({}) } });
    vm.runInContext(source, ctx, { filename: "ocr.js" });
    return ctx.__api;
}
// content.js cleanMessage と同等（URL置換・改行は残す）
function cleanMessage(text) {
    return text.replace(/https?:\/\/[\w\/:%#\$&\?\(\)~\.=\+\-]+/g, "URL省略")
        .replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

const bg = loadBackground();
const ocr = loadOcrText();

function prepare(item) {
    if (item.path === "ocr") return ocr.cleanForSpeech(ocr.normalizeOcrText(item.text));
    return cleanMessage(item.text);
}

// ---- 実エンジン ----
async function query(text) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: "POST" });
    const ms = performance.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, ms };
    const q = await res.json();
    let moras = 0;
    let est = q.prePhonemeLength + q.postPhonemeLength;
    for (const p of q.accent_phrases) {
        moras += p.moras.length;
        for (const m of p.moras) est += (m.consonant_length || 0) + m.vowel_length;
        if (p.pause_mora) est += p.pause_mora.vowel_length;
    }
    return { ok: true, ms, kana: q.kana, moras, est, q };
}
async function synth(q) {
    q.prePhonemeLength = 0.1; q.postPhonemeLength = 0.1;
    const t0 = performance.now();
    const res = await fetch(`${BASE}/synthesis?speaker=${speaker}`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(q) });
    const ms = performance.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, ms };
    const buf = await res.arrayBuffer();
    return { ok: true, ms, audioSec: (buf.byteLength - 44) / (24000 * 2) };
}

// ---- 再生パイプラインの模擬 ----
// synth[i]: 合成秒, audio[i]: 音声秒。合成は直列。再生は前の音声が終わり次第。
// 先読み条件: 完成済み（未再生）の件数 < maxItems かつ合計秒 < maxSeconds のとき次の合成を始める。
function simulate(synthSec, audioSec, { maxItems, maxSeconds }) {
    const n = synthSec.length;
    const readyAt = [], playStart = [], playEnd = [];
    let synthFree = 0;
    for (let j = 0; j < n; j++) {
        // 合成開始可能時刻: synthFree 以降で、先読み条件を満たす最初の時刻
        const candidates = [synthFree, ...playStart.filter((t) => t > synthFree)].sort((a, b) => a - b);
        let start = candidates[candidates.length - 1];
        for (const t of candidates) {
            const buffered = [];
            for (let i = 0; i < j; i++) if (playStart[i] > t) buffered.push(i);
            const secs = buffered.reduce((s, i) => s + audioSec[i], 0);
            if (buffered.length < maxItems && secs < maxSeconds) { start = t; break; }
        }
        readyAt[j] = start + synthSec[j];
        synthFree = readyAt[j];
        playStart[j] = j === 0 ? readyAt[j] : Math.max(playEnd[j - 1], readyAt[j]);
        playEnd[j] = playStart[j] + audioSec[j];
    }
    const gaps = playStart.map((t, j) => (j === 0 ? 0 : t - playEnd[j - 1]));
    return { startLatency: playStart[0] || 0, maxGap: Math.max(0, ...gaps.slice(1)), gaps,
        totalGap: gaps.slice(1).reduce((s, g) => s + g, 0) };
}

// ---- 実行 ----
const results = [];
const items = CORPUS.filter((c) => !only || only.includes(c.name));
console.log(`corpus: ${items.length} items, speaker=${speaker}, synth=${!noSynth}`);
for (const item of items) {
    const prepared = prepare(item);
    const chunks = bg.splitText(prepared);
    const row = { name: item.name, path: item.path, chars: item.text.length, prepared, chunks: [], errors: [] };
    for (const chunk of chunks) {
        const c = { text: chunk, cost: bg.speechCost(chunk) };
        const q = await query(chunk);
        c.queryMs = Math.round(q.ms);
        if (!q.ok) { c.error = `audio_query HTTP ${q.status}`; row.errors.push(c.error); row.chunks.push(c); continue; }
        c.kana = q.kana; c.moras = q.moras; c.estSec = +q.est.toFixed(2);
        if (!noSynth) {
            const s = await synth(q.q);
            c.synthMs = Math.round(s.ms);
            if (!s.ok) { c.error = `synthesis HTTP ${s.status}`; row.errors.push(c.error); }
            else c.audioSec = +s.audioSec.toFixed(2);
            if (c.synthMs > 60000) row.errors.push(`synthesis timeout ${c.synthMs}ms`);
        }
        if (q.ms > 15000) row.errors.push(`audio_query timeout ${Math.round(q.ms)}ms`);
        row.chunks.push(c);
    }
    if (!noSynth) {
        const synthSec = row.chunks.map((c) => ((c.queryMs || 0) + (c.synthMs || 0)) / 1000);
        const audioSec = row.chunks.map((c) => c.audioSec || 0.2);
        row.old = simulate(synthSec, audioSec, { maxItems: 1, maxSeconds: Infinity });
        row.now = simulate(synthSec, audioSec, { maxItems: 24, maxSeconds: 45 });
        row.audioTotal = +audioSec.reduce((a, b) => a + b, 0).toFixed(1);
        row.synthTotal = +synthSec.reduce((a, b) => a + b, 0).toFixed(1);
    }
    results.push(row);
    const gapInfo = row.now ? ` audio=${row.audioTotal}s synth=${row.synthTotal}s start=${row.now.startLatency.toFixed(1)}s maxGap(now)=${row.now.maxGap.toFixed(1)}s maxGap(old)=${row.old.maxGap.toFixed(1)}s` : "";
    console.log(`\n### ${row.name} [${row.path}] chunks=${chunks.length}${gapInfo}${row.errors.length ? " ERRORS=" + row.errors.join("; ") : ""}`);
    for (const c of row.chunks) {
        const timing = c.audioSec != null ? ` a=${c.audioSec}s s=${((c.queryMs + c.synthMs) / 1000).toFixed(1)}s` : "";
        console.log(`  [${c.cost}]${timing} ${JSON.stringify(c.text)}\n        → ${c.kana ?? c.error}`);
    }
}

// ---- 総括 ----
const withGap = results.filter((r) => r.now);
const worst = withGap.slice().sort((a, b) => b.now.maxGap - a.now.maxGap).slice(0, 5);
console.log("\n===== summary =====");
console.log(`items=${results.length} chunks=${results.reduce((s, r) => s + r.chunks.length, 0)} errors=${results.reduce((s, r) => s + r.errors.length, 0)}`);
if (withGap.length) {
    console.log(`maxGap now: ${Math.max(...withGap.map((r) => r.now.maxGap)).toFixed(1)}s / old: ${Math.max(...withGap.map((r) => r.old.maxGap)).toFixed(1)}s`);
    console.log(`start latency max: ${Math.max(...withGap.map((r) => r.now.startLatency)).toFixed(1)}s`);
    for (const r of worst) console.log(`  ${r.name}: gap now=${r.now.maxGap.toFixed(1)}s old=${r.old.maxGap.toFixed(1)}s start=${r.now.startLatency.toFixed(1)}s`);
}
for (const r of results.filter((x) => x.errors.length)) console.log(`  ERROR ${r.name}: ${r.errors.join("; ")}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
