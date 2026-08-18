const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-refine.js'), 'utf8')
    + '\n;globalThis.ocrTestApi = {fuseOcrSymbols, protectOcrSymbolsFromWholeSwap, '
    + 'pruneOcrLineInsertions, hasLikelyOcrLineInsertions, collectVerticalGlyphRescanTargets, '
    + 'extractSingleHanEvidence, selectVerticalGlyphRescanReplacement, buildTextFromBlocks};';
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
    const stableFirst = '冷房の効いたフロア内には、黙々と異様な雰囲気をまといなが';
    const expected = 'ら机に並べられたモニターと向かい合う男たちがいる。彼らはこ';
    const stableThird = 'こ、Kソフトワークスの社員たちだ。中堅どころの企業であるか';
    const spans = [596, 618, 618];
    const makeBase = () => blocksForLines([
        stableFirst,
        expected.replace('彼らは', '彼らちは'),
        stableThird
    ], spans);
    const singleEvidenceBase = makeBase();
    assert.equal(api.pruneOcrLineInsertions(singleEvidenceBase, [
        blocksForLines([stableFirst, expected, stableThird], spans)
    ], 'vertical', 20), 0,
    '二値化1候補だけの欠落を原寸の重複とみなして実在文字を削除しない');
    const base = makeBase();
    const shiftedWithThreeInsertions = expected
        .replace('ら机', 'らち机')
        .replace('彼らは', '彼ちらは')
        .replace('はこ', 'はちこ');
    assert.equal(api.hasLikelyOcrLineInsertions(base, 'vertical', 20), true,
        '列の物理長だけで重複挿入らしい入力を検出する');
    assert.equal(api.pruneOcrLineInsertions(base, [
        blocksForLines([stableFirst, expected, stableThird], spans),
        blocksForLines([stableFirst, shiftedWithThreeInsertions, stableThird], spans)
    ], 'vertical', 20), 1,
    '正長候補と3挿入候補を含めても共通する物理文字列が一意なら補正する');
    assert.equal(api.buildTextFromBlocks(base), [stableFirst, expected, stableThird].join('\n'));
}

{
    const expected = '漢'.repeat(64);
    const baseText = `${expected.slice(0, 32)}ち${expected.slice(32)}`;
    const spans = [1280, 1280, 1280];
    const base = blocksForLines([expected, baseText, expected], spans);
    const variant = blocksForLines([expected, expected, expected], spans);
    assert.equal(api.pruneOcrLineInsertions(base, [variant], 'vertical', 20), 0,
        '64文字を超える列は組合せ列挙せず無変更にする');
    assert.equal(api.buildTextFromBlocks(base), [expected, baseText, expected].join('\n'));
}

{
    // 候補総数の予算: C(63,3)=39,711通りの列が2本あると2本目が予算(50,000)を超える。
    // 通常文書では到達しない上限のため、超過列は安全側（無変更）で飛ばされることを固定する。
    const correct = '漢'.repeat(60);
    const insertAt = (text, indices, char) => {
        let result = text;
        for (const index of [...indices].sort((a, b) => b - a)) {
            result = result.slice(0, index) + char + result.slice(index);
        }
        return result;
    };
    const bloatA = insertAt(correct, [10, 30, 50], 'ち');
    const bloatB = insertAt(correct, [12, 32, 52], 'ち');
    const shiftedA = insertAt(correct, [0, 20, 40], 'ち');
    const shiftedB = insertAt(correct, [2, 22, 42], 'ち');
    // 基準ピッチは中央値なので、正しい列が過半数を占める並びにする（実文書と同じ条件）。
    const spans = [1200, 1200, 1200, 1200, 1200, 1200];
    const base = blocksForLines([correct, bloatA, bloatB, correct, correct, correct], spans);
    const removed = api.pruneOcrLineInsertions(base, [
        blocksForLines([correct, correct, correct, correct, correct, correct], spans),
        blocksForLines([correct, shiftedA, shiftedB, correct, correct, correct], spans)
    ], 'vertical', 20);
    assert.equal(removed, 3,
        '候補総数が予算内に収まる列だけを補正する');
    // 列は幾何順（cross座標順）に処理され、先に列挙した列が予算を消費する。
    assert.equal(api.buildTextFromBlocks(base),
        [correct, bloatA, correct, correct, correct, correct].join('\n'),
        '予算を超過した列は列挙せず無変更のまま残す');
}

