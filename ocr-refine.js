// 認識結果（Tesseract の blocks）の走査と精錬。
// 複数倍率の認識結果を文字単位で突き合わせる融合と、blocks からの
// 読み上げテキスト組み立てを担当する。
//
// ocr-image.js と同じく offscreen.html / capture.html の両方から使う。

// CJK統合漢字（U+4E00–U+9FFF）＋拡張A（U+3400–U+4DBF）の判定を1か所に集約する。
const OCR_KANJI_CLASS = "㐀-䶿一-鿿";
const OCR_KANJI_ONE_RE = new RegExp(`^[${OCR_KANJI_CLASS}]$`);  // 単一文字が漢字か

/**
 * blocks → paragraphs → lines をたどり、行ごとに visit を呼ぶ。
 * Tesseract の出力構造を歩く処理が複数あるため、入れ子のループをここに集約する。
 * @param {object[]} blocks
 * @param {(line: object) => void} visit
 */
function forEachOcrLine(blocks, visit) {
    for (const block of (blocks || [])) {
        for (const par of (block.paragraphs || [])) {
            for (const line of (par.lines || [])) visit(line);
        }
    }
}

/**
 * 記号を書き換えた単語の text を組み直す。
 * 後段のテキスト再構成が word.text を見るため、symbol.text を変えたら必ず呼ぶ。
 * @param {Iterable<object>} words
 */
function rebuildOcrWordTexts(words) {
    for (const word of words) {
        word.text = (word.symbols || []).map((s) => s.text).join("");
    }
}

// ===== blocks からの読み上げテキスト組み立て =====

/**
 * blocks から {symbol, word} の並びを取り出す。
 * symbol を書き換えたときに親 word のテキストも再構成できるよう word を持たせる。
 * @param {object[]} blocks
 * @returns {{symbol: object, word: object}[]}
 */
function collectOcrSymbols(blocks) {
    const out = [];
    forEachOcrLine(blocks, (line) => {
        for (const word of (line.words || [])) {
            for (const symbol of (word.symbols || [])) out.push({ symbol, word, line });
        }
    });
    return out;
}

// 段落の最終行を行の幾何から見分けるためのしきい値（文字サイズの何倍手前で
// 終わっていれば段落末とみなすか）。日本語の本文は行末（縦書きなら列の下端、
// 横書きなら行の右端）が揃うため、明らかに手前で終わる行は段落の最後といえる。
const OCR_PARAGRAPH_END_RATIO = 1.5;

// 段落の切れ目に空行を差し込む。空行は normalizeOcrText が明示的な段落境界として
// 扱い、読み上げに「間」を入れる（文字自体は変えない）。
// 実測（実ページを描画した24枚・段落境界60箇所）で 適合率100% / 再現率96.7%。
// 従来は行の幾何をまったく使っておらず、見出しと本文が続けて読まれていた。
function markOcrParagraphBreaks(items, orientation, glyphSize) {
    const texts = items.map((item) => item.text);
    if (items.length < 2 || !(glyphSize > 0)) return texts;
    const endOf = (bbox) => (orientation === "vertical" ? bbox.y1 : bbox.x1);
    let blockEnd = -Infinity;
    for (const item of items) {
        if (item.bbox) blockEnd = Math.max(blockEnd, endOf(item.bbox));
    }
    if (!isFinite(blockEnd)) return texts;
    const out = [];
    for (let i = 0; i < items.length; i++) {
        out.push(items[i].text);
        const bbox = items[i].bbox;
        if (i < items.length - 1 && bbox
            && blockEnd - endOf(bbox) > glyphSize * OCR_PARAGRAPH_END_RATIO) out.push("");
    }
    return out;
}

// blocks からテキストを再構成する（tesseract と同じ: 単語をスペース、行を改行で連結）。
// orientation と glyphSize を渡した場合は、段落の切れ目に空行を差し込む。
function buildTextFromBlocks(blocks, orientation, glyphSize) {
    const lines = [];
    forEachOcrLine(blocks, (line) => {
        const words = (line.words || [])
            .map((w) => (w.symbols || []).map((s) => s.text).join(""))
            .filter(Boolean);
        if (words.length) lines.push({ text: words.join(" "), bbox: line.bbox });
    });
    if (!orientation) return lines.map((line) => line.text).join("\n");
    return markOcrParagraphBreaks(lines, orientation, glyphSize).join("\n");
}

// 認識結果の行bboxから文字サイズ（縦書き=行の幅、横書き=行の高さ）の中央値を求める。
// インク分布からの自前推定はルビ・傍点・句読点の細い帯に引きずられて過小評価しやすく、
// Tesseract 自身が検出した行の実測値を使う方が頑健（実測で確認）。
function estimateGlyphSizeFromBlocks(blocks, orientation) {
    const sizes = [];
    forEachOcrLine(blocks, (line) => {
        // 実機の Tesseract は行座標が得られないことがある（他の走査と同じく防御する）
        const bbox = line.bbox;
        if (!bbox) return;
        const s = orientation === "vertical" ? bbox.x1 - bbox.x0 : bbox.y1 - bbox.y0;
        if (s > 0) sizes.push(s);
    });
    if (!sizes.length) return null;
    sizes.sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)];
}

// ===== 行構造の融合（挿入誤りの除去） =====

