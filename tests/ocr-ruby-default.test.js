const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(root, 'ocr-refine.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'ocr-ruby.js'), 'utf8'), context);

function line(text, bbox) {
    return { words: [{ text, bbox }], bbox };
}

function blocksOf(lines) {
    return [{ paragraphs: [{ lines }] }];
}

context.fixture = blocksOf([
    // Tesseract の縦書き出力では右側のルビ列が本文より先に並ぶことがある。
    line('りょうせん', { x0: 52, y0: 20, x1: 60, y1: 80 }),
    line('稜線の陰', { x0: 30, y0: 0, x1: 50, y1: 100 }),
    line('夕刻を過ぎ', { x0: 5, y0: 0, x1: 25, y1: 100 })
]);

const filtered = vm.runInContext("removeOcrRubyLines(fixture, 'vertical')", context);
assert.equal(filtered, '稜線の陰\n夕刻を過ぎ',
    '既定動作はルビ行を除外し、親の漢字と本文順を保つ');

context.noRubyFixture = blocksOf([
    line('稜線の陰', { x0: 30, y0: 0, x1: 50, y1: 100 }),
    line('夕刻を過ぎ', { x0: 5, y0: 0, x1: 25, y1: 100 })
]);
assert.equal(vm.runInContext("removeOcrRubyLines(noRubyFixture, 'vertical')", context), null,
    'ルビのない認識結果は書き換えない');

context.unsafeLines = [
    { text: 'あいうえおかきくけこ', chars: Array.from('あいうえおかきくけこ'),
        bbox: { x0: 30, y0: 0, x1: 38, y1: 100 }, size: 8, hasKanji: false, subs: [] },
    { text: '本文', chars: Array.from('本文'),
        bbox: { x0: 5, y0: 0, x1: 25, y1: 100 }, size: 20, hasKanji: true, subs: [] }
];
assert.equal(vm.runInContext("buildOcrTextWithoutRubyLines(unsafeLines, 'vertical', 20)", context), null,
    '除去文字が多すぎる場合は本文欠落を避けて生テキストへ戻す');

const commonSource = fs.readFileSync(path.join(root, 'ocr-common.js'), 'utf8');
assert.match(commonSource, /filtered = removeOcrRubyLines\(best\.blocks, rubyOrientation\)/,
    'ルビ優先がOFFでもルビ行を除外する');
assert.match(commonSource, /if \(preferRubyReadings\)[\s\S]*applyRubyReadings/,
    'ルビ優先がONの場合だけルビを再認識する');

const optionsHtml = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
assert.match(optionsHtml, /OFF（推奨）ではルビを読み上げず、本文の漢字を読みます/,
    '設定画面で既定動作を説明する');

console.log('default OCR ruby removal: PASSED');