{
    // 文字を落とした列は span/文字数 が真の送りより大きくなる。基準ピッチを上位四分位で
    // 採ると（2026-08-18以前）その欠落列を掴み、正しい列まで「1文字余分」と判定して
    // 実在する文字を削除していた（実測: 「犯人と探偵」→「犯人と探」）。中央値は掴まない。
    const spans = [618, 618, 618, 618, 618, 618];
    const full = 'ら机に並べられたモニターと向かい合う男たちがいる。彼らはこ';
    const dropped = full.replace('モニター', 'モニタ');
    assert.equal([...full].length, 29);
    assert.equal([...dropped].length, 28);
    const layout = () => blocksForLines(
        [full, dropped, full, dropped, full, dropped], spans);
    assert.equal(api.hasLikelyOcrLineInsertions(layout(), 'vertical', 20), false,
        '欠落した列に引っ張られて正しい列を「1文字余分」と判定しない');
    const base = layout();
    assert.equal(api.pruneOcrLineInsertions(
        base, [layout(), layout(), layout()], 'vertical', 20), 0,
    '欠落した列があっても正しい列から文字を削除しない');
    assert.equal(api.buildTextFromBlocks(base),
        [full, dropped, full, dropped, full, dropped].join('\n'));
}

function blocksForLines(texts, spans) {
    return [{ paragraphs: [{ lines: texts.map((text, index) => {
        const word = {
            text,
            symbols: [...text].map((char) => ({ text: char, confidence: 95 }))
        };
        return {
            bbox: { x0: 100 - index * 30, y0: 0, x1: 120 - index * 30, y1: spans[index] },
            words: [word]
        };
    }) }] }];
}

{
    const blocks = blocksForLines([
        '冷房の効いたフロア内には、黙々と異様な雰囲気をまといなが',
        'ら机に並べられたモニターと向かい合う男たちがいる。彼らはこ',
        'こ、Kソフトワークスの社員たちだ。中堅どころの企業であるか',
        'らして普段から何かしら忙しく働く彼らであるが、今日はその度',
        '合いの杵が違っていた。'
    ], [596, 618, 618, 618, 216]);
    const lastLine = blocks[0].paragraphs[0].lines[4];
    lastLine.bbox = { x0: 10, y0: 16, x1: 40, y1: 232 };
    lastLine.confidence = 83;
    const lastSymbols = lastLine.words[0].symbols;
    const pitch = 216 / lastSymbols.length;
    lastSymbols.forEach((symbol, index) => {
        symbol.bbox = {
            x0: 11, y0: 16 + pitch * index,
            x1: 30, y1: 16 + pitch * (index + 0.9)
        };
    });
    lastSymbols[0].confidence = 99;
    lastSymbols[3].confidence = 93;
    lastSymbols[5].confidence = 98;
    const targets = api.collectVerticalGlyphRescanTargets(blocks, 1, 186, 663);
    assert.deepEqual(Array.from(targets, (target) => target.symbol.text), ['杵', '違'],
        '低確信度の短い本文列から優先度の高い漢字セルを最大2件集める');
    assert.ok(targets.every((target) => target.x >= 0 && target.y >= 0));

    lastSymbols.forEach((symbol) => {
        symbol.bbox = { x0: 0, y0: 0, x1: 0, y1: 0 };
    });
    assert.deepEqual(Array.from(
        api.collectVerticalGlyphRescanTargets(blocks, 1, 186, 663),
        (target) => target.symbol.text), ['杵', '違'],
    '縦書きsymbol bboxが0幅でも本文ピッチと物理文字数が一致すれば固定セルへ救済する');

    lastLine.words[0].symbols[10].text = '字';
    lastLine.words[0].text = '合いの杵が違っていた字';
    assert.equal(api.collectVerticalGlyphRescanTargets(blocks, 1, 186, 663).length, 0,
        '物理セルより認識文字が多い可能性がある短列は固定セルへ割り当てない');
    lastLine.words[0].symbols[10].text = '。';
    lastLine.words[0].text = '合いの杵が違っていた。';

    lastLine.bbox.x0 = 0;
    lastLine.bbox.x1 = 30;
    assert.equal(api.collectVerticalGlyphRescanTargets(blocks, 1, 186, 663).length, 0,
        '選択端で欠けた可能性がある短列は局所補正しない');
}