function collectComparableOcrLines(blocks, orientation) {
    const lines = [];
    forEachOcrLine(blocks, (line) => {
        const entries = [];
        for (const word of (line.words || [])) {
            for (const symbol of (word.symbols || [])) entries.push({ symbol, word });
        }
        const crossSize = orientation === "vertical"
            ? line.bbox?.x1 - line.bbox?.x0
            : line.bbox?.y1 - line.bbox?.y0;
        const span = orientation === "vertical"
            ? line.bbox?.y1 - line.bbox?.y0
            : line.bbox?.x1 - line.bbox?.x0;
        if (entries.length && crossSize > 0 && span > 0) {
            lines.push({ line, entries, crossSize, span });
        }
    });
    if (!lines.length) return [];
    const sizes = lines.map((item) => item.crossSize).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    // 罫線・ルビ・倍率変換端の1pxノイズを本文列の対応付けへ混ぜない。
    const filtered = lines.filter((item) => item.crossSize >= median * 0.6)
        .sort((a, b) => {
            const centerA = orientation === "vertical"
                ? (a.line.bbox.x0 + a.line.bbox.x1) / 2
                : (a.line.bbox.y0 + a.line.bbox.y1) / 2;
            const centerB = orientation === "vertical"
                ? (b.line.bbox.x0 + b.line.bbox.x1) / 2
                : (b.line.bbox.y0 + b.line.bbox.y1) / 2;
            return centerA - centerB;
        });
    if (!filtered.length) return [];
    const centers = filtered.map((item) => orientation === "vertical"
        ? (item.line.bbox.x0 + item.line.bbox.x1) / 2
        : (item.line.bbox.y0 + item.line.bbox.y1) / 2);
    const minCenter = Math.min(...centers);
    const maxCenter = Math.max(...centers);
    const spans = filtered.map((item) => item.span).sort((a, b) => a - b);
    const medianSpan = spans[Math.floor(spans.length / 2)];
    return filtered.map((item, index) => ({
        ...item,
        normalizedCross: maxCenter > minCenter
            ? (centers[index] - minCenter) / (maxCenter - minCenter)
            : 0.5,
        normalizedSpan: item.span / medianSpan
    }));
}

function findSubsequenceSkips(source, target) {
    const skipped = [];
    let targetIndex = 0;
    for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
        if (targetIndex < target.length && source[sourceIndex] === target[targetIndex]) {
            targetIndex++;
        } else {
            skipped.push(sourceIndex);
        }
    }
    return targetIndex === target.length ? skipped : null;
}

function describeOcrSkips(source, skipped) {
    if (!skipped.length) return "=";
    // 誤認文字の内容ではなく物理的な位置だけを署名にする。同じセルで候補ごとに
    // 「ち」「ら」と別字を余分出力しても、異位置の証拠として数えない。
    return skipped.map((index) => Math.round((index / Math.max(1, source.length - 1)) * 20))
        .join("|");
}

function forEachDeletedOcrSequence(entries, deleteCount, callback) {
    const source = entries.map((entry) => entry.symbol.text);
    const seenTexts = new Set();
    const chosen = [];
    const visit = (start) => {
        if (chosen.length === deleteCount) {
            const removed = new Set(chosen);
            const text = source.filter((_, index) => !removed.has(index)).join("");
            if (!seenTexts.has(text)) {
                seenTexts.add(text);
                callback({ text, deletedIndices: chosen.slice() });
            }
            return;
        }
        for (let index = start; index <= source.length - (deleteCount - chosen.length); index++) {
            chosen.push(index);
            visit(index + 1);
            chosen.pop();
        }
    };
    visit(0);
}

const OCR_INSERTION_PRUNE_MAX_LINE_LENGTH = 64;

// 1列の削除候補は最大 C(64,3)=41,664 通りで、列挙は同期処理として約340msかかる（実測）。
// 列数には上限がないため、水増し列を多数含む画像（細工された入力を含む）では
// 列数×候補数がそのままメインスレッド（音声再生も担うoffscreen）のブロック時間になる。
// 1回の呼び出しで列挙する候補の総数を制限し、超過する列は安全側（無変更）で飛ばす。
// 実文書の列（20〜30字・削除1〜3）は列あたり数千候補で、この上限には掛からない。
const OCR_INSERTION_PRUNE_MAX_TOTAL_CANDIDATES = 50000;

// C(length, deleteCount)。deleteCount は1〜3に限られる。
function countDeletedOcrSequenceCandidates(length, deleteCount) {
    let result = 1;
    for (let index = 0; index < deleteCount; index++) {
        result = (result * (length - index)) / (index + 1);
    }
    return result;
}

function hasLikelyOcrLineInsertions(blocks, orientation, glyphSize) {
    if (orientation !== "vertical" || !(glyphSize > 0)) return false;
    const lines = collectComparableOcrLines(blocks, orientation);
    const ratios = lines.filter((item) => item.entries.length >= 20
        && item.entries.length <= OCR_INSERTION_PRUNE_MAX_LINE_LENGTH)
        .map((item) => item.span / item.entries.length)
        .sort((a, b) => a - b);
    if (ratios.length < 2) return false;
    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.75)];
    if (!(nominalPitch >= glyphSize * 0.8 && nominalPitch <= glyphSize * 1.5)) return false;
    return lines.some((item) => {
        if (item.entries.length < 20
            || item.entries.length > OCR_INSERTION_PRUNE_MAX_LINE_LENGTH) return false;
        const excess = item.entries.length - Math.round(item.span / nominalPitch);
        return excess >= 1 && excess <= 3;
    });
}

/**
 * 縦書きの長い本文列で、同じ物理文字から「らち」のように2文字を出すLSTM重複を除く。
 * 語彙は使わず、(1) 列の幾何から求めた物理セル数、(2) 取得済み倍率候補の共通部分、
 * (3) 候補ごとに余分な文字の位置が異なること、の3条件が揃う場合だけ削除する。
 * 全候補が同じ文字列、置換で競合、短い列、追加文字の位置が同じ場合は変更しない。
 * @returns {number} 除去したsymbol数
 */
