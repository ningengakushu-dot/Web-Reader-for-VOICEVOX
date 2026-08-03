// 認識結果（Tesseract の blocks）の走査と精錬。
// 複数倍率の認識結果を文字単位で突き合わせる融合と、blocks からの
// 読み上げテキスト組み立てを担当する。
//
// ocr-image.js と同じく offscreen.html / capture.html の両方から使う。

// CJK統合漢字（U+4E00–U+9FFF）＋拡張A（U+3400–U+4DBF）の判定を1か所に集約する。
const OCR_KANJI_CLASS = "㐀-䶿一-鿿";
const OCR_KANJI_RE = new RegExp(`[${OCR_KANJI_CLASS}]`);       // 部分一致（漢字を含むか）
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
        const s = orientation === "vertical"
            ? line.bbox.x1 - line.bbox.x0
            : line.bbox.y1 - line.bbox.y0;
        if (s > 0) sizes.push(s);
    });
    if (!sizes.length) return null;
    sizes.sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)];
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

// 拡大後の画素数の上限（巨大な選択範囲で時間とメモリを浪費しないための保護）
const OCR_FUSION_MAX_AREA = 8400000;

// 2つのシンボル列を編集距離で整列し、[baseIndex, otherSymbol] の対応を返す
function alignOcrSymbols(baseEntries, otherEntries) {
    const n = baseEntries.length;
    const m = otherEntries.length;
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
                            total: confidence
                        });
                    }
                }
                variantMaps.forEach((map) => {
                    const candidate = map.get(index);
                    if (!candidate || classifyOcrSymbol(candidate.text) !== baseClass
                        || !hasStableNeighbor(map, index)) return;
                    const confidence = Number(candidate.confidence);
                    if (!Number.isFinite(confidence)) return;
                    const vote = votes.get(candidate.text) || { text: candidate.text, count: 0, total: 0 };
                    vote.count++;
                    vote.total += confidence;
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
            if (top && top.text !== original.text && top.count >= 2
                && (!runnerUp || top.count > runnerUp.count)
                && top.average >= OCR_CONSENSUS_MIN_CONFIDENCE
                && top.average >= comparison + OCR_CONSENSUS_CONFIDENCE_MARGIN) {
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