{
    const base = { text: '杵', confidence: 93 };
    assert.equal(api.selectVerticalGlyphRescanReplacement(
        base, { text: '桁', confidence: 94 }, { text: '桁', confidence: 96 }), null,
    '2画像だけでは元文字を覆さない');
    assert.equal(api.selectVerticalGlyphRescanReplacement(
        base, { text: '桁', confidence: 94 }, { text: '桁', confidence: 96 },
        { text: '桁', confidence: 83 }), '桁');
    assert.equal(api.selectVerticalGlyphRescanReplacement(
        base, { text: '桁', confidence: 94 }, { text: '析', confidence: 96 }), null,
    '独立画像が不一致なら置換しない');
    assert.equal(api.selectVerticalGlyphRescanReplacement(
        base, { text: '桁', confidence: 84 }, { text: '桁', confidence: 96 }), null,
    '片方でも低確信度なら置換しない');
    assert.equal(api.selectVerticalGlyphRescanReplacement(
        base, { text: '桁', confidence: 94 }, { text: '桁', confidence: 96 },
        { text: '析', confidence: 92 }), null, '第三画像が不一致なら置換しない');
}

{
    const evidence = api.extractSingleHanEvidence(blocksFor('桁', [94]));
    assert.equal(evidence.text, '桁');
    assert.equal(evidence.confidence, 94);
    assert.equal(api.extractSingleHanEvidence(blocksFor('桁違', [94, 96])), null,
        '局所OCRが漢字を複数出した場合は採用しない');
    assert.equal(api.extractSingleHanEvidence(blocksFor('桁A', [94, 96])), null,
        '漢字以外の意味文字を同時に出した場合は採用しない');
    const punctuation = blocksFor('桁!', [94, 20]);
    punctuation[0].paragraphs[0].lines[0].words[0].symbols[0].bbox = {
        x0: 30, y0: 20, x1: 50, y1: 45
    };
    assert.equal(api.extractSingleHanEvidence(punctuation, 80, 64).text, '桁',
        '単文字PSMが付加した句読点だけは意味文字として数えない');
    punctuation[0].paragraphs[0].lines[0].words[0].symbols[0].bbox = {
        x0: 0, y0: 20, x1: 5, y1: 45
    };
    assert.equal(api.extractSingleHanEvidence(punctuation, 80, 64), null,
        'セル中央から外れた漢字候補は採用しない');
}

{
    // 基準ピッチは中央値なので、挿入のない列が過半数を占める並びにする（実文書と同じ条件）。
    const spans = [596, 618, 618, 618, 618, 618];
    const expectedSecond = 'ら机に並べられたモニターと向かい合う男たちがいる。彼らはこ';
    const expectedFourth = 'らして普段から何かしら忙しく働く彼らであるが、今日はその度';
    const stableFirst = '冷房の効いたフロア内には、黙々と異様な雰囲気をまといなが';
    const stableThird = 'こ、Kソフトワークスの社員たちだ。中堅どころの企業であるか';
    const base = blocksForLines([
        stableFirst,
        expectedSecond.replace('彼らは', '彼らちは'),
        stableThird,
        expectedFourth.replace('から何', 'かちら何'),
        expectedSecond,
        expectedFourth
    ], spans);
    const variants = [
        blocksForLines([
            stableFirst,
            expectedSecond.replace('ら机', 'らち机'),
            stableThird,
            expectedFourth.replace('から何', 'からち何'),
            expectedSecond,
            expectedFourth
        ], spans),
        blocksForLines([
            stableFirst,
            expectedSecond.replace('彼らは', '彼ちらは'),
            stableThird,
            expectedFourth.replace('しら忙', 'しらち忙'),
            expectedSecond,
            expectedFourth
        ], spans),
        blocksForLines([
            stableFirst,
            expectedSecond.replace('彼らは', '彼らちは'),
            stableThird,
            expectedFourth.replace('彼らで', '彼ちらで'),
            expectedSecond,
            expectedFourth
        ], spans)
    ];
    assert.equal(api.pruneOcrLineInsertions(base, variants, 'vertical', 20), 2,
        '物理セル数と異なる位置の挿入証拠が揃う長い縦書き列だけを修正する');
    assert.equal(api.buildTextFromBlocks(base),
        [stableFirst, expectedSecond, stableThird, expectedFourth,
            expectedSecond, expectedFourth].join('\n'));
}