function pruneOcrLineInsertions(baseBlocks, otherBlocksList, orientation, glyphSize) {
    if (orientation !== "vertical" || !(glyphSize > 0)) return 0;
    const baseLines = collectComparableOcrLines(baseBlocks, orientation);
    if (baseLines.length < 2) return 0;

    const variants = [];
    for (const blocks of otherBlocksList) {
        const lines = collectComparableOcrLines(blocks, orientation);
        if (lines.length !== baseLines.length) continue;
        const geometryMatches = lines.every((item, index) => {
            const base = baseLines[index];
            const spanRatio = item.normalizedSpan / base.normalizedSpan;
            return Math.abs(item.normalizedCross - base.normalizedCross) <= 0.08
                && spanRatio >= 0.8 && spanRatio <= 1.25;
        });
        if (geometryMatches) variants.push(lines);
    }
    if (variants.length < 2) return 0;

    // 正しい列では span / 文字数 がほぼ一定。重複挿入がある列だけ比が小さくなるため、
    // 長い列の上位四分位を基準ピッチにして物理セル数を復元する。
    const ratios = baseLines
        .filter((item) => item.entries.length >= 20
            && item.entries.length <= OCR_INSERTION_PRUNE_MAX_LINE_LENGTH)
        .map((item) => item.span / item.entries.length)
        .sort((a, b) => a - b);
    if (ratios.length < 2) return 0;
    const nominalPitch = ratios[Math.floor((ratios.length - 1) * 0.75)];
    if (!(nominalPitch >= glyphSize * 0.8 && nominalPitch <= glyphSize * 1.5)) return 0;

    const removals = new Set();
    let candidateBudget = OCR_INSERTION_PRUNE_MAX_TOTAL_CANDIDATES;
    baseLines.forEach((baseLine, lineIndex) => {
        const baseLength = baseLine.entries.length;
        if (baseLength < 20 || baseLength > OCR_INSERTION_PRUNE_MAX_LINE_LENGTH) return;
        const physicalCount = Math.round(baseLine.span / nominalPitch);
        const deleteCount = baseLength - physicalCount;
        if (deleteCount < 1 || deleteCount > 3) return;

        const variantTexts = variants.map((lines) =>
            lines[lineIndex].entries.map((entry) => entry.symbol.text));
        const usable = variantTexts.filter((chars) =>
            chars.length >= physicalCount && chars.length <= physicalCount + 3);
        if (usable.length < 2) return;
        // 呼び出し全体の候補総数を予算内に収める（入力順に消費するため決定的）。
        const candidateCount = countDeletedOcrSequenceCandidates(baseLength, deleteCount);
        if (candidateCount > candidateBudget) return;
        candidateBudget -= candidateCount;

        let best = null;
        let bestSupport = -1;
        let bestSupportCount = 0;
        forEachDeletedOcrSequence(baseLine.entries, deleteCount, (candidate) => {
            const target = [...candidate.text];
            const variantSignatures = new Set();
            let exactSupport = 0;
            let support = 0;
            for (const chars of usable) {
                const skipped = findSubsequenceSkips(chars, target);
                if (!skipped || skipped.length !== chars.length - physicalCount) continue;
                support++;
                if (skipped.length) variantSignatures.add(describeOcrSkips(chars, skipped));
                else exactSupport++;
            }
            const minimumSupport = Math.max(2, Math.ceil(usable.length * 0.6));
            const baseSignature = describeOcrSkips(
                baseLine.entries, candidate.deletedIndices);
            // 物理文字数に加え、(a) 加工候補が正しい長さで完全一致する、または
            // (b) 加工によって余分文字の位置が原寸から移動する、のどちらかを必須にする。
            // 同じ誤挿入を繰り返す1候補だけではbaseの実在文字を削除しない。
            const hasMovedInsertion = [...variantSignatures]
                .some((signature) => signature !== baseSignature);
            const independentPositionEvidence = variantSignatures.size >= 2
                || (exactSupport > 0 && hasMovedInsertion);
            if (support < minimumSupport || !independentPositionEvidence) return;
            const deletedConfidence = candidate.deletedIndices.reduce((sum, index) => {
                const confidence = Number(baseLine.entries[index].symbol.confidence);
                return sum + (Number.isFinite(confidence) ? confidence : 100);
            }, 0) / candidate.deletedIndices.length;
            if (support > bestSupport) {
                best = { ...candidate, support, deletedConfidence };
                bestSupport = support;
                bestSupportCount = 1;
            } else if (support === bestSupport) {
                bestSupportCount++;
                if (deletedConfidence < best.deletedConfidence) {
                    best = { ...candidate, support, deletedConfidence };
                }
            }
        });
        if (!best) return;
        // 支持数が同じ別文字列をconfidenceだけで決めない。曖昧なら無変更。
        if (bestSupportCount > 1) return;
        for (const index of best.deletedIndices) removals.add(baseLine.entries[index]);
    });

    if (!removals.size) return 0;
    const touchedWords = new Set();
    for (const entry of removals) touchedWords.add(entry.word);
    for (const word of touchedWords) {
        word.symbols = (word.symbols || []).filter((symbol) => {
            for (const entry of removals) {
                if (entry.word === word && entry.symbol === symbol) return false;
            }
            return true;
        });
    }
    rebuildOcrWordTexts(touchedWords);
    return removals.size;
}

// ===== 短い縦書き列の独立モデル再確認 =====

const OCR_RESCAN_HAN_RE = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/u;

/**
 * 短い縦書き列から、横書きモデルで再確認する漢字セルを集める。
 * 語彙は使わず、低確信度の列・本文相当の太さ・画像端で欠けていないことだけを見る。
 */
