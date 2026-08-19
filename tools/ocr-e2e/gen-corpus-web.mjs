// Web媒体コーパス生成（一般公開時に実際に読まれる文書の再現）。
//
// 既存コーパス（corpus.json / corpus-mincho.json / corpus-page.json）は
// **青空文庫の文学作品・縦書き明朝**にほぼ偏っている。一方この拡張の主用途は
// 「画面に映っているものを読み上げる」であり、実際に選ばれるのは
//   ・横書きゴシックの記事本文（游ゴシック / メイリオ / ＭＳ Ｐゴシック / BIZ UD）
//   ・カタカナと半角英数字・URL・記号が混ざる技術文書
//   ・箇条書き、表、見出しと本文のサイズ混在
//   ・12px前後のUI文字、灰色の低コントラスト文字
//   ・ダークモード
// といった条件で、これらは一度も測っていなかった（2026-08-18時点）。
// 文学作品で改善した変更がこれらを壊していないかを測るためのコーパス。
//
// 使い方:
//   OCR_CHROMIUM="C:\Program Files\Google\Chrome\Application\chrome.exe" node gen-corpus-web.mjs [出力先]
//   → work/corpus_web_*.png + work/corpus-web.json + work/corpus-web-fontcheck.json
//
// GT は「実際に描画した文字列」（DOMのtextContent）。CER比較では空白を除去するため、
// 箇条書きや表のセル区切りが空白か改行かは結果に影響しない。
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

// ---- 本文（すべて自作の文章。著作物を含めない） ----
// 種類ごとに「その媒体でしか出ない字種の組み合わせ」を入れてある。
const BODIES = {
    // 一般的なニュース記事本文。漢字かな中心・句読点あり・漢数字と算用数字の混在。
    news: {
        kind: "para",
        text: "市は十八日、来年度の当初予算案を発表した。一般会計の総額は千二百四十億円で、"
            + "三年連続で過去最大となった。子育て支援の拡充に加え、老朽化した橋や上下水道の"
            + "更新費用が全体を押し上げている。財源の不足分は基金の取り崩しで補う方針で、"
            + "市長は「必要な投資は先送りしない」と述べた。"
    },
    // 技術文書。カタカナ語・半角英数字・URL・全角括弧・記号が混ざる。
    tech: {
        kind: "para",
        text: "インストールが終わったら、ブラウザを再起動してください。ツールバーのアイコンを"
            + "右クリックし、「オプション」を開きます。エンジンのURLは既定で "
            + "http://127.0.0.1:50021 です。接続できないときは、ファイアウォールの設定と"
            + "ポート番号（50021）を確認してください。CPU使用率が高い場合は、"
            + "同時実行数を2以下に下げると安定します。"
    },
    // 箇条書き（中黒・番号付き）。行頭記号と改行が読み上げへ混ざらないかを見る。
    list: {
        kind: "list",
        heading: "更新内容",
        bullets: [
            "読み上げ速度を0.5倍から2.0倍まで調整できるようにしました",
            "選択範囲が空のときに警告を出すようにしました",
            "画面が暗い配色のときに文字を取り違える不具合を修正しました"
        ],
        steps: ["設定画面を開く", "話者を選ぶ", "保存ボタンを押す"]
    },
    // 表組み。行方向に読むか列方向に読むかで結果が大きく変わる条件。
    table: {
        kind: "table",
        heading: "料金表",
        rows: [
            ["プラン", "月額", "文字数の上限"],
            ["無料", "0円", "5,000"],
            ["標準", "480円", "50,000"],
            ["上位", "1,280円", "上限なし"]
        ]
    },
    // アプリのUI。短い語が空白で区切られ、ショートカット表記の半角英字が混ざる。
    ui: {
        kind: "ui",
        menus: ["ファイル", "編集", "表示", "履歴", "ブックマーク", "ツール", "ヘルプ"],
        items: [
            ["新しいタブ", "Ctrl+T"],
            ["新しいウィンドウ", "Ctrl+N"],
            ["ページを保存", "Ctrl+S"],
            ["設定", ""]
        ],
        buttons: ["キャンセル", "OK"]
    },
    // 数値・単位・日時が密な文。桁区切り・小数点・パーセント・時刻・波ダッシュ。
    price: {
        kind: "para",
        text: "本日の気温は最高28.5度、最低19.2度、降水確率は30％です。"
            + "商品Aは1,280円（税込）で、通常価格から15％引きとなります。"
            + "受付は9:00〜17:30、休憩は12:00から1時間です。"
            + "在庫は残り3点、発送は8月20日ごろを予定しています。"
    },
    // 見出しと本文でフォントサイズが違う版面。行の高さがそろわない条件。
    heading: {
        kind: "heading",
        h1: "拡張機能の使い方",
        h2: "エンジンを起動する",
        body: "先にVOICEVOXを起動しておきます。起動していないと、読み上げの開始時に"
            + "接続できませんという警告が出ます。起動後にもう一度お試しください。",
        h2b: "読み上げる範囲を選ぶ",
        bodyb: "本文をドラッグして選択し、右クリックのメニューから読み上げを選びます。"
            + "選択せずに実行した場合は、表示中のページ全体が対象になります。"
    },
    // 日本語と英単語の混在。半角英字の連なりが日本語の中に割り込む。
    mixed: {
        kind: "para",
        text: "Google Chrome の Manifest V3 では background page が Service Worker に"
            + "置き換わりました。chrome.runtime.onMessage で受け取った内容を "
            + "offscreen document へ転送し、そこで Web Audio API を使って再生します。"
            + "詳細は developer.chrome.com のドキュメントを参照してください。"
    }
};

