const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-refine.js'), 'utf8')
    + '\n;globalThis.ocrTestApi = {fuseOcrSymbols, protectOcrSymbolsFromWholeSwap, buildTextFromBlocks};';
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
    const base = blocksFor('自巳主張', [98, 91, 99, 99]);
    const targetVariants = [
        blocksFor('自己主張', [98, 98, 99, 99]),
        blocksFor('自巳主張', [98, 90, 99, 99])
    ];
    const cachedVariants = [
        blocksFor('自己主張', [98, 98, 99, 99]),
        blocksFor('自己主張', [98, 97, 99, 99])
    ];
    assert.equal(api.fuseOcrSymbols(base, [...targetVariants, ...cachedVariants], {
        kanji: false,
        unanimousVariantCount: targetVariants.length,
        consensusClasses: ['kanji'],
        consensusIncludesBase: true
    }), 1);
    assert.equal(api.buildTextFromBlocks(base), '自己主張',
        '候補不足時は認識済み画像と元寸を一度に融合し、追加OCRなしで多数一致を成立させる');
}

{
    const base = blocksFor('自巳主張', [98, 91, 99, 99]);
    const cachedOnly = [
        blocksFor('自己主張', [98, 98, 99, 99]),
        blocksFor('自己主張', [98, 97, 99, 99])
    ];
    assert.equal(api.fuseOcrSymbols(base, cachedOnly, {
        kanji: false,
        unanimousVariantCount: 0,
        consensusClasses: ['kanji'],
        consensusIncludesBase: true
    }), 1, '新規倍率0件でも元寸・2倍・二値化の3画像で判定する');
    assert.equal(api.buildTextFromBlocks(base), '自己主張');
}

{
    const base = blocksFor('なだちかな', [98, 98, 91, 98, 98]);
    const targets = [
        blocksFor('なだらかな', [98, 98, 99, 98, 98]),
        blocksFor('なだらかな', [98, 98, 99, 98, 98])
    ];
    const supplemental = blocksFor('なだちかな', [98, 98, 99, 98, 98]);
    assert.equal(api.fuseOcrSymbols(base, [...targets, supplemental], {
        kanji: false,
        unanimousVariantCount: targets.length,
        consensusClasses: ['kanji'],
        consensusIncludesBase: true
    }), 1, '補充票が新規倍率2件の全会一致を妨げない');
    assert.equal(api.buildTextFromBlocks(base), 'なだらかな');
}

{
    const base = blocksFor('ハバ', [98, 94]);
    const emptyTarget = [];
    const target = blocksFor('ハパ');
    const supplemental = blocksFor('ハパ');
    assert.equal(api.fuseOcrSymbols(base, [emptyTarget, target, supplemental], {
        kanji: false,
        unanimousVariantCount: 2,
        consensusClasses: ['kanji'],
        consensusIncludesBase: true
    }), 0, '空の新規候補があっても補充候補を全会一致へ繰り上げない');
    assert.equal(api.buildTextFromBlocks(base), 'ハバ');
}

{
    const base = blocksFor('甲乙', [91, 91]);
    const variants = [
        blocksFor('丙丁', [99, 99]),
        blocksFor('丙戊', [99, 90]),
        blocksFor('丙丁', [99, 99])
    ];
    assert.equal(api.fuseOcrSymbols(base, variants, {
        kanji: false,
        unanimousVariantCount: 2,
        consensusClasses: ['kanji'],
        consensusIncludesBase: true
    }), 1, '先に全会一致で変えた文字を隣接文字の新しいアンカーにしない');
    assert.equal(api.buildTextFromBlocks(base), '丙乙');
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
    const base = blocksFor('自巳主張', [99, 98, 99, 99]);
    const reference = blocksFor('自己主張', [98, 98, 97, 98]);
    const corroborating = blocksFor('自己主張', [98, 99, 98, 99]);
    assert.equal(api.protectOcrSymbolsFromWholeSwap(base, reference, corroborating), 1,
        '元寸と2倍grayが二値化版以上のconfidenceで一致する漢字を復元する');
    assert.equal(api.buildTextFromBlocks(base), '自己主張');
}

{
    const base = blocksFor('自巳主張', [98, 94, 97, 98]);
    const reference = blocksFor('自己主張', [98, 98, 97, 98]);
    const corroborating = blocksFor('自巳主張', [98, 92, 99, 99]);
    assert.equal(api.protectOcrSymbolsFromWholeSwap(base, reference, corroborating), 1,
        '二つの加工結果より元寸の局所confidenceが明確に高ければ元寸文字を復元する');
    assert.equal(api.buildTextFromBlocks(base), '自己主張');
}

{
    const base = blocksFor('自己主張', [99, 98, 99, 99]);
    const reference = blocksFor('自巳主張', [98, 91, 97, 98]);
    const corroborating = blocksFor('自己主張', [98, 98, 98, 99]);
    assert.equal(api.protectOcrSymbolsFromWholeSwap(base, reference, corroborating), 0,
        '二値化と2倍grayの局所confidenceが高い改善を元寸へ戻さない');
    assert.equal(api.buildTextFromBlocks(base), '自己主張');
}

{
    const base = blocksFor('自己主張', [99, 99, 99, 99]);
    const reference = blocksFor('自巳主張', [98, 98, 97, 98]);
    const corroborating = blocksFor('自巳主張', [98, 98, 98, 99]);
    assert.equal(api.protectOcrSymbolsFromWholeSwap(base, reference, corroborating), 0,
        '二値化だけがgray2画像より高confidenceで正読した場合は二値化の改善を維持する');
    assert.equal(api.buildTextFromBlocks(base), '自己主張');
}

{
    const base = blocksFor('自己主張', [99, 98, 99, 99]);
    const reference = blocksFor('自巳主張', [98, 91, 97, 98]);
    assert.equal(api.protectOcrSymbolsFromWholeSwap(base, reference, []), 0,
        '2倍grayが空認識なら二値化版を変更しない');
    assert.equal(api.buildTextFromBlocks(base), '自己主張');
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