function collectVerticalGlyphRescanTargets(
    blocks, blockScale, sourceWidth, sourceHeight, edgeInsets = null) {
    if (!(blockScale > 0) || !(sourceWidth > 0) || !(sourceHeight > 0)) return [];
    // 認識入力に余白が付いている場合、元の画像端は余白の内側（edgeInsets）にある。
    // 端で欠けたセルの除外はその内側の矩形を基準に行う（余白の有無で対象が変わらない）。
    // 数値なら4辺同じ幅、{left, top, right, bottom} なら辺ごとの幅。省略時は canvas の端。
    const insetOf = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
    const uniform = typeof edgeInsets === "number" ? insetOf(edgeInsets) : null;
    const innerLeft = uniform ?? insetOf(edgeInsets?.left);
    const innerTop = uniform ?? insetOf(edgeInsets?.top);
    const innerRight = sourceWidth - (uniform ?? insetOf(edgeInsets?.right));
    const innerBottom = sourceHeight - (uniform ?? insetOf(edgeInsets?.bottom));
    const lines = [];
    forEachOcrLine(blocks, (line) => {
        const entries = [];
        for (const word of (line.words || [])) {
            for (const symbol of (word.symbols || [])) entries.push({ word, symbol });
        }
        const width = line.bbox?.x1 - line.bbox?.x0;
        const span = line.bbox?.y1 - line.bbox?.y0;
        if (entries.length && width > 0 && span > 0) lines.push({ line, entries, width, span });
    });
    if (!lines.length) return [];
    const widths = lines.map((item) => item.width).sort((a, b) => a - b);
    const medianWidth = widths[Math.floor(widths.length / 2)];
    const longPitches = lines.filter((item) => item.entries.length >= 20)
        .map((item) => item.span / item.entries.length)
        .sort((a, b) => a - b);
    const nominalPitch = longPitches.length >= 2
        ? longPitches[Math.floor((longPitches.length - 1) * 0.75)]
        : null;
    const targets = [];
    for (const item of lines) {
        const length = item.entries.length;
        const lineConfidence = Number(item.line.confidence);
        if (length < 4 || length > 16 || !Number.isFinite(lineConfidence)
            || lineConfidence >= 90) continue;
        if (item.width < medianWidth * 0.6
            || item.line.bbox.x0 <= innerLeft * blockScale
            || item.line.bbox.x1 >= innerRight * blockScale) continue;
        const pitch = item.span / length;
        if (!(pitch > 0) || item.width > pitch * 2.2) continue;
        const firstText = item.entries[0]?.symbol.text || "";
        const lastText = item.entries[length - 1]?.symbol.text || "";
        const startsWithPunctuation = /^[\p{P}]$/u.test(firstText);
        const endsWithPunctuation = /^[\p{P}]$/u.test(lastText);
        for (let index = 0; index < length; index++) {
            const entry = item.entries[index];
            const symbolConfidence = Number(entry.symbol.confidence);
            const bbox = entry.symbol.bbox;
            let symbolWidth = bbox?.x1 - bbox?.x0;
            let symbolHeight = bbox?.y1 - bbox?.y0;
            if (!OCR_RESCAN_HAN_RE.test(entry.symbol.text)
                || !Number.isFinite(symbolConfidence)) continue;
            let cellPitch = pitch;
            let expectedCenterY = item.line.bbox.y0 + pitch * (index + 0.5);
            let symbolCenterX;
            let symbolCenterY;
            if (symbolWidth > 0 && symbolHeight > 0
                && symbolWidth <= pitch * 1.6 && symbolHeight <= pitch * 1.6) {
                symbolCenterX = (bbox.x0 + bbox.x1) / 2;
                symbolCenterY = (bbox.y0 + bbox.y1) / 2;
                if (Math.abs(symbolCenterY - expectedCenterY) > pitch * 0.2) continue;
            } else {
                // jpn_vertは実画像でsymbol bboxを全て0幅にすることがある。その場合も
                // 長い本文列から得た独立ピッチと短列の物理文字数が一致するときだけ、
                // line bboxの本文側を基準に固定セルへフォールバックする。縦書きの末尾
                // 句読点はセル下端までインクがなくline bboxが最大1セル弱短くなるため、
                // その場合だけ不足幅を許容する。1文字挿入なら不足が1セル以上となり除外される。
                const physicalSpan = nominalPitch > 0 ? item.span / nominalPitch : 0;
                const minimumSpan = endsWithPunctuation && !startsWithPunctuation
                    ? length - 0.95 : length - 0.35;
                if (!(nominalPitch > 0)
                    || physicalSpan <= minimumSpan || physicalSpan > length + 0.35
                    || pitch / nominalPitch < 0.85 || pitch / nominalPitch > 1.15) continue;
                cellPitch = nominalPitch;
                expectedCenterY = item.line.bbox.y0 + cellPitch * (index + 0.5);
                symbolWidth = cellPitch;
                symbolHeight = cellPitch;
                symbolCenterX = item.line.bbox.x0 + cellPitch * 0.55;
                symbolCenterY = expectedCenterY;
            }
            // 隣セルの画素を証拠へ混ぜない。symbol中心を基準に物理1セルだけ切り出し、
            // 横幅は句読点で広がるline bboxではなく標準ピッチから決める。
            const scaledWidth = Math.max(cellPitch * 1.6, symbolWidth * 1.25);
            const scaledHeight = cellPitch;
            const scaledX = symbolCenterX - scaledWidth / 2;
            const scaledY = symbolCenterY - scaledHeight / 2;
            const x = scaledX / blockScale;
            const y = scaledY / blockScale;
            const width = scaledWidth / blockScale;
            const height = scaledHeight / blockScale;
            // 画像端に達したセルは文字の一部が選択範囲外の可能性が高い。見えていない
            // 画を推測で補わず、局所補正の対象から外す。
            if (x < innerLeft || y < innerTop
                || x + width > innerRight || y + height > innerBottom) continue;
            targets.push({ ...entry, x, y, width, height, lineConfidence });
        }
    }
    return targets.sort((a, b) => (a.lineConfidence - b.lineConfidence)
        || (Number(a.symbol.confidence) - Number(b.symbol.confidence))).slice(0, 2);
}

/** 単一文字画像から得た意味文字が漢字1字だけの場合に限り返す。 */
function extractSingleHanEvidence(blocks, canvasWidth = null, canvasHeight = null) {
    const evidence = [];
    let invalidContent = false;
    forEachOcrLine(blocks, (line) => {
        for (const word of (line.words || [])) {
            for (const symbol of (word.symbols || [])) {
                if (OCR_RESCAN_HAN_RE.test(symbol.text)) {
                    evidence.push({
                        text: symbol.text,
                        confidence: Number(symbol.confidence),
                        bbox: symbol.bbox
                    });
                } else if (!/^[\p{P}\s]+$/u.test(symbol.text || "")) {
                    invalidContent = true;
                }
            }
        }
    });
    if (invalidContent || evidence.length !== 1 || !Number.isFinite(evidence[0].confidence)) {
        return null;
    }
    if (canvasWidth > 0 && canvasHeight > 0) {
        const bbox = evidence[0].bbox;
        const centerX = (bbox?.x0 + bbox?.x1) / 2;
        const centerY = (bbox?.y0 + bbox?.y1) / 2;
        if (!Number.isFinite(centerX) || !Number.isFinite(centerY)
            || centerX < canvasWidth * 0.1 || centerX > canvasWidth * 0.9
            || centerY < canvasHeight * 0.1 || centerY > canvasHeight * 0.9) return null;
    }
    return { text: evidence[0].text, confidence: evidence[0].confidence };
}

