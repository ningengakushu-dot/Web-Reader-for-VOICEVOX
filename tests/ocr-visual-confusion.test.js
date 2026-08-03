const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-refine.js'), 'utf8')
    + '\n;globalThis.ocrTestApi = {'
    + 'setOcrDictionaries, correctOcrVisualConfusionsByDictionary, buildTextFromBlocks};';
const context = vm.createContext({ console, Map, Set, Uint8Array, RegExp });
vm.runInContext(source, context);
const api = context.ocrTestApi;

function blocksFor(text) {
    const word = {
        text,
        symbols: [...text].map((char) => ({ text: char, confidence: 99 }))
    };
    return [{ paragraphs: [{ lines: [{ words: [word] }] }] }];
}

{
    api.setOcrDictionaries(new Set(['自己', '主張']));
    const blocks = blocksFor('自巳主張');
    assert.equal(api.correctOcrVisualConfusionsByDictionary(blocks), 1);
    assert.equal(api.buildTextFromBlocks(blocks), '自己主張');
}

{
    api.setOcrDictionaries(new Set(['巳年']));
    const blocks = blocksFor('巳年');
    assert.equal(api.correctOcrVisualConfusionsByDictionary(blocks), 0,
        '辞書にある正しい語は保護する');
    assert.equal(api.buildTextFromBlocks(blocks), '巳年');
}

{
    api.setOcrDictionaries(new Set(['自己', '自已']));
    const blocks = blocksFor('自巳');
    assert.equal(api.correctOcrVisualConfusionsByDictionary(blocks), 0,
        '候補が複数あるときは推測で置換しない');
    assert.equal(api.buildTextFromBlocks(blocks), '自巳');
}

{
    api.setOcrDictionaries(new Set(['自己', '主張']));
    const blocks = blocksFor('自巴主張');
    assert.equal(api.correctOcrVisualConfusionsByDictionary(blocks), 0,
        '字形混同リスト外の文字は個別語に合わせて置換しない');
    assert.equal(api.buildTextFromBlocks(blocks), '自巴主張');
}

console.log('OCR visual-confusion correction: PASSED');
