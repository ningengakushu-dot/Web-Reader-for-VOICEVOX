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
assert.equal((common.match(/pruneOcrConsensusInsertions/g) || []).length, 3,
    '整列一致による余剰文字削除は3つの融合・構造証拠地点で一度ずつだけ呼ぶ');
assert.doesNotMatch(common, /isInflatedOcrVariant|filterInflatedOcrVariants/,
    '文字数膨張ゲートは実測で悪化したため導入しない（neko_v_mincho_13 4→5誤り、2026-08-16）');
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
// 組版方向の全体比較の上限（2026-08-17）: 精錬を許す面積と同じ 120万px まで縦横2モデルで
// 全体を比較する。40万px だと 552x796 の小説ページが 240px パッチ比較に回り、jpn 77 / jpn_vert 76
// で横書きに倒れて全文が崩壊した（CER 99%）。全画面級のパッチは 480px。
const image = read('ocr-image.js');
assert.match(image, /const OCR_ORIENTATION_FULL_COMPARE_MAX_AREA = 1200000;/,
    '方向の全体比較は 120万px（OCR_REFINE_MAX_AREA と同じ）まで行う');
assert.match(common, /const OCR_REFINE_MAX_AREA = 1200000;/,
    '精錬を許す面積の上限（全体比較の上限と揃える）');
assert.match(image, /const OCR_ORIENTATION_PATCH_PX = 480;/,
    '全画面級の方向確認パッチは 480px（240px は 20px 明朝で縦横の差が付かない）');
// 認識入力の余白付与（2026-08-17）: 余白は認識に渡す画像にだけ付け、判定は無余白で行う
assert.match(common, /const unpaddedGrayCanvas = toGrayscale\(sourceCanvas\);\s*\n\s*const paddedInput = padOcrCanvasToMargin\(unpaddedGrayCanvas, OCR_INPUT_PAD_PX\);/,
    '認識入力（gray）は文字が端に接する辺にだけ背景色の余白を足し、最低余白を確保する（余白がある画像は無変更）');
assert.match(common, /const sourceArea = sourceCanvas\.width \* sourceCanvas\.height;/,
    '面積によるしきい値は余白の無い元画像で計算する');
assert.doesNotMatch(common, /grayCanvas\.width \* grayCanvas\.height|grayCanvas\.width \* scale/,
    '余白付き canvas の寸法をしきい値判定に使わない');
assert.match(common, /detectTextOrientation\(sourceCanvas\)/,
    '組版方向の画素判定は余白の無い元画像で行う');
assert.match(common, /pickOcrTextPatch\(unpaddedGrayCanvas, OCR_ORIENTATION_PATCH_PX\)/,
    '局所パッチは余白の無い gray から選ぶ（余白で格子がずれると大きな横書きが縦書きに誤判定される: ms_body 4→236）');
assert.match(common, /const prepared = prepareOcrCanvas\(sourceCanvas\);[\s\S]*padOcrCanvas\(preparedMasked, \{[\s\S]*inputInsets\.left \* preparedScale[\s\S]*\}, 255\)/,
    '二値化は無余白で行い（しきい値を動かさない）、その結果に同じ余白（白）を付けて認識する');
assert.match(common, /refineVerticalGlyphsWithHorizontalWorker\(\s*grayCanvas, primary\.data\.blocks, 1, workerProvider, inputInsets\)/,
    '局所再確認には余白幅を渡し、元の画像端で欠けたセルの除外を維持する');
assert.match(read('ocr-refine.js'), /const OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE = 95;/,
    '「全票が元寸以上」の漢字多数一致は 95 以上・漢字限定（実測 123→120、悪化0）');
assert.match(common, /detected\.confident && detected\.orientation === "vertical"\s*\?\s*findOcrOutlierInkBands\(grayCanvas\)/,
    '柱・ページ番号の帯の塗りつぶしは、画素統計で縦書きと確定した入力だけに適用する（横書きの見出し行を消さない）');
assert.match(common, /fillOcrCanvasBands\(prepared, outlierBands\.map\(/,
    '二値化版にも同じ帯を塗る（候補間で見えている文字が違うと整列・融合がずれる）');
assert.doesNotMatch(common + read('ocr-refine.js'), /自己主張|ジミシュチョウ|彼らちは|普段かちら/,
    '特定語句の辞書・置換規則をOCR実行コードへ入れない');

const dom = read('dom-text.js');
assert.match(dom, /role === "paren" \|\| role === "reading"/,
    'DOMでは読み仮名と補助括弧だけを除外して親文字を読む');
assert.doesNotMatch(dom, /role === "base"/,
    'DOMの親文字をルビ設定で置き換えない');

console.log('standard OCR path without ruby feature: PASSED');