/**
 * 縦横モデルのconfidenceは直接比較せず、局所画像3種の強一致だけで置換を決める。
 */
function selectVerticalGlyphRescanReplacement(baseSymbol, gray, binary, third = null) {
    if (!baseSymbol || !gray || !binary || gray.text !== binary.text) return null;
    if (!OCR_RESCAN_HAN_RE.test(gray.text) || gray.text === baseSymbol.text) return null;
    const confidences = [gray.confidence, binary.confidence];
    if (confidences.some((value) => !(value >= 85))) return null;
    if ((confidences[0] + confidences[1]) / 2 < 88 || Math.max(...confidences) < 89) return null;
    // 同じ横書きモデルの加工違いは相関するため、元文字confidenceにかかわらず
    // 第三のgray倍率まで同じ字形を支持することを必須とする。
    if (!third || third.text !== gray.text || third.confidence < 80) return null;
    return gray.text;
}

// ===== 文字単位アンサンブル融合 =====
// 同じ選択範囲でも、ドラッグの数pxの違いで縮小時のサブピクセル位相が変わり、
// 同じ漢字が「核/校/枝/槻」のように揺れる（実測: 同一箇所で正答率31%）。
// このとき、ページ全体の確信度では正誤を判別できない（正解92 / 誤り90と拮抗）が、
// 文字単位の確信度は明確に差が出る（実測: 正解「核」88〜96 / 誤り「校」54〜88）。
// さらに倍率を変えると弱点の位置が変わり、どれかの倍率が高確信度で正解を出す。
// そこで複数倍率の認識結果を文字単位で整列し、低確信度の漢字だけを
// 「確信度の合計」が上回る文字へ置き換える（音声認識のROVER方式に相当）。
// 実測（カクヨム明朝・選択位置を±3pxずらした13ケース×各縮小率）:
//   0.95倍 正答 7/13→11/13, CER 0.53%→0.15% / 0.85倍 4/13→9/13, 0.75%→0.30%
//   0.80倍 5/13→8/13, 1.21%→0.53% / 全群で悪化ゼロ。
// 適用は「元寸grayが採用され、かつ文字がLSTM最適域(20〜30px)を下回る」ときだけ。
// 文字が十分大きいと拡大版の方が誤りやすく、逆効果になるため（実測: MS明朝19px で
// 正しい「譲」が拡大版の「談」で上書きされ悪化。このゲートで解消）。
const OCR_FUSION_TRIGGER_GLYPH_PX = 18;
// この確信度未満の文字だけを置換対象にする
const OCR_FUSION_MIN_CONFIDENCE = 88;
// 融合に使う拡大倍率（2倍は上の再認識で得た結果を再利用する）
const OCR_FUSION_SCALES = [1.5, 2, 3];

// 融合ゲート（18px）より大きい文字でも画像証拠による一致判定を行う。そのときの
// 変換先の文字サイズ（Tesseract LSTM の最適域 20-30px を狙う）。
const OCR_CONSENSUS_TARGET_GLYPH_PX = [20, 24, 30];

// 3つ以上の倍率候補のうち複数が同じ文字を支持したとき、全文のconfidenceではなく
// 文字単位の支持数とconfidence差で採否を決める。表示80%の実画像では元寸が誤った
// 「巳」(91)、倍率候補が「巳」(90)×1 / 正しい「己」(98)×2となり、全文confidenceは
// 全候補89-90で判別不能だった。語彙を参照せず、この画素由来の差だけを利用する。
const OCR_CONSENSUS_MIN_CONFIDENCE = 90;
const OCR_CONSENSUS_CONFIDENCE_MARGIN = 3;

// 強い多数一致のもう一つの成立条件（漢字限定）: 平均のマージンでは元寸の高い確信度
// （96〜98）が壁になって届かないが、「同じ文字を支持する各票（新規倍率の gray 候補で、
// 前後どちらかの文字が元寸と一致して位置が裏付けられたもの）が全て この値以上、かつ
// 全て元寸の確信度以上、かつ次点の平均以上」なら採る。実測（2026-08-17、tools/ocr-e2e
// 33入力・HEAD比）: 除→際（票98/98 vs 元寸98）・間→問（98/98 vs 98）・暴→虹（98/96 vs 96）
// の3件を改善し悪化0、他30入力は出力バイト一致。候補が誤っている側の26件（同じ別字を
// 2票以上が支持したが不採用）で発火するものはゼロ。94 にすると仮名の い→し(95,94) が
// 漢字限定でなければ発火するため 95 とし、文字種は漢字に限る。
const OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE = 95;

// 拡大後の画素数の上限（巨大な選択範囲で時間とメモリを浪費しないための保護）
const OCR_FUSION_MAX_AREA = 8400000;

// 編集距離の表（n×m セル、1セル4バイト）の上限。融合が発火するのは文字が小さい
// ＝文字数が多い入力なので、密な全面選択では数千文字同士の整列になり得る。
// 3000×3000（36MB・9M反復）までは許し、それを超える極端な入力では整列せず
// 融合を見送る（無変更＝安全側）。実文書の1回の選択は千数百文字程度に収まる。
const OCR_ALIGN_MAX_CELLS = 9000000;

// 2つのシンボル列を編集距離で整列し、[baseIndex, otherSymbol] の対応を返す
function alignOcrSymbols(baseEntries, otherEntries) {
    const n = baseEntries.length;
    const m = otherEntries.length;
    if (n === 0 || m === 0 || n * m > OCR_ALIGN_MAX_CELLS) return [];
    const dp = [];
    for (let i = 0; i <= n; i++) {
        dp.push(new Int32Array(m + 1));
        dp[i][0] = i;
    }
    for (let j = 0; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const cost = baseEntries[i - 1].symbol.text === otherEntries[j - 1].symbol.text ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    const pairs = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
        const cost = baseEntries[i - 1].symbol.text === otherEntries[j - 1].symbol.text ? 0 : 1;
        if (dp[i][j] === dp[i - 1][j - 1] + cost) { pairs.push([i - 1, otherEntries[j - 1].symbol]); i--; j--; }
        else if (dp[i][j] === dp[i - 1][j] + 1) { i--; }
        else { j--; }
    }
    return pairs;
}