{
    const stableFirst = '冷房の効いたフロア内には、黙々と異様な雰囲気をまといなが';
    const expected = 'らして普段から何かしら忙しく働く彼らであるが、今日はその度';
    const stableThird = 'こ、Kソフトワークスの社員たちだ。中堅どころの企業であるか';
    const spans = [596, 618, 618];
    const baseText = expected
        .replace('しら忙', 'しらち忙')
        .replace('彼らで', '彼らちで');
    const shifted = expected
        .replace('から何', 'からち何')
        .replace('彼らで', '彼ちらで');
    const threeInsertions = expected
        .replace('らし', 'らちし')
        .replace('忙し', '忙ちし')
        .replace('今日', '今ち日');
    const base = blocksForLines([stableFirst, baseText, stableThird], spans);
    const variants = [shifted, threeInsertions].map((text) =>
        blocksForLines([stableFirst, text, stableThird], spans));
    assert.equal(api.pruneOcrLineInsertions(base, variants, 'vertical', 20), 2,
        '同じ列に2挿入があり、加工候補の一つが3挿入でも一意な共通列を復元する');
    assert.equal(api.buildTextFromBlocks(base), [stableFirst, expected, stableThird].join('\n'));
}

{
    const spans = [596, 618, 618];
    const stable = '冷房の効いたフロア内には、黙々と異様な雰囲気をまといなが';
    const same = 'ら机に並べられたモニターと向かい合う男たちがいる。彼らちはこ';
    const third = 'こ、Kソフトワークスの社員たちだ。中堅どころの企業であるか';
    const base = blocksForLines([stable, same, third], spans);
    const variants = [
        blocksForLines([stable, same, third], spans),
        blocksForLines([stable, same, third], spans)
    ];
    assert.equal(api.pruneOcrLineInsertions(base, variants, 'vertical', 20), 0,
        '全画像が同じ文字位置を支持する場合は幾何だけで削除しない');
    assert.equal(api.buildTextFromBlocks(base), [stable, same, third].join('\n'));
}

{
    const stableFirst = '冷房の効いたフロア内には、黙々と異様な雰囲気をまといなが';
    const expected = 'ら机に並べられたモニターと向かい合う男たちがいる。彼らはこ';
    const stableThird = 'こ、Kソフトワークスの社員たちだ。中堅どころの企業であるか';
    const baseText = `${expected.slice(0, 10)}正${expected.slice(10)}`;
    const variantA = `${expected.slice(0, 10)}ち${expected.slice(10)}`;
    const variantB = `${expected.slice(0, 10)}ら${expected.slice(10)}`;
    const spans = [596, 618, 618];
    const base = blocksForLines([stableFirst, baseText, stableThird], spans);
    const variants = [
        blocksForLines([stableFirst, variantA, stableThird], spans),
        blocksForLines([stableFirst, variantB, stableThird], spans)
    ];
    assert.equal(api.pruneOcrLineInsertions(base, variants, 'vertical', 20), 0,
        '同じ物理位置の別誤字を異なる挿入位置として数えない');
    assert.equal(api.buildTextFromBlocks(base), [stableFirst, baseText, stableThird].join('\n'));
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