const FONTS = {
    yugo: { css: '"游ゴシック","Yu Gothic","Yu Gothic UI",sans-serif', label: "游ゴシック" },
    // 「メイリオ」は実測でブラウザ既定のサンセリフと画素まで一致し区別できないため、
    // 書体名を指定せず**既定のサンセリフ**として測る（実利用で最も多い条件そのもの）。
    defsans: { css: "sans-serif", label: "既定のサンセリフ" },
    mspgo: { css: '"ＭＳ Ｐゴシック","MS PGothic",sans-serif', label: "ＭＳ Ｐゴシック" },
    bizgo: { css: '"BIZ UDPGothic","BIZ UDゴシック",sans-serif', label: "BIZ UDPゴシック" },
    notosans: { css: '"Noto Sans JP",sans-serif', label: "Noto Sans JP" }
};

// フォント解決の実測用の対照（gen-corpus-mincho.mjs と同じ考え方）。
// document.fonts.check は存在しない名前でも true を返すため使わない。
const CONTROLS = {
    default_standard: '"__NoSuchFontFamily__ZZZ__"',
    serif: "serif",
    sans: "sans-serif"
};

// 24枚。字種（news/tech/list/table/ui/price/heading/mixed）×書体×文字寸×表示倍率×配色。
const SAMPLES = [
    // --- 記事本文：書体と寸法の振り分け ---
    { body: "news", font: "yugo", px: 16, dsf: 1 },
    { body: "news", font: "defsans", px: 14, dsf: 1 },
    { body: "news", font: "yugo", px: 16, dsf: 1.5 },
    { body: "news", font: "mspgo", px: 15, dsf: 1 },
    { body: "news", font: "notosans", px: 16, dsf: 1.25 },
    { body: "news", font: "yugo", px: 16, dsf: 1, dark: true },
    // 灰色文字（#767676 on #ffffff）。Webでごく普通に使われる低コントラスト。
    { body: "news", font: "yugo", px: 14, dsf: 1, fg: "#767676" },
    // 横幅の狭い1段組（スマートフォン相当）。1行が短く折り返しが多い。
    { body: "news", font: "yugo", px: 16, dsf: 1, cols: 18 },
    // --- 技術文書（URL・半角英数字・記号） ---
    { body: "tech", font: "yugo", px: 16, dsf: 1 },
    { body: "tech", font: "defsans", px: 15, dsf: 1.25 },
    { body: "tech", font: "bizgo", px: 16, dsf: 1 },
    { body: "tech", font: "yugo", px: 20, dsf: 1 },
    // --- 箇条書き ---
    { body: "list", font: "yugo", px: 15, dsf: 1 },
    { body: "list", font: "defsans", px: 16, dsf: 1.5 },
    // --- 表組み ---
    { body: "table", font: "yugo", px: 15, dsf: 1 },
    { body: "table", font: "defsans", px: 14, dsf: 1.25 },
    // --- UI（12px前後の小さい文字） ---
    { body: "ui", font: "yugo", px: 12, dsf: 1 },
    { body: "ui", font: "defsans", px: 12, dsf: 1.5 },
    // --- 数値・単位が密な文 ---
    { body: "price", font: "yugo", px: 16, dsf: 1 },
    { body: "price", font: "mspgo", px: 14, dsf: 1 },
    // --- 見出しと本文のサイズ混在 ---
    { body: "heading", font: "yugo", px: 16, dsf: 1 },
    { body: "heading", font: "defsans", px: 16, dsf: 1.25 },
    // --- 日英混在 ---
    { body: "mixed", font: "yugo", px: 16, dsf: 1 },
    { body: "mixed", font: "notosans", px: 16, dsf: 1.25 }
];

