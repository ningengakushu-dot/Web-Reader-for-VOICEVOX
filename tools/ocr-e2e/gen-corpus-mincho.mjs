// AAあり明朝コーパス生成（実ユーザー条件の再現）。
//
// 既存 gen-corpus.mjs / work/corpus.json は変更しない。こちらは work/corpus_mincho_*.png と
// work/corpus-mincho.json を出力する。
//
// 背景: 既存コーパスの明朝は「ＭＳ 明朝 13〜16px」で、この帯の MS 書体は埋め込み
// ビットマップが使われるため **アンチエイリアスが付かない**（輝度2階調）。実ユーザーが
// 見ている明朝（游明朝 / BIZ UD明朝 / Noto Serif JP、16〜24px、表示スケール 1.25〜1.5）は
// AAありのグレースケール画像であり、既存コーパスでは再現されていなかった。
// ＭＳ 明朝の「AAが付かない」事実は既存コーパスで担保済みなので、ここには入れない。
//
// 使い方:
//   OCR_CHROMIUM="C:\Program Files\Google\Chrome\Application\chrome.exe" node gen-corpus-mincho.mjs [出力先]
//
// フォントの実在確認: document.fonts.check は**存在しない名前でも true を返す**ため
// （実測: "__NoSuchFontFamily__ZZZ" が OK）使わない。代わりに
//   - 架空フォント単独＝「既定の標準フォント」
//   - serif 単独 / sans-serif 単独
// の3つを対照として描画し、ピクセルハッシュの一致で解決先を判定する。
// 対照のいずれとも一致しない（または serif と一致する＝その書体が既定serif）ことを
// 記録し、フォールバック描画を明朝と誤記しないようにする。
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] || resolve(here, "work"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.OCR_CHROMIUM
    || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// 既存 gen-corpus.mjs と同一の3本（青空文庫・パブリックドメイン）を使い回す。
const RASHOMON = "ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。広い門の下には、この男のほかに誰もいない。ただ、所々丹塗の剥げた、大きな円柱に、蟋蟀が一匹とまっている。羅生門が、朱雀大路にある以上は、この男のほかにも、雨やみをする市女笠や揉烏帽子が、もう二三人はありそうなものである。";
const NEKO = "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。";
const MELOS = "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。メロスには政治がわからぬ。メロスは、村の牧人である。笛を吹き、羊と遊んで暮して来た。けれども邪悪に対しては、人一倍に敏感であった。きょう未明メロスは村を出発し、野を越え山越え、十里はなれたこの市にやって来た。";
const TEXTS = { rashomon: RASHOMON, neko: NEKO, melos: MELOS };

const FONTS = {
    yumin: { css: '"游明朝","Yu Mincho",serif', kind: "mincho", label: "游明朝" },
    bizud: { css: '"BIZ UDPMincho","BIZ UD明朝",serif', kind: "mincho", label: "BIZ UD明朝" },
    noto: { css: '"Noto Serif JP",serif', kind: "mincho", label: "Noto Serif JP" },
    msgo: { css: '"ＭＳ ゴシック","MS Gothic",monospace', kind: "gothic", label: "ＭＳ ゴシック" },
    yugo: { css: '"游ゴシック","Yu Gothic",sans-serif', kind: "gothic", label: "游ゴシック" }
};

// 24枚。dsf=1.5 は「表示スケール1.5の実利用」の再現で、16px CSS が 24 デバイスpx に
// なるため glyphSize>=18 分岐（従来コーパスで一度も測られていない）へ入る。
const SAMPLES = [
    // --- deviceScaleFactor = 1 ---
    { font: "yumin", text: "rashomon", vertical: true, px: 16, dsf: 1 },
    { font: "yumin", text: "neko", vertical: true, px: 19, dsf: 1 },
    { font: "yumin", text: "melos", vertical: true, px: 24, dsf: 1 },
    { font: "yumin", text: "melos", vertical: false, px: 16, dsf: 1 },
    { font: "bizud", text: "neko", vertical: true, px: 16, dsf: 1 },
    { font: "bizud", text: "melos", vertical: true, px: 19, dsf: 1 },
    { font: "bizud", text: "rashomon", vertical: false, px: 19, dsf: 1 },
    { font: "noto", text: "melos", vertical: true, px: 16, dsf: 1 },
    { font: "noto", text: "rashomon", vertical: true, px: 19, dsf: 1 },
    { font: "noto", text: "neko", vertical: false, px: 24, dsf: 1 },
    // --- deviceScaleFactor = 1.5（実機の表示スケール） ---
    { font: "yumin", text: "neko", vertical: true, px: 16, dsf: 1.5 },
    { font: "yumin", text: "melos", vertical: true, px: 19, dsf: 1.5 },
    { font: "yumin", text: "rashomon", vertical: false, px: 16, dsf: 1.5 },
    { font: "bizud", text: "rashomon", vertical: true, px: 16, dsf: 1.5 },
    { font: "bizud", text: "neko", vertical: true, px: 19, dsf: 1.5 },
    { font: "noto", text: "neko", vertical: true, px: 16, dsf: 1.5 },
    { font: "noto", text: "melos", vertical: true, px: 19, dsf: 1.5 },
    { font: "noto", text: "melos", vertical: false, px: 16, dsf: 1.5 },
    // --- 暗背景 ---
    { font: "yumin", text: "rashomon", vertical: true, px: 19, dsf: 1, dark: true },
    { font: "bizud", text: "melos", vertical: true, px: 16, dsf: 1.5, dark: true },
    // --- 対照（ゴシック。上の明朝サンプルと同一テキスト・同一サイズ・同一条件） ---
    { font: "msgo", text: "rashomon", vertical: true, px: 16, dsf: 1 },
    { font: "msgo", text: "neko", vertical: true, px: 19, dsf: 1 },
    { font: "yugo", text: "melos", vertical: true, px: 19, dsf: 1 },
    { font: "yugo", text: "rashomon", vertical: true, px: 16, dsf: 1.5 }
];

const CONTROLS = {
    default_standard: '"__NoSuchFontFamily__ZZZ"',
    serif: "serif",
    sans: "sans-serif"
};

function buildHtml({ fontCss, px, vertical, dark, text }) {
    const fg = dark ? "#dddddd" : "#222222";
    const bg = dark ? "#1e1e1e" : "#ffffff";
    // 既存 gen-corpus.mjs と同じ組版（行方向を固定・列方向は max-content。
    // 溢れると正解と画像がずれるため）。
    const flow = vertical
        ? `writing-mode: vertical-rl; height: ${Math.round(px * 28)}px; width: max-content;`
        : `width: ${Math.round(px * 32)}px; height: max-content;`;
    return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${bg};">`
        + `<div id="t" style="font-family:${fontCss.replace(/"/g, "&quot;")};`
        + `font-size:${px}px;line-height:1.9;color:${fg};background:${bg};`
        + `padding:12px;${flow}">${text}</div>`;
}

const browser = await chromium.launch({ executablePath });

// ---- 1) フォント解決の実測（架空/serif/sans の3対照とのピクセル一致で判定） ----
const probePage = await browser.newPage({
    deviceScaleFactor: 1, viewport: { width: 1200, height: 800 } });
async function probeHash(fontCss) {
    await probePage.setContent(buildHtml({
        fontCss, px: 24, vertical: false, dark: false,
        text: "ある日の暮方の事である。羅生門の下で雨やみを待っていた。" }));
    await probePage.waitForTimeout(60);
    const el = probePage.locator("#t");
    const png = await el.screenshot();
    const box = await el.boundingBox();
    return { hash: createHash("sha1").update(png).digest("hex").slice(0, 16),
        width: Math.round(box.width) };
}
const controlHashes = {};
for (const [id, css] of Object.entries(CONTROLS)) controlHashes[id] = await probeHash(css);
console.log("controls:", JSON.stringify(controlHashes));

const fontCheck = {};
for (const [id, font] of Object.entries(FONTS)) {
    const got = await probeHash(font.css);
    const alias = Object.entries(controlHashes)
        .filter(([, c]) => c.hash === got.hash).map(([k]) => k);
    // 「既定の標準フォント（架空名の落ち先）」と一致＝指定書体が解決されていない疑い。
    const resolved = !alias.includes("default_standard");
    fontCheck[id] = { label: font.label, css: font.css, kind: font.kind,
        hash: got.hash, width: got.width, aliasOf: alias, resolved };
    console.log(`${id.padEnd(6)} ${font.label.padEnd(14)} hash=${got.hash} w=${got.width} `
        + `alias=[${alias.join(",")}] resolved=${resolved}`);
}
await probePage.close();

const dropped = Object.entries(fontCheck).filter(([, v]) => !v.resolved).map(([k]) => k);
if (dropped.length) {
    console.log(`!! 未解決フォントを除外: ${dropped.join(", ")}`);
}

// ---- 2) サンプル生成 ----
const pages = new Map();
async function pageFor(dsf) {
    if (!pages.has(dsf)) {
        pages.set(dsf, await browser.newPage({
            deviceScaleFactor: dsf, viewport: { width: 1600, height: 1200 } }));
    }
    return pages.get(dsf);
}

const manifest = [];
for (const sample of SAMPLES) {
    if (dropped.includes(sample.font)) continue;
    const font = FONTS[sample.font];
    const name = [sample.font, sample.text, sample.vertical ? "v" : "h", sample.px,
        `dsf${String(sample.dsf).replace(".", "")}`, sample.dark ? "dark" : null]
        .filter((p) => p !== null).join("_");
    const page = await pageFor(sample.dsf);
    await page.setContent(buildHtml({
        fontCss: font.css, px: sample.px, vertical: sample.vertical,
        dark: !!sample.dark, text: TEXTS[sample.text] }));
    await page.waitForTimeout(150);
    const el = page.locator("#t");
    const file = resolve(outDir, `corpus_mincho_${name}.png`);
    await el.screenshot({ path: file });
    const gt = await el.evaluate((node) => node.textContent);
    const box = await el.boundingBox();
    // 実際に描かれた画素の統計（AAの有無を数値で残す）。
    const stats = await page.evaluate(async ([px, vertical, dark, fontCss, text]) => {
        const canvas = document.createElement("canvas");
        const ratio = window.devicePixelRatio;
        canvas.width = Math.ceil(px * 20 * ratio);
        canvas.height = Math.ceil(px * 3 * ratio);
        const ctx = canvas.getContext("2d");
        ctx.scale(ratio, ratio);
        ctx.fillStyle = dark ? "#1e1e1e" : "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = dark ? "#dddddd" : "#222222";
        ctx.font = `${px}px ${fontCss}`;
        ctx.textBaseline = "top";
        ctx.fillText(text.slice(0, 18), 2, 2);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const levels = new Set();
        let ink = 0;
        let mid = 0;
        for (let i = 0; i < data.length; i += 4) {
            const l = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            levels.add(l);
            const inkness = dark ? l / 255 : 1 - l / 255;
            if (inkness > 0.15) { ink++; if (inkness < 0.75) mid++; }
        }
        return { levels: levels.size,
            midShare: ink ? Math.round((mid / ink) * 1000) / 10 : 0 };
    }, [sample.px, sample.vertical, !!sample.dark, font.css, TEXTS[sample.text]]);

    manifest.push({
        name, file, gt,
        font: sample.font, fontLabel: font.label, fontCss: font.css, fontKind: font.kind,
        fontResolved: fontCheck[sample.font].resolved,
        fontAliasOf: fontCheck[sample.font].aliasOf,
        px: sample.px, vertical: sample.vertical, dsf: sample.dsf, dark: !!sample.dark,
        devicePx: Math.round(sample.px * sample.dsf),
        width: Math.round(box.width * sample.dsf), height: Math.round(box.height * sample.dsf),
        aaLevels: stats.levels, aaMidShare: stats.midShare
    });
    console.log(`${name}: ${Math.round(box.width * sample.dsf)}x${Math.round(box.height * sample.dsf)} `
        + `${gt.length}文字 階調=${stats.levels} 中間調=${stats.midShare}%`);
}
for (const page of pages.values()) await page.close();
await browser.close();

await writeFile(resolve(outDir, "corpus-mincho.json"), JSON.stringify(manifest, null, 1));
await writeFile(resolve(outDir, "corpus-mincho-fontcheck.json"),
    JSON.stringify({ controls: controlHashes, fonts: fontCheck }, null, 1));
console.log(`corpus-mincho done: ${manifest.length} samples -> ${outDir}`);
