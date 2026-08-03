const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const runtimeFiles = [
    'capture.js', 'constants.js', 'content.js', 'dom-text.js',
    'ocr-common.js', 'offscreen-security.js', 'offscreen.js', 'options.js',
    'capture.html', 'offscreen.html', 'options.html'
];
const runtimeSource = runtimeFiles.map(read).join('\n');

assert.doesNotMatch(runtimeSource, /ocrRemoveRuby|removeRuby|ocr-ruby\.js|applyRubyReadings|removeOcrRubyLines/,
    '廃止したルビOCR機能・設定を実行コードとUIに残さない');
const background = read('background.js');
assert.match(background, /storage\.local\.remove\("ocrRemoveRuby"/,
    '更新時に廃止済み設定をストレージから削除する');
assert.equal((background.match(/ocrRemoveRuby/g) || []).length, 1,
    'backgroundには廃止済み設定の削除処理だけを残す');
assert.equal(fs.existsSync(path.join(root, 'ocr-ruby.js')), false,
    'ルビ再認識モジュールを配布対象から削除する');

const common = read('ocr-common.js');
assert.match(common, /async function recognizeWithOrientation\(sourceCanvas, workerProvider\)/,
    'OCRは精度基準となる通常経路だけを公開する');
assert.match(common, /best\.confidence < OCR_UPSCALE_SWAP_MAX_BASE_CONFIDENCE/,
    '通常OCRの拡大版採用条件を維持する');
assert.match(common, /for \(const data of \[upscaled2x, preprocessedData\]\)/,
    '候補不足時に認識済み2倍版と二値化版を画像証拠として再利用する');
assert.match(common, /unanimousVariantCount: others\.length/,
    '補充候補が既存の全会一致判定へ混ざらない');

const dom = read('dom-text.js');
assert.match(dom, /role === "paren" \|\| role === "reading"/,
    'DOMでは読み仮名と補助括弧だけを除外して親文字を読む');
assert.doesNotMatch(dom, /role === "base"/,
    'DOMの親文字をルビ設定で置き換えない');

console.log('standard OCR path without ruby feature: PASSED');
