const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-refine.js'), 'utf8')
    + '\n;globalThis.ocrTestApi = {fuseOcrSymbols, buildTextFromBlocks};';
const context = vm.createContext({ console, Map, Set, Uint8Array, Int32Array, RegExp });
vm.runInContext(source, context);
const api = context.ocrTestApi;

function blocksFor(text, confidences = []) {
    const word = {
        text,
        symbols: [...text].map((char, index) => ({
            text: char,
            confidence: confidences[index] ?? 98
        }))
    };
    return [{ paragraphs: [{ lines: [{ words: [word] }] }] }];
}

{
    const base = blocksFor('自巳主張', [98, 91, 99, 99]);
    const variants = [
        blocksFor('自巳主張', [98, 90, 99, 99]),
        blocksFor('自己主張', [98, 98, 99, 99]),
        blocksFor('自己主張', [98, 98, 99, 99])
    ];
    assert.equal(api.fuseOcrSymbols(base, variants, { kanji: false }), 1);
    assert.equal(api.buildTextFromBlocks(base), '自己主張',
        '語彙を参照せず、位置が安定した2対1の強い画像証拠で補正する');
}

{
    const base = blocksFor('巳年生', [98, 98, 98]);
    const variants = [
        blocksFor('己年生', [91, 98, 98]),
        blocksFor('己年生', [91, 98, 98]),
        blocksFor('巳年生', [98, 98, 98])
    ];
    assert.equal(api.fuseOcrSymbols(base, variants, { kanji: false }), 0,
        '多数候補の文字信頼度が元文字を上回らないときは正しい珍しい表記を維持する');
    assert.equal(api.buildTextFromBlocks(base), '巳年生');
}

{
    const base = blocksFor('甲巳乙', [98, 90, 98]);
    const variants = [
        blocksFor('丙己丁', [98, 99, 98]),
        blocksFor('丙己丁', [98, 99, 98]),
        blocksFor('甲巳乙', [98, 90, 98])
    ];
    assert.equal(api.fuseOcrSymbols(base, variants, { kanji: false }), 0,
        '前後文字が一致せず整列位置を裏付けられない候補は投票に数えない');
    assert.equal(api.buildTextFromBlocks(base), '甲巳乙');
}

{
    const base = blocksFor('ハバ', [98, 94]);
    const variants = [blocksFor('ハパ'), blocksFor('ハパ'), blocksFor('ハパ')];
    assert.equal(api.fuseOcrSymbols(base, variants, { kanji: false }), 1,
        '既存の全会一致補正を維持する');
    assert.equal(api.buildTextFromBlocks(base), 'ハパ');
}

console.log('OCR image-evidence consensus fusion: PASSED');