function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 本文ブロックのHTML。GTは描画後に textContent で取るのでここでは組み立てない。
function bodyHtml(body, px) {
    if (body.kind === "para") {
        return `<p style="margin:0">${esc(body.text)}</p>`;
    }
    if (body.kind === "list") {
        const bullets = body.bullets
            .map((b) => `<li style="margin:0 0 .3em 0">${esc(b)}</li>`).join("");
        const steps = body.steps
            .map((b) => `<li style="margin:0 0 .3em 0">${esc(b)}</li>`).join("");
        return `<p style="margin:0 0 .4em 0;font-weight:700">${esc(body.heading)}</p>`
            + `<ul style="margin:0 0 .6em 0;padding-left:1.3em">${bullets}</ul>`
            + `<ol style="margin:0;padding-left:1.6em">${steps}</ol>`;
    }
    if (body.kind === "table") {
        const rows = body.rows.map((cells, i) => "<tr>" + cells
            .map((c) => `<${i === 0 ? "th" : "td"} style="border:1px solid #999;`
                + `padding:.25em .7em;text-align:left;font-weight:${i === 0 ? 700 : 400}">`
                + `${esc(c)}</${i === 0 ? "th" : "td"}>`).join("") + "</tr>").join("");
        return `<p style="margin:0 0 .4em 0;font-weight:700">${esc(body.heading)}</p>`
            + `<table style="border-collapse:collapse">${rows}</table>`;
    }
    if (body.kind === "ui") {
        const menus = body.menus
            .map((m) => `<span style="margin-right:1.2em">${esc(m)}</span>`).join("");
        const items = body.items.map(([label, key]) =>
            `<div style="display:flex;justify-content:space-between;`
            + `padding:.25em .6em;min-width:${px * 16}px">`
            + `<span>${esc(label)}</span><span>${esc(key)}</span></div>`).join("");
        const buttons = body.buttons.map((b) =>
            `<span style="border:1px solid #888;border-radius:3px;`
            + `padding:.2em .9em;margin-right:.6em">${esc(b)}</span>`).join("");
        return `<div style="border-bottom:1px solid #ccc;padding-bottom:.3em">${menus}</div>`
            + `<div style="margin:.5em 0">${items}</div>`
            + `<div style="margin-top:.5em">${buttons}</div>`;
    }
    if (body.kind === "heading") {
        return `<h1 style="margin:0 0 .4em 0;font-size:${Math.round(px * 1.6)}px">`
            + `${esc(body.h1)}</h1>`
            + `<h2 style="margin:0 0 .3em 0;font-size:${Math.round(px * 1.2)}px">`
            + `${esc(body.h2)}</h2>`
            + `<p style="margin:0 0 .8em 0">${esc(body.body)}</p>`
            + `<h2 style="margin:0 0 .3em 0;font-size:${Math.round(px * 1.2)}px">`
            + `${esc(body.h2b)}</h2>`
            + `<p style="margin:0">${esc(body.bodyb)}</p>`;
    }
    throw new Error(`unknown body kind: ${body.kind}`);
}

function buildHtml({ fontCss, px, dark, fg, cols, inner }) {
    const color = fg || (dark ? "#e6e6e6" : "#1a1a1a");
    const bg = dark ? "#1b1b1f" : "#ffffff";
    const width = Math.round(px * (cols || 34));
    return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${bg};">`
        + `<div id="t" style="font-family:${fontCss.replace(/"/g, "&quot;")};`
        + `font-size:${px}px;line-height:1.75;color:${color};background:${bg};`
        + `padding:14px;width:${width}px;height:max-content;">${inner}</div>`;
}

const browser = await chromium.launch({ executablePath });

// ---- 1) フォント解決の実測 ----
const probePage = await browser.newPage({
    deviceScaleFactor: 1, viewport: { width: 1200, height: 800 } });
async function probeHash(fontCss) {
    await probePage.setContent(buildHtml({ fontCss, px: 24, dark: false,
        inner: "<p style=\"margin:0\">市は十八日、来年度の当初予算案を発表した。</p>" }));
    await probePage.waitForTimeout(60);
    const el = probePage.locator("#t");
    const png = await el.screenshot();
    return createHash("sha1").update(png).digest("hex").slice(0, 16);
}
const controlHashes = {};
for (const [id, css] of Object.entries(CONTROLS)) controlHashes[id] = await probeHash(css);
console.log("controls:", JSON.stringify(controlHashes));

