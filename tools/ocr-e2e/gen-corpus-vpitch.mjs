// 縦書きの「送りが一定でない」条件のコーパス。
//
// これまでのコーパスは等幅の明朝・ゴシックばかりで、**プロポーショナルフォント**
// （ＭＳ Ｐ明朝 / ＭＳ Ｐゴシック）の縦書きを一度も測っていなかった。
// 縦書きのプロポーショナル書体は句読点・括弧・約物の送りを詰めるため、
// 「列の長さ ÷ 文字数」が1文字ぶんの送りと一致しなくなる。この比を使って
// 余分な文字を消す段（pruneOcrLineInsertions / OCR_LINE_PITCH_QUANTILE）が
// 誤作動すると、**実在する本文が削除される**。その回帰を測るためのコーパス。
//
// 併せて、ワープロ文書でよくある条件も入れる:
//   ・太字の見出し行が本文の列と混在する
//   ・段落記号（↵）のような小さな記号が列末に付く
//   ・文字が大きい（20〜28px）
//
// 使い方:
//   OCR_CHROMIUM="C:\Program Files\Google\Chrome\Application\chrome.exe" node gen-corpus-vpitch.mjs [出力先]
//   → work/corpus_vpitch_*.png + work/corpus-vpitch.json
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

// 自作の文章（著作物を含めない）。句読点・括弧・長音・促音・拗音を多めに入れて、
// プロポーショナル書体で送りが詰まる箇所を作る。
const BODY = "目的地までは徒歩で向かう。それが最も確実で、気づかれにくい方法だからだ。"
    + "あたりは雪が深く積もっていて、真夏に訪れたときとは別の場所のように思えた。"
    + "緑に溢れたあの場所も美しかったが、一面が白く彩られた今もまた美しい。"
    + "景色が夏と冬で全く別の様相を見せるというのは、この土地の素晴らしいところだ。";
const HEADING = "等幅とプロポーショナルの比較";

const FONTS = {
    msmin: { css: '"ＭＳ 明朝","MS Mincho",serif', label: "ＭＳ 明朝（等幅）" },
    mspmin: { css: '"ＭＳ Ｐ明朝","MS PMincho",serif', label: "ＭＳ Ｐ明朝（プロポーショナル）" },
    mspgo: { css: '"ＭＳ Ｐゴシック","MS PGothic",sans-serif', label: "ＭＳ Ｐゴシック（プロポーショナル）" },
    yumin: { css: '"游明朝","Yu Mincho",serif', label: "游明朝" }
};
const CONTROLS = {
    default_standard: '"__NoSuchFontFamily__ZZZ__"',
    serif: "serif",
    sans: "sans-serif"
};

const SAMPLES = [
    { font: "msmin", px: 20, dsf: 1 },
    { font: "mspmin", px: 20, dsf: 1 },
    { font: "msmin", px: 24, dsf: 1 },
    { font: "mspmin", px: 24, dsf: 1 },
    { font: "mspmin", px: 20, dsf: 1.25 },
    { font: "mspmin", px: 28, dsf: 1 },
    { font: "mspgo", px: 20, dsf: 1 },
    { font: "mspgo", px: 24, dsf: 1.25 },
    { font: "yumin", px: 24, dsf: 1 },
    // 太字の見出し行を先頭に置いた版（ワープロ文書の体裁）
    { font: "msmin", px: 24, dsf: 1, heading: true },
    { font: "mspmin", px: 24, dsf: 1, heading: true },
    { font: "mspmin", px: 20, dsf: 1.25, heading: true }
];

function buildHtml({ fontCss, px, heading }) {
    const head = heading
        ? `<p style="margin:0 0 1em 0;font-weight:700">${HEADING}</p>` : "";
    return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#ffffff;">`
        + `<div id="t" style="font-family:${fontCss.replace(/"/g, "&quot;")};`
        + `font-size:${px}px;line-height:1.9;color:#111111;background:#ffffff;padding:14px;`
        + `writing-mode:vertical-rl;height:${Math.round(px * 26)}px;width:max-content;">`
        + `${head}<p style="margin:0">${BODY}</p></div>`;
}

const browser = await chromium.launch({ executablePath });

const probePage = await browser.newPage({
    deviceScaleFactor: 1, viewport: { width: 1400, height: 900 } });