/**
 * 各倍率の認識結果を base のシンボル列へ整列し、倍率ごとの対応を返す。
 * 全会一致・多数一致・低確信度融合で同じ整列結果を使うため共通化する。
 * @param {{symbol: object, word: object}[]} baseEntries
 * @param {object[][]} otherBlocksList
 * @returns {[number, object][][]} 倍率ごとの [baseIndex, symbol] の並び
 */
function alignOcrVariants(baseEntries, otherBlocksList) {
    const aligned = [];
    for (const otherBlocks of otherBlocksList) {
        const otherEntries = collectOcrSymbols(otherBlocks);
        // 空認識も空の対応表として残す。候補を落とすと、後段の
        // unanimousVariantCount（新規倍率と補充候補の境界）がずれてしまう。
        aligned.push(otherEntries.length ? alignOcrSymbols(baseEntries, otherEntries) : []);
    }
    return aligned;
}

function classifyOcrSymbol(text) {
    if (OCR_KANJI_ONE_RE.test(text)) return "kanji";
    if (/^[ぁ-ゖ]$/.test(text)) return "hiragana";
    if (/^[ァ-ヺー]$/.test(text)) return "katakana";
    if (/^[A-Za-zＡ-Ｚａ-ｚ]$/.test(text)) return "latin";
    if (/^[0-9０-９]$/.test(text)) return "digit";
    return null;
}

// 複数倍率の認識結果で元寸の文字を精錬する。判断の根拠は2つ。
// (1) 全会一致: すべての倍率が揃って「元寸とは違う同じ文字」を出した場合、そちらを採る。
//     元寸は高い確信度のまま誤ることがあり、確信度ではゲートできない
//     （実測: 誤った「バ」が確信度94、一方で全倍率が正しい「パ」を出していた。
//      濁点・半濁点の取り違えは読み上げで別語になるため影響が大きい）。
//     独立した複数倍率が全会一致した事実そのものを根拠にする。
//     実ページ24枚の実測で 改善13・悪化0。
// (2) 強い多数一致: 3候補以上のうち複数が同じ文字を支持し、その平均confidenceが
//     元文字と次点候補をマージン以上上回る場合に置き換える。前後どちらかの文字が
//     baseと一致する候補だけを数え、編集距離整列の位置ずれを誤って票にしない。
// (3) 低確信度の漢字: 確信度の合計が上回る漢字へ置き換える（従来からの機能）。
// options.kanji / options.unanimous / options.consensus で対象を切り替える。
// options.unanimousVariantCount は補充前の候補だけで全会一致を評価し、
// options.consensusClasses / options.consensusIncludesBase は候補不足時の強い多数一致を
// 文字種限定・元寸を含む票決へ切り替える（いずれも指定なしなら従来動作）。
// 置換した文字数を返す（0 なら呼び出し側は元のテキストをそのまま使う）。
function fuseOcrSymbols(baseBlocks, otherBlocksList, options = {}) {
    const useKanji = options.kanji !== false;
    const useUnanimous = options.unanimous !== false;
    const useConsensus = options.consensus !== false;
    const consensusClasses = options.consensusClasses
        ? new Set(options.consensusClasses) : null;
    const unanimousVariantCount = Number.isInteger(options.unanimousVariantCount)
        ? Math.max(0, options.unanimousVariantCount) : null;
    const consensusIncludesBase = options.consensusIncludesBase === true;
    const isKanji = (t) => OCR_KANJI_ONE_RE.test(t);
    const baseEntries = collectOcrSymbols(baseBlocks);
    if (!baseEntries.length) return 0;
    // 同じforEach内の先行置換を、隣の文字の位置アンカーや元寸票に使わない。
    // 判定開始時の文字とconfidenceを固定し、各文字を独立に評価する。
    const baseSnapshot = baseEntries.map((entry) => ({
        text: entry.symbol.text,
        confidence: Number(entry.symbol.confidence),
        line: entry.line
    }));

    const variantMaps = [];
    for (const pairs of alignOcrVariants(baseEntries, otherBlocksList)) {
        const map = new Map();
        for (const [index, symbol] of pairs) {
            if (!map.has(index)) map.set(index, symbol);
        }
        variantMaps.push(map);
    }

    const hasStableNeighbor = (map, index) => {
        const entry = baseSnapshot[index];
        for (const offset of [-1, 1]) {
            const neighbor = baseSnapshot[index + offset];
            if (neighbor && neighbor.line === entry.line
                && map.get(index + offset)?.text === neighbor.text) return true;
        }
        return false;
    };

    const touchedWords = new Set();
    let replaced = 0;
    baseEntries.forEach((entry, index) => {
        const symbol = entry.symbol;
        const alts = variantMaps.map((map) => map.get(index)).filter(Boolean);

        // (1) 全会一致による置換。確信度ではゲートしない（上のコメント参照）。
        const unanimousAlts = (unanimousVariantCount == null
            ? variantMaps : variantMaps.slice(0, unanimousVariantCount))
            .map((map) => map.get(index)).filter(Boolean);
        if (useUnanimous && unanimousAlts.length >= 2) {
            const first = unanimousAlts[0].text;
            if (first !== symbol.text && unanimousAlts.every((a) => a.text === first)) {
                symbol.text = first;
                touchedWords.add(entry.word);
                replaced++;
                return;
            }
        }

        // (2) 同じ種類の文字について、位置が前後の文字で裏付けられた倍率候補だけを投票する。
        const consensusEvidenceCount = alts.length + (consensusIncludesBase ? 1 : 0);
        if (useConsensus && consensusEvidenceCount >= 3) {
            const original = baseSnapshot[index];
            const baseClass = classifyOcrSymbol(original.text);
            const votes = new Map();
            if (baseClass && (!consensusClasses || consensusClasses.has(baseClass))) {
                if (consensusIncludesBase) {
                    const confidence = original.confidence;
                    if (Number.isFinite(confidence)) {
                        votes.set(original.text, {
                            text: original.text,
                            count: 1,
                            total: confidence,
                            primaryCount: 0,
                            primaryMin: Infinity
                        });
                    }
                }
                variantMaps.forEach((map, variantIndex) => {
                    const candidate = map.get(index);
                    if (!candidate || classifyOcrSymbol(candidate.text) !== baseClass
                        || !hasStableNeighbor(map, index)) return;
                    const confidence = Number(candidate.confidence);
                    if (!Number.isFinite(confidence)) return;
                    const vote = votes.get(candidate.text)
                        || { text: candidate.text, count: 0, total: 0, primaryCount: 0, primaryMin: Infinity };
                    vote.count++;
                    vote.total += confidence;
                    // 「全票が元寸以上」の判定には、新規倍率の候補（補充候補より前）だけを数える。
                    if (unanimousVariantCount == null || variantIndex < unanimousVariantCount) {
                        vote.primaryCount++;
                        vote.primaryMin = Math.min(vote.primaryMin, confidence);
                    }
                    votes.set(candidate.text, vote);
                });
            }
            const ranked = [...votes.values()].map((vote) => ({
                ...vote,
                average: vote.total / vote.count
            })).sort((a, b) => (b.count - a.count) || (b.average - a.average));
            const top = ranked[0];
            const runnerUp = ranked[1];
            const baseConfidence = Number.isFinite(original.confidence)
                ? original.confidence : 0;
            const comparison = Math.max(baseConfidence, runnerUp?.average || 0);
            // 「全票が元寸以上」（OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE のコメント参照）:
            // 漢字限定、元寸の確信度が数値で得られていること、新規倍率の票が2件以上あり、
            // その最小値が しきい値・元寸・次点平均 のすべて以上であること。
            const allVotesAtLeastBase = !!top && baseClass === "kanji"
                && Number.isFinite(original.confidence)
                && top.primaryCount >= 2
                && top.primaryMin >= OCR_CONSENSUS_EQUAL_MIN_CONFIDENCE
                && top.primaryMin >= baseConfidence
                && (!runnerUp || top.primaryMin >= runnerUp.average);
            if (top && top.text !== original.text && top.count >= 2
                && (!runnerUp || top.count > runnerUp.count)
                && top.average >= OCR_CONSENSUS_MIN_CONFIDENCE
                && (top.average >= comparison + OCR_CONSENSUS_CONFIDENCE_MARGIN
                    || allVotesAtLeastBase)) {
                symbol.text = top.text;
                touchedWords.add(entry.word);
                replaced++;
                return;
            }
        }

        // (3) 低確信度の漢字。同じ文字を出したバリアントの確信度を合計し、最大の文字を選ぶ。
        if (!useKanji || symbol.confidence >= OCR_FUSION_MIN_CONFIDENCE || !isKanji(symbol.text)) return;
        const scores = new Map();
        const add = (text, confidence) => scores.set(text, (scores.get(text) || 0) + confidence);
        add(symbol.text, symbol.confidence);
        for (const cand of alts) add(cand.text, cand.confidence);

        let best = null;
        for (const [text, score] of scores) {
            if (!best || score > best.score) best = { text, score };
        }
        if (best && best.text !== symbol.text && isKanji(best.text)
            && best.score > (scores.get(symbol.text) || 0)) {
            symbol.text = best.text;
            touchedWords.add(entry.word);
            replaced++;
        }
    });

    rebuildOcrWordTexts(touchedWords);
    return replaced;
}