const fontCheck = {};
for (const [id, font] of Object.entries(FONTS)) {
    const hash = await probeHash(font.css);
    const alias = Object.entries(controlHashes).filter(([, h]) => h === hash).map(([k]) => k);
    // 既定のサンセリフは定義上 default_standard と一致するので除外判定から外す。
    const resolved = id === "defsans" || !alias.includes("default_standard");
    fontCheck[id] = { label: font.label, css: font.css, hash, aliasOf: alias, resolved };
    console.log(`${id.padEnd(9)} ${font.label.padEnd(14)} hash=${hash} `
        + `alias=[${alias.join(",")}] resolved=${resolved}`);
}
await probePage.close();
const dropped = Object.entries(fontCheck).filter(([, v]) => !v.resolved).map(([k]) => k);
if (dropped.length) console.log(`!! 未解決フォントを除外: ${dropped.join(", ")}`);

// ---- 2) サンプル生成 ----
const pages = new Map();
async function pageFor(dsf) {
    if (!pages.has(dsf)) {
        pages.set(dsf, await browser.newPage({
            deviceScaleFactor: dsf, viewport: { width: 1600, height: 1400 } }));
    }
    return pages.get(dsf);
}

const manifest = [];
for (const sample of SAMPLES) {
    if (dropped.includes(sample.font)) continue;
    const font = FONTS[sample.font];
    const name = [sample.body, sample.font, sample.px,
        `dsf${String(sample.dsf).replace(".", "")}`,
        sample.dark ? "dark" : null, sample.fg ? "gray" : null,
        sample.cols ? "narrow" : null].filter((p) => p !== null).join("_");
    const page = await pageFor(sample.dsf);
    await page.setContent(buildHtml({
        fontCss: font.css, px: sample.px, dark: !!sample.dark, fg: sample.fg,
        cols: sample.cols, inner: bodyHtml(BODIES[sample.body], sample.px) }));
    await page.waitForTimeout(150);
    const el = page.locator("#t");
    const file = resolve(outDir, `corpus_web_${name}.png`);
    await el.screenshot({ path: file });
    // 表・箇条書き・UIは要素の間に区切りが無いと語が続いてしまうので、
    // ブロック境界に空白を入れた文字列をGTにする（CER比較では空白は除去される）。
    // 箇条書きのマーカー（• や 1.）はCSSが描く擬似要素で textContent に入らないが、
    // **画面には見えているのでOCRは読む**。GTへ入れないと正しい認識が「余剰」と数えられる。
    const gt = await el.evaluate((node) => {
        const parts = [];
        const walk = (el) => {
            for (const child of el.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    if (child.textContent.trim()) parts.push(child.textContent.trim());
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.tagName === "LI") {
                        const type = getComputedStyle(child).listStyleType;
                        if (type === "decimal") {
                            const index = [...child.parentNode.children].indexOf(child) + 1;
                            parts.push(`${index}.`);
                        } else if (type !== "none") {
                            parts.push("•");
                        }
                    }
                    walk(child);
                }
            }
        };
        walk(node);
        return parts.join(" ");
    });
    const box = await el.boundingBox();
    manifest.push({
        name, file, gt, body: sample.body, kind: BODIES[sample.body].kind,
        font: sample.font, fontLabel: font.label, fontCss: font.css,
        fontResolved: fontCheck[sample.font].resolved,
        px: sample.px, dsf: sample.dsf, dark: !!sample.dark,
        lowContrast: !!sample.fg, narrow: !!sample.cols, vertical: false,
        devicePx: Math.round(sample.px * sample.dsf),
        width: Math.round(box.width * sample.dsf),
        height: Math.round(box.height * sample.dsf)
    });
    console.log(`${name}: ${Math.round(box.width * sample.dsf)}x`
        + `${Math.round(box.height * sample.dsf)} ${gt.length}文字`);
}
for (const page of pages.values()) await page.close();
await browser.close();

await writeFile(resolve(outDir, "corpus-web.json"), JSON.stringify(manifest, null, 1));
await writeFile(resolve(outDir, "corpus-web-fontcheck.json"),
    JSON.stringify({ controls: controlHashes, fonts: fontCheck }, null, 1));
console.log(`corpus-web done: ${manifest.length} samples -> ${outDir}`);
