// 小説1ページ（縦書き・明朝20px・ルビ2箇所・約550x800 ＝ 40万px超）を実フォントで再現する。
// 2026-08-17 のユーザー報告「横読みになって意味不明」の再現入力。方向判定の全体比較の上限が
// 40万px だったため 240px パッチで比較され、jpn 77 / jpn_vert 76 で横書きに倒れて全文が崩壊していた。
// 使い方: node gen-corpus-page.mjs  → work/corpus_page_*.png + work/corpus-page.json
import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.OCR_CHROMIUM
    || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const PARAS = [
    "「――推理小説にたとえるなら、編集者は数多くの証拠を集めてひとつの形にまとめあげる探偵。校正者はその証拠をすべて吟味して裁判に完璧を期する検察官、というところでしょうか」――と、いつぞや｜霧子《きりこ》さんは教えてくれた。彼女自身が文芸編集者で重度のミステリ好きなので、僕のふとした質問にもこんな凝った答えが返ってくるのだ。",
    "「……そのたとえからすると、作家は何なんですか」",
    "「犯人ですね」平然とした顔で霧子さんは言った。冗談か本気かよくわからなかった。",
    "「霧子さん、前に、作家と編集者はパートナーだって言ってませんでしたっけ……？」",
    "「はい。推理小説においては犯人と探偵は共同作業で物語を形作っているといえます」",
    "かろうじて、納得できなくもない。",
    "しかし、編集や校正がどういう仕事なのかを軽い気持ちで訊いただけだったので、できれば普通に答えてほしかった。",
    "「その話に従うと、僕は霧子さんに糾弾される立場ってことになっちゃいますけれど」",
    "「そうですね。作家をしめきりで追い詰めるのも編集者の仕事です」",
    "真面目ぶって言うのだから反応に困ってしまう。",
    "犯罪捜査なみに僕のことを常時真剣に考えてくれているのだ――と、最大限好意的に解釈することにした。",
    "思えば長い付き合いなのに、この｜深町《ふかまち》霧子という人物のことは未だに理解できない。"
];

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function paraHtml(text, useRuby) {
    let out = "";
    let gt = "";
    const re = /｜([^《]+)《([^》]+)》/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        out += esc(text.slice(last, m.index)); gt += text.slice(last, m.index);
        out += useRuby ? `<ruby>${esc(m[1])}<rt>${esc(m[2])}</rt></ruby>` : esc(m[1]);
        gt += m[1];
        last = m.index + m[0].length;
    }
    out += esc(text.slice(last)); gt += text.slice(last);
    // 段落頭の字下げ（「 で始まる段落は字下げなし）
    const indent = /^[「（]/.test(gt) ? "" : "　";
    return { html: `<p style="margin:0;text-indent:${indent ? "1em" : "0"}">${out}</p>`, gt: indent + gt };
}

const FONTS = {
    yumin: '"游明朝","Yu Mincho",serif',
    hiragino: '"Hiragino Mincho ProN","游明朝",serif',
    noto: '"Noto Serif JP",serif'
};
const SAMPLES = [
    { id: "yumin_20_ruby", font: "yumin", px: 20, dsf: 1, ruby: true, lh: 1.55 },
    { id: "yumin_20_plain", font: "yumin", px: 20, dsf: 1, ruby: false, lh: 1.55 },
    { id: "noto_20_ruby", font: "noto", px: 20, dsf: 1, ruby: true, lh: 1.55 },
    { id: "yumin_16_dsf125_ruby", font: "yumin", px: 16, dsf: 1.25, ruby: true, lh: 1.55 },
    // 表示倍率を上げた場合（実効30px相当）。20px は Tesseract の最適域(20-30px)の下端で、
    // 拡大すると誤りが大きく減るかを測るための対照。
    { id: "yumin_20_dsf15_ruby", font: "yumin", px: 20, dsf: 1.5, ruby: true, lh: 1.55 },
    { id: "yumin_28_ruby", font: "yumin", px: 28, dsf: 1, ruby: true, lh: 1.55 }
];

const browser = await chromium.launch({ executablePath });
const manifest = [];
for (const s of SAMPLES) {
    const page = await browser.newPage({ deviceScaleFactor: s.dsf, viewport: { width: 1600, height: 1200 } });
    const parts = PARAS.map((p) => paraHtml(p, s.ruby));
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;">`
        + `<div id="t" style="font-family:${FONTS[s.font].replace(/"/g, "&quot;")};font-size:${s.px}px;`
        + `line-height:${s.lh};color:#111;background:#fff;padding:8px 10px;writing-mode:vertical-rl;`
        + `height:${Math.round(s.px * 39)}px;width:max-content;">${parts.map((p) => p.html).join("")}</div>`;
    await page.setContent(html);
    await page.waitForTimeout(200);
    const el = page.locator("#t");
    const file = resolve(here, "work", `corpus_page_${s.id}.png`);
    await el.screenshot({ path: file });
    const box = await el.boundingBox();
    manifest.push({ name: `page_${s.id}`, file, gt: parts.map((p) => p.gt).join("\n"),
        px: s.px, dsf: s.dsf, ruby: s.ruby, width: Math.round(box.width * s.dsf), height: Math.round(box.height * s.dsf) });
    console.log(s.id, Math.round(box.width * s.dsf), "x", Math.round(box.height * s.dsf));
    await page.close();
}
await browser.close();
await writeFile(resolve(here, "work", "corpus-page.json"), JSON.stringify(manifest, null, 1));
