// ocr-common.js normalizeOcrText / cleanForSpeech の検査。
// 入力は Chrome で描画した Web レイアウトを出荷コードで実際に OCR した生テキスト
// （tools/reading-corpus-ocr.json）の抜粋と、小説コーパスで起きる折り返しの型。
// 期待値は 2026-08-16 の実測（tools/ocr-e2e の小説・kakushin・MS の出力が変更前後で
// 完全一致することを確認済み）に基づく。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.join(__dirname, '..');
const source = ['constants.js', 'ocr-image.js', 'ocr-refine.js', 'ocr-common.js']
    .map((f) => fs.readFileSync(path.join(repo, f), 'utf8')).join('\n;\n')
    + '\n;globalThis.__api = { normalizeOcrText, cleanForSpeech };';
const context = vm.createContext({
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Map, Set, RegExp, Number, Array, Object, String,
    Uint8Array, Uint8ClampedArray, Int32Array, Infinity, NaN, isFinite,
    document: { createElement: () => ({ getContext: () => null }) },
    chrome: { runtime: { getURL: (p) => p } },
    Tesseract: { PSM: {}, createWorker: async () => ({}) }
});
vm.runInContext(source, context, { filename: 'ocr-common.js' });
const { normalizeOcrText, cleanForSpeech } = context.__api;
const spoken = (raw) => cleanForSpeech(normalizeOcrText(raw));

// --- 小説の折り返し（変更前後で同じでなければならない基本形） ---
{
    // 文字間スペースを除き、同じ段落内の折り返しは間を入れずにつなぐ
    assert.equal(spoken('ある 日 の 暮 方 の 事 で ある 。 一 人 の 下 人 が 、 羅 生 門 の 下 で 雨 や み\nを 待 っ て いた 。'),
        'ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。');
    // 空行は段落境界（読点相当の間）
    assert.equal(spoken('吾輩は猫である。名前はまだ無い\n\nどこで生れたか'), '吾輩は猫である。名前はまだ無い、どこで生れたか');
    // 見出しらしい短い行の後は間を入れる
    assert.equal(spoken('第一章\n吾輩は猫である。'), '第一章、吾輩は猫である。');
    // 縦棒混じりのダッシュ崩れは長音1つに
    assert.equal(spoken('うわー|ー|1||っ'), 'うわーっ');
    // URL は読まない
    assert.equal(spoken('詳細は https://example.com/a?b=1 を参照'), '詳細はURL省略を参照');
}

// --- ダッシュ崩れの畳み込みが、隣接する本文を巻き込まないこと ---
// 従来は l・I・1・スラッシュを連続の一部として無条件に飲み込んでいたため、ダッシュの
// 隣にあるだけの数字・英字・記号が読み上げから黙って消えていた（読み飛ばしの一因）。
{
    // ダッシュ1つ＋数字: 何も畳み込まない
    assert.equal(cleanForSpeech('―1972年'), '―1972年');
    assert.equal(cleanForSpeech('1―2の関係'), '1―2の関係');
    assert.equal(cleanForSpeech('第―1章'), '第―1章');
    assert.equal(cleanForSpeech('A―1型'), 'A―1型');
    assert.equal(cleanForSpeech('範囲は1―10です'), '範囲は1―10です');
    assert.equal(cleanForSpeech('電話03―1234―5678'), '電話03―1234―5678');
    // 長音＋スラッシュ: スラッシュの後ろの語を消さない
    assert.equal(cleanForSpeech('サーバー/クライアント'), 'サーバー/クライアント');
    assert.equal(cleanForSpeech('コーヒー/紅茶'), 'コーヒー/紅茶');
    // ダッシュの連続そのものは従来どおり長音1つへ。直後の数字は残す
    assert.equal(cleanForSpeech('――推理小説'), 'ー推理小説');
    assert.equal(cleanForSpeech('「――12年前のことだ」'), '「ー12年前のことだ」');
    // 縦棒だけの並び・長音だけの並びは従来どおり触らない
    assert.equal(cleanForSpeech('||'), '||');
    assert.equal(cleanForSpeech('あーー'), 'あーー');
    assert.equal(cleanForSpeech('サーバー1台'), 'サーバー1台');
}

// --- 実 OCR で見つかった Web レイアウトの型 ---
{
    // 英文の折り返し: Tesseract が行間に空行を出しても、小文字で終わり小文字で始まる行は同じ文
    assert.equal(spoken('The quarterly report shows a steady increase in customer engagement across all\n\nmajor regions this year. Our support team responded to more than three thousand\n\ntickets within the first week alone.\n\n来 月 に は 共有 する 予定 で す 。'),
        'The quarterly report shows a steady increase in customer engagement across all major regions this year. Our support team responded to more than three thousand tickets within the first week alone.、来月には共有する予定です。');
    // 項目名＋値の行（スペック表）は行ごとに間を入れる
    assert.equal(spoken('価格 : \\12,800 (税込 )\n重量 : 1.2kg\n\nサイ ズ : 150x75x8 mm\n発売 日 : 2026 年 9 月 1 日'),
        '価格: \\12,800 (税込)、重量: 1.2kg、サイズ: 150x75x8 mm、発売日: 2026年9月1日');
    // 目次（第N章）は行ごとに間を入れる
    assert.equal(spoken('第 1 章 は じ め に ・・・・・・・・・・3\n第 2 章 導入 ・・・・・・・・・・・・12\n第 3 章 基本 操作 ・・・・・・・・・・27'),
        '第1章はじめに・・・・・・・・・・3、第2章導入・・・・・・・・・・・・12、第3章基本操作・・・・・・・・・・27');
    // 条文（第N条）も同様
    assert.equal(spoken('第 3 条 （ 利用 登録 ）\n利用 者 は 登録 を 行う 。'), '第3条（利用登録）、利用者は登録を行う。');
    // 箇条書き（マーカー行）は行ごとに間を入れる
    assert.equal(spoken('・ 作業 開始 前 に 書 き 出す\n\n・ 25 分 作業 し た ら 5 分 休 む'), '・作業開始前に書き出す、・25分作業したら5分休む');
    // ラベル行の判定は短い項目名に限る（本文中の「注：」のような長い行は折り返し扱いのまま）
    assert.equal(spoken('これは本文の途中で改行された文で、次の行に\n続きます。'), 'これは本文の途中で改行された文で、次の行に続きます。');
}

console.log('OCR text normalization: PASSED');