// ===== 整列一致による余剰文字の削除 =====

// 削除してよい base symbol の確信度の上限。
// 試作の実測（明朝合成コーパス6件・出荷経路へ注入）: 上限なし = 誤り 37→36
// （改善2・悪化1）／95未満に限定 = 37→36（改善1・悪化0）。
// 本採用時の実測（2026-08-16、tools/ocr-e2e 33入力: 既存9＋AAあり明朝・ゴシック24、
// HEAD比・予算60秒固定・逐次）: 誤り 128→123、改善5・悪化0。削除された文字は
// ぎ・は・人・和・ぬ の余剰挿入のみで、正しい文字の削除は0件。
// 確信度の高い文字は実在する可能性が高く、候補側が整列の都合で対応を持たないだけの
// ことがあるため、明らかに自信のない文字だけを削除対象にする。
const OCR_PRUNE_INSERTION_MAX_CONFIDENCE = 95;

/**
 * 既存の整列（alignOcrVariants / alignOcrSymbols）の結果だけを使い、
 * base にしか存在しない余剰文字を削除する。追加のOCRは行わない。
 * 幾何・ピッチを使わないため縦書き・横書きの両方で使える
 * （列の物理長を根拠にする pruneOcrLineInsertions は縦書き専用のまま）。
 *
 * 削除するのは次をすべて満たす symbol だけ:
 *  - 同じ行に前後の symbol がある（行頭・行末は対象外）
 *  - 「前後の symbol が同一文字として対応付いた候補」が minVariants 件以上ある
 *  - その候補すべてが「その位置に対応する文字を持たない」＝全会一致で余剰と言う
 *  - base symbol の確信度が maxConfidence 未満（確信度が取れない文字は削除しない）
 *
 * 判定は開始時のスナップショットに対して行うため決定的で、条件が成立しなければ
 * blocks を一切変更しない（例外時も無変更）。symbol の同一性は後段（局所再確認の
 * 置換適用）が参照するため、blocks は複製せずその場から余剰 symbol だけを取り除き、
 * word.text を組み直す。呼び出し側は戻り値が正なら buildTextFromBlocks で組み直す。
 *
 * @param {object[]} baseBlocks 変更対象（採用中の認識結果）
 * @param {object[][]} otherBlocksList 比較候補の blocks
 * @param {{minVariants?: number, maxConfidence?: number}} [options]
 * @returns {number} 削除した symbol 数（0 なら呼び出し側は無変更）
 */
