// 実文書コーパス生成: 青空文庫（パブリックドメイン）冒頭部を実フォントでChrome描画し、
// 要素スクリーンショットとDOM由来の正解テキストを厳密に対にする。
// GTは「実際に描画した文字列」なので、原文との細部の異同は測定の妥当性に影響しない。
// 使い方: OCR_CHROMIUM=<chrome.exeのパス> node gen-corpus.mjs [出力ディレクトリ]
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] || resolve(here, "work"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.OCR_CHROMIUM;
if (!executablePath) throw new Error("set OCR_CHROMIUM to a Chromium executable path");

const RASHOMON = "ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。広い門の下には、この男のほかに誰もいない。ただ、所々丹塗の剥げた、大きな円柱に、蟋蟀が一匹とまっている。羅生門が、朱雀大路にある以上は、この男のほかにも、雨やみをする市女笠や揉烏帽子が、もう二三人はありそうなものである。";
const NEKO = "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。";
const MELOS = "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。メロスには政治がわからぬ。メロスは、村の牧人である。笛を吹き、羊と遊んで暮して来た。けれども邪悪に対しては、人一倍に敏感であった。きょう未明メロスは村を出発し、野を越え山越え、十里はなれたこの市にやって来た。";

const SAMPLES = [
    { name: "rashomon_v_mincho_14", text: RASHOMON, vertical: true, font: '"ＭＳ 明朝","MS Mincho",serif', px: 14, dark: false },
    { name: "neko_v_gothic_18", text: NEKO, vertical: true, font: '"ＭＳ ゴシック","MS Gothic",monospace', px: 18, dark: false },
    { name: "melos_h_gothic_13", text: MELOS, vertical: false, font: '"ＭＳ ゴシック","MS Gothic",monospace', px: 13, dark: false },
    { name: "melos_v_mincho_16_dark", text: MELOS, vertical: true, font: '"ＭＳ 明朝","MS Mincho",serif', px: 16, dark: true },
    { name: "rashomon_h_mincho_15", text: RASHOMON, vertical: false, font: '"ＭＳ 明朝","MS Mincho",serif', px: 15, dark: false },
    { name: "neko_v_mincho_13", text: NEKO, vertical: true, font: '"ＭＳ 明朝","MS Mincho",serif', px: 13, dark: false }
];

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1400, height: 1000 } });
const manifest = [];
for (const sample of SAMPLES) {
    const fg = sample.dark ? "#dddddd" : "#222222";
    const bg = sample.dark ? "#1e1e1e" : "#ffffff";
    const flow = sample.vertical
        ? `writing-mode: vertical-rl; height: ${Math.round(sample.px * 28)}px; width: max-content;`
        : `width: ${Math.round(sample.px * 32)}px; height: max-content;`;
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${bg};">`
        + `<div id="t" style="font-family:${sample.font.replace(/"/g, "&quot;")};`
        + `font-size:${sample.px}px;line-height:1.9;color:${fg};background:${bg};`
        + `padding:12px;${flow}">${sample.text}</div>`;
    await page.setContent(html);
    await page.waitForTimeout(150);
    const el = page.locator("#t");
    const file = resolve(outDir, `corpus_${sample.name}.png`);
    await el.screenshot({ path: file });
    const gt = await el.evaluate((node) => node.textContent);
    const box = await el.boundingBox();
    manifest.push({ name: sample.name, file, gt, vertical: sample.vertical,
        px: sample.px, width: Math.round(box.width), height: Math.round(box.height) });
    console.log(`${sample.name}: ${Math.round(box.width)}x${Math.round(box.height)} ${gt.length} chars`);
}
await browser.close();
await writeFile(resolve(outDir, "corpus.json"), JSON.stringify(manifest, null, 1));
console.log("corpus done: " + outDir);
