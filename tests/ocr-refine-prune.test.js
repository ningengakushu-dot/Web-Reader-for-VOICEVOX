// 整列一致による余剰文字の削除段（pruneOcrConsensusInsertions）の純関数検査。
// 出荷ソースをそのまま vm で読み込み、発火条件と安全側の不発条件を固定する。
// ※精度そのものの主張は tools/ocr-e2e の実測で行う（合成テストは実効の証明にならない）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-refine.js'), 'utf8')
    + '\n;globalThis.ocrTestApi = {pruneOcrConsensusInsertions, buildTextFromBlocks, '
    + 'OCR_PRUNE_INSERTION_MAX_CONFIDENCE};';
const context = vm.createContext({ console, Map, Set, Uint8Array, Int32Array, RegExp });
vm.runInContext(source, context);
const api = context.ocrTestApi;

// 1行1ワードの blocks。confidences は文字ごと（省略時は 90）。
function blocksForLine(text, confidences = []) {
    return blocksForLines([text], [confidences]);
}

function blocksForLines(texts, confidencesList = []) {
    return [{ paragraphs: [{ lines: texts.map((text, lineIndex) => {
        const confidences = confidencesList[lineIndex] || [];
        return {
            bbox: { x0: 0, y0: lineIndex * 30, x1: 20, y1: lineIndex * 30 + 20 },
            words: [{
                text,
                symbols: [...text].map((char, index) => ({
                    text: char,
                    confidence: confidences[index] ?? 90
                }))
            }]
        };
    }) }] }];
}

assert.equal(api.OCR_PRUNE_INSERTION_MAX_CONFIDENCE, 95);

{
    // 発火する例: 両隣が同一文字として対応付いた候補2件が、そろって
    // 「その位置に文字なし」と言い、base の確信度が 95 未満。
    const base = blocksForLine('あいうえお', [98, 98, 90, 98, 98]);
    const variants = [blocksForLine('あいえお'), blocksForLine('あいえお')];
    assert.equal(api.pruneOcrConsensusInsertions(base, variants), 1,
        '全候補が同じ位置に文字を持たない低確信度文字を削除する');
    assert.equal(api.buildTextFromBlocks(base), 'あいえお');
}

{
    // 横書き・縦書きの区別なく使える（orientation を引数に取らない）。
    // 複数行のうち、両隣が同じ行にある文字だけが対象になる。
    const base = blocksForLines(
        ['あいうえお', 'かきくけこ'],
        [[98, 98, 90, 98, 98], [98, 98, 98, 98, 98]]);
    const variants = [
        blocksForLines(['あいえお', 'かきくけこ']),
        blocksForLines(['あいえお', 'かきくけこ'])
    ];
    assert.equal(api.pruneOcrConsensusInsertions(base, variants), 1);
    assert.equal(api.buildTextFromBlocks(base), 'あいえお\nかきくけこ');
}

{
    // 行頭・行末の文字は前後のアンカーが取れないため削除しない。
    const base = blocksForLines(['ちあいうえお'], [[90, 98, 98, 98, 98, 98]]);
    const variants = [blocksForLine('あいうえお'), blocksForLine('あいうえお')];
    assert.equal(api.pruneOcrConsensusInsertions(base, variants), 0,
        '行頭の余剰文字は両隣が揃わないため削除しない');
    assert.equal(api.buildTextFromBlocks(base), 'ちあいうえお');
}

{
    // 両隣が候補側で別文字に対応している（＝整列位置を裏付けられない）と発火しない。
    const base = blocksForLine('あいうえお', [98, 98, 90, 98, 98]);
    const variants = [blocksForLine('あぬえん'), blocksForLine('あぬえん')];
    assert.equal(api.pruneOcrConsensusInsertions(base, variants), 0,
        '両隣が一致しない候補は「その位置に文字なし」の証拠に数えない');
    assert.equal(api.buildTextFromBlocks(base), 'あいうえお');
}

{
    // 片方の候補だけが文字を持たない場合（missing !== anchored）は削除しない。
    const base = blocksForLine('あいうえお', [98, 98, 90, 98, 98]);
    const variants = [blocksForLine('あいえお'), blocksForLine('あいうえお')];
    assert.equal(api.pruneOcrConsensusInsertions(base, variants), 0,
        '対応付いた候補の一部でも文字を持つなら削除しない');
    assert.equal(api.buildTextFromBlocks(base), 'あいうえお');
}

{
    // conf >= 95 は削除しない（確信度の高い文字は実在の可能性が高い）。
    const base = blocksForLine('あいうえお', [98, 98, 95, 98, 98]);
    const variants = [blocksForLine('あいえお'), blocksForLine('あいえお')];
    assert.equal(api.pruneOcrConsensusInsertions(base, variants), 0,
        '確信度95以上の文字は候補が揃っても削除しない');
    assert.equal(api.buildTextFromBlocks(base), 'あいうえお');

    const justBelow = blocksForLine('あいうえお', [98, 98, 94, 98, 98]);
    assert.equal(api.pruneOcrConsensusInsertions(justBelow, variants), 1,
        '確信度94なら削除する（境界は95）');
    assert.equal(api.buildTextFromBlocks(justBelow), 'あいえお');

    const noConfidence = blocksForLine('あいうえお', [98, 98, undefined, 98, 98]);
    noConfidence[0].paragraphs[0].lines[0].words[0].symbols[2].confidence = null;
    assert.equal(api.pruneOcrConsensusInsertions(noConfidence, variants), 0,
        '確信度が取得できない文字は削除しない');
}

{
    // 候補が1件（または空認識で実効1件）なら不発。
    const base = blocksForLine('あいうえお', [98, 98, 90, 98, 98]);
    assert.equal(api.pruneOcrConsensusInsertions(base, [blocksForLine('あいえお')]), 0,
        '候補1件では削除しない');
    assert.equal(api.pruneOcrConsensusInsertions(base, [blocksForLine('あいえお'), []]), 0,
        '空認識は「文字なし」の証拠に数えないため実効1件で不発');
    assert.equal(api.pruneOcrConsensusInsertions(base, []), 0);
    assert.equal(api.pruneOcrConsensusInsertions(base, null), 0);
    assert.equal(api.buildTextFromBlocks(base), 'あいうえお');
}

{
    // 例外時は無変更（blocks の構造が壊れていても認識結果を捨てない）。
    assert.equal(api.pruneOcrConsensusInsertions(
        [{ paragraphs: [{ lines: [{ words: null }] }] }],
        [blocksForLine('あい'), blocksForLine('あい')]), 0);
}

console.log('OCR consensus insertion prune: PASSED');