function pruneOcrConsensusInsertions(baseBlocks, otherBlocksList, options = {}) {
    const minVariants = Number.isInteger(options.minVariants)
        ? Math.max(2, options.minVariants) : 2;
    const maxConfidence = Number.isFinite(options.maxConfidence)
        ? options.maxConfidence : OCR_PRUNE_INSERTION_MAX_CONFIDENCE;
    let removals;
    try {
        // 候補が2件未満なら何もしない（1候補の欠落を根拠に実在文字を消さない）。
        if (!otherBlocksList || otherBlocksList.length < minVariants) return 0;
        const baseEntries = collectOcrSymbols(baseBlocks);
        if (baseEntries.length < 3) return 0;
        const maps = [];
        for (const pairs of alignOcrVariants(baseEntries, otherBlocksList)) {
            // 空認識（整列できない候補）は「その位置に文字なし」の証拠に数えない。
            if (!pairs.length) continue;
            const map = new Map();
            for (const [index, symbol] of pairs) {
                if (!map.has(index)) map.set(index, symbol);
            }
            maps.push(map);
        }
        if (maps.length < minVariants) return 0;
        // 先行削除の影響を後続判定へ持ち込まないよう、開始時の文字と行を固定する。
        const snapshot = baseEntries.map((entry) => ({
            text: entry.symbol.text, line: entry.line
        }));
        removals = [];
        baseEntries.forEach((entry, index) => {
            const current = snapshot[index];
            const previous = snapshot[index - 1];
            const next = snapshot[index + 1];
            if (!previous || !next
                || previous.line !== current.line || next.line !== current.line) return;
            let anchored = 0;
            let missing = 0;
            for (const map of maps) {
                // 両隣が同一文字として対応付いた候補だけが、この位置について証言できる。
                if (map.get(index - 1)?.text !== previous.text
                    || map.get(index + 1)?.text !== next.text) continue;
                anchored++;
                if (!map.has(index)) missing++;
            }
            if (anchored < minVariants || missing !== anchored) return;
            // 確信度が数値で得られない文字は削除しない（安全側）。
            const confidence = entry.symbol.confidence;
            if (typeof confidence !== "number" || !Number.isFinite(confidence)
                || confidence >= maxConfidence) return;
            removals.push({ entry, index });
        });
    } catch (error) {
        // 整列・走査の失敗で認識結果を壊さない（安全側＝無変更）。
        console.warn("OCR: 一致による余剰文字の削除に失敗:", error?.message || error);
        return 0;
    }
    if (!removals.length) return 0;

    const removedSymbols = new Set();
    const touchedWords = new Set();
    for (const removal of removals) {
        removedSymbols.add(removal.entry.symbol);
        touchedWords.add(removal.entry.word);
    }
    for (const word of touchedWords) {
        word.symbols = (word.symbols || []).filter((symbol) => !removedSymbols.has(symbol));
    }
    rebuildOcrWordTexts(touchedWords);
    // 削除した文字と base 内の位置を残す（既定では表示されない verbose レベル）。
    console.debug("OCR: 一致により余剰文字を削除:", removals.slice(0, 20)
        .map((removal) => `${removal.entry.symbol.text}@${removal.index}`).join(" "),
    removals.length > 20 ? `ほか${removals.length - 20}件` : "");
    return removals.length;
}

// 二値化版を全文採用した後、同じ位置の漢字についてだけ元寸grayと2倍grayを照合する。
// 二つのgrayが同じ文字を二値化版以上のconfidenceで支持する場合、または元寸grayが
// 二つの加工結果をマージン以上上回る場合だけ元寸文字を復元する。単語辞書は使わず、
// 仮名・句読点・行分割・挿入欠落を含む二値化版のそれ以外の改善は変更しない。
function protectOcrSymbolsFromWholeSwap(baseBlocks, referenceBlocks, corroboratingBlocks) {
    const baseEntries = collectOcrSymbols(baseBlocks);
    if (!baseEntries.length) return 0;

    const aligned = alignOcrVariants(baseEntries, [referenceBlocks, corroboratingBlocks]);
    if (aligned.length !== 2 || !aligned[0].length || !aligned[1].length) return 0;

    const maps = aligned.map((pairs) => {
        const map = new Map();
        for (const [index, symbol] of pairs) {
            if (!map.has(index)) map.set(index, symbol);
        }
        return map;
    });
    const [referenceMap, corroboratingMap] = maps;
    const snapshot = baseEntries.map((entry) => ({ text: entry.symbol.text, line: entry.line }));
    const hasStableNeighbor = (map, index) => {
        const entry = snapshot[index];
        for (const offset of [-1, 1]) {
            const neighbor = snapshot[index + offset];
            if (neighbor && neighbor.line === entry.line
                && map.get(index + offset)?.text === neighbor.text) return true;
        }
        return false;
    };

    const touchedWords = new Set();
    let replaced = 0;
    baseEntries.forEach((entry, index) => {
        const proposed = entry.symbol;
        const reference = referenceMap.get(index);
        const corroborating = corroboratingMap.get(index);
        if (!reference || !corroborating || reference.text === proposed.text
            || classifyOcrSymbol(proposed.text) !== "kanji"
            || classifyOcrSymbol(reference.text) !== "kanji"
            || !hasStableNeighbor(referenceMap, index)
            || !hasStableNeighbor(corroboratingMap, index)) return;

        const proposedConfidence = Number(proposed.confidence);
        const referenceConfidence = Number(reference.confidence);
        const corroboratingConfidence = Number(corroborating.confidence);
        if (![proposedConfidence, referenceConfidence, corroboratingConfidence].every(Number.isFinite)) return;

        let shouldRestore = false;
        if (corroborating.text === reference.text) {
            shouldRestore = (referenceConfidence + corroboratingConfidence) / 2
                >= proposedConfidence;
        } else if (corroborating.text === proposed.text) {
            const processedAverage = (proposedConfidence + corroboratingConfidence) / 2;
            shouldRestore = referenceConfidence
                >= processedAverage + OCR_CONSENSUS_CONFIDENCE_MARGIN;
        }
        if (!shouldRestore) return;

        proposed.text = reference.text;
        touchedWords.add(entry.word);
        replaced++;
    });

    rebuildOcrWordTexts(touchedWords);
    return replaced;
}