async function probeHash(fontCss) {
    await probePage.setContent(buildHtml({ fontCss, px: 24, heading: false }));
    await probePage.waitForTimeout(60);
    const png = await probePage.locator("#t").screenshot();
    return createHash("sha1").update(png).digest("hex").slice(0, 16);
}
const controlHashes = {};
for (const [id, css] of Object.entries(CONTROLS)) controlHashes[id] = await probeHash(css);
const fontCheck = {};
for (const [id, font] of Object.entries(FONTS)) {
    const hash = await probeHash(font.css);
    const alias = Object.entries(controlHashes).filter(([, h]) => h === hash).map(([k]) => k);
    fontCheck[id] = { label: font.label, css: font.css, hash, aliasOf: alias,
        resolved: !alias.includes("default_standard") };
    console.log(`${id.padEnd(7)} ${font.label.padEnd(28)} hash=${hash} `
        + `alias=[${alias.join(",")}] resolved=${fontCheck[id].resolved}`);
}
await probePage.close();
// 等幅とプロポーショナルが同じ描画になっていないか（＝片方が解決されていない）も見る
if (fontCheck.msmin.hash === fontCheck.mspmin.hash) {
    console.log("!! ＭＳ 明朝 と ＭＳ Ｐ明朝 の描画が同一。プロポーショナルの条件を測れていない");
}
const dropped = Object.entries(fontCheck).filter(([, v]) => !v.resolved).map(([k]) => k);
if (dropped.length) console.log(`!! 未解決フォントを除外: ${dropped.join(", ")}`);

const pages = new Map();
async function pageFor(dsf) {
    if (!pages.has(dsf)) {
        pages.set(dsf, await browser.newPage({
            deviceScaleFactor: dsf, viewport: { width: 1800, height: 1200 } }));
    }
    return pages.get(dsf);
}

const manifest = [];
for (const sample of SAMPLES) {
    if (dropped.includes(sample.font)) continue;
    const font = FONTS[sample.font];
    const name = [sample.font, sample.px, `dsf${String(sample.dsf).replace(".", "")}`,
        sample.heading ? "head" : null].filter((p) => p !== null).join("_");
    const page = await pageFor(sample.dsf);
    await page.setContent(buildHtml({ fontCss: font.css, px: sample.px, heading: sample.heading }));
    await page.waitForTimeout(150);
    const el = page.locator("#t");
    const file = resolve(outDir, `corpus_vpitch_${name}.png`);
    await el.screenshot({ path: file });
    const gt = await el.evaluate((node) => {
        const parts = [];
        for (const p of node.querySelectorAll("p")) parts.push(p.textContent.trim());
        return parts.join(" ");
    });
    // 列ごとの文字数のばらつき（プロポーショナルでどれだけ送りが不均一になるかの目安）
    const pitch = await page.evaluate(() => {
        const range = document.createRange();
        const node = document.querySelector("#t p:last-of-type").firstChild;
        const heights = [];
        for (let i = 0; i < Math.min(node.length, 60); i++) {
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const r = range.getBoundingClientRect();
            if (r.height > 0) heights.push(Math.round(r.height * 10) / 10);
        }
        const uniq = [...new Set(heights)].sort((a, b) => a - b);
        return { min: uniq[0], max: uniq[uniq.length - 1], distinct: uniq.length };
    });
    const box = await el.boundingBox();
    manifest.push({
        name, file, gt, font: sample.font, fontLabel: font.label, fontCss: font.css,
        px: sample.px, dsf: sample.dsf, vertical: true, heading: !!sample.heading,
        devicePx: Math.round(sample.px * sample.dsf),
        advanceMin: pitch.min, advanceMax: pitch.max, advanceDistinct: pitch.distinct,
        width: Math.round(box.width * sample.dsf), height: Math.round(box.height * sample.dsf)
    });
    console.log(`${name}: ${Math.round(box.width * sample.dsf)}x`
        + `${Math.round(box.height * sample.dsf)} ${gt.length}文字 `
        + `送り ${pitch.min}〜${pitch.max}px（${pitch.distinct}種）`);
}
for (const page of pages.values()) await page.close();
await browser.close();

await writeFile(resolve(outDir, "corpus-vpitch.json"), JSON.stringify(manifest, null, 1));
await writeFile(resolve(outDir, "corpus-vpitch-fontcheck.json"),
    JSON.stringify({ controls: controlHashes, fonts: fontCheck }, null, 1));
console.log(`corpus-vpitch done: ${manifest.length} samples -> ${outDir}`);
