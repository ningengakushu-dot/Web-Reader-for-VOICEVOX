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
assert.match(common, /best === preprocessedData[\s\S]*protectOcrSymbolsFromWholeSwap/,
    '二値化版を全文採用した後に危険な漢字衝突だけを局所比較する');
assert.match(common, /protectOcrSymbolsFromWholeSwap\([\s\S]*best\.blocks, primary\.data\.blocks, upscaled2x\.blocks/,
    '元寸・2倍gray・二値化の取得済み3画像だけを比較する');
assert.match(common, /for \(const data of \[upscaled2x, preprocessedData\]\)/,
    '候補不足時に認識済み2倍版と二値化版を画像証拠として再利用する');
assert.match(common, /unanimousVariantCount: others\.length/,
    '補充候補が既存の全会一致判定へ混ざらない');
assert.match(common, /fuseOcrSymbols\(best\.blocks, others, \{ consensusClasses: \["kanji"\] \}\)/,
    '小文字融合経路の強い多数一致は漢字限定にする（仮名・数字の2/3置換を許さない）');
assert.match(common, /resolvedFullData\?\.\[primaryLang\][\s\S]*primaryWorker\.recognize/,
    '向き判定の全体認識を本文認識として再利用する');
assert.match(common, /resolvedFullData\?\.\[secondaryLang\]/,
    '向き判定で取得済みの副方向結果も再認識せず再利用する');
assert.match(common, /pruneOcrLineInsertions/,
    '倍率間で位置が揺れる重複文字を列構造から除去する');
assert.match(common, /refineVerticalGlyphsWithHorizontalWorker/,
    '短い縦列は独立した横書きモデルで局所確認する');
assert.match(common, /localRescanPromise = orientation === "vertical"[\s\S]*canRefine\(\)[\s\S]*refineVerticalGlyphsWithHorizontalWorker/,
    '短列の局所確認はプール状態に依存せず全文精錬と並行開始する');
assert.match(common, /await localRescanPromise/,
    '並行局所確認の完了を最終テキストへ反映する');
assert.match(common, /upscaled2x = [\s\S]*await recognizePreprocessed\(\)/,
    '重複挿入時も既存2x救済と二値化の順序を維持する');
assert.doesNotMatch(common, /recognizePreprocessed\(true\)|forceForStructure/,
    '構造証拠の収集で時間予算を迂回しない');
assert.match(common, /if \(ensureStructuralEvidence\)[\s\S]*if \(!canRefine\(\)\) break;\s*\n\s*useRefine\(\);[\s\S]*structuralUpscaledData\.set/,
    '重複削除の倍率証拠は時間予算の範囲内で最大2件だけ集める');
assert.match(common, /finally[\s\S]*localReplacements = await localRescanPromise[\s\S]*applyVerticalGlyphRescanReplacements/,
    '局所OCRは例外時もworker復元まで合流し、全文融合後に置換案だけを適用する');
assert.match(common + read('ocr-image.js'), /OCR_ORIENTATION_FULL_COMPARE_MAX_AREA[\s\S]*pickOcrTextPatch/,
    '全画面級の曖昧画像は全体二重認識せず小領域比較へ戻す');
assert.doesNotMatch(common + read('ocr-refine.js'), /自己主張|ジミシュチョウ|彼らちは|普段かちら/,
    '特定語句の辞書・置換規則をOCR実行コードへ入れない');

const dom = read('dom-text.js');
assert.match(dom, /role === "paren" \|\| role === "reading"/,
    'DOMでは読み仮名と補助括弧だけを除外して親文字を読む');
assert.doesNotMatch(dom, /role === "base"/,
    'DOMの親文字をルビ設定で置き換えない');

console.log('standard OCR path without ruby feature: PASSED');
