// 認識結果（Tesseract の blocks）の走査と精錬。
// 複数倍率の認識結果を文字単位で突き合わせる融合と、語彙辞書によるリランキング、
// および blocks からの読み上げテキスト組み立てを担当する。
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

// ===== 語彙辞書（リランキング用） =====
// SudachiDict(Apache-2.0) から抽出した高頻度の語（2-4字・漢字含む内容語）。
// 融合候補が「非語」か「辞書語」かの判定に使い、OCRの誤字で意味の通らない
// 熟語になった箇所を、複数倍率の認識結果の中の辞書語へ補正する（rerankOcrByDictionary）。
// 「任意」。取得に失敗しても従来動作を完全に保つ（機能を素通りさせる）。
let ocrWordSet = null;
let ocrDictionaryPromise = null;

// 拡張機能の同梱ファイルを一度だけ読み込む。offscreen/capture の拡張ページからは
// chrome.runtime.getURL で自分の同梱リソースを fetch できる（web_accessible_resources 不要）。
async function ensureOcrDictionaries() {
    if (ocrWordSet) return;
    if (ocrDictionaryPromise) return ocrDictionaryPromise;
    ocrDictionaryPromise = (async () => {
        try {
            if (typeof fetch === "undefined" || typeof chrome === "undefined"
                || !chrome.runtime || !chrome.runtime.getURL) return;
            const response = await fetch(chrome.runtime.getURL("ocr-words.txt"));
            if (!response.ok) throw new Error(`辞書の読み込みに失敗しました (${response.status})`);
            const declared = Number(response.headers?.get?.("content-length"));
            if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
                throw new Error("辞書ファイルが大きすぎます");
            }
            const wordsText = await response.text();
            if (wordsText.length > 2 * 1024 * 1024) throw new Error("辞書ファイルが大きすぎます");
            ocrWordSet = new Set(wordsText.split("\n").filter(Boolean));
        } catch (error) {
            // 辞書は任意機能。失敗しても以降は素通りする
            ocrWordSet = ocrWordSet || new Set();
        }
    })();
    return ocrDictionaryPromise;
}

// テスト用に辞書を直接注入する（Node ハーネスから利用）。
function setOcrDictionaries(wordSet) {
    if (wordSet) ocrWordSet = wordSet;
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
            for (const symbol of (word.symbols || [])) out.push({ symbol, word });
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

// 融合ゲート（18px）より大きい文字でも、辞書リランクだけは走らせる。そのときの
// 変換先の文字サイズ（Tesseract LSTM の最適域 20-30px を狙う）。
// 実測では一般的なWebページの文字は 22〜39px で、従来はどの補正も発火していなかった
// （24枚中5枚のみ発火）。融合と違い辞書リランクは「非辞書語」かつ「2つ以上の倍率が
// 同じ辞書語で一致」のときしか置換しないため、この領域でも安全側に働く
// （実測: 26枚で改善6・悪化0）。
const OCR_RERANK_TARGET_GLYPH_PX = [20, 24, 30];

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
 * 融合と辞書リランクで同じ整列を行っていたため共通化する。
 * @param {{symbol: object, word: object}[]} baseEntries
 * @param {object[][]} otherBlocksList
 * @returns {[number, object][][]} 倍率ごとの [baseIndex, symbol] の並び
 */
function alignOcrVariants(baseEntries, otherBlocksList) {
    const aligned = [];
    for (const otherBlocks of otherBlocksList) {
        const otherEntries = collectOcrSymbols(otherBlocks);
        if (!otherEntries.length) continue;
        aligned.push(alignOcrSymbols(baseEntries, otherEntries));
    }
    return aligned;
}

// 複数倍率の認識結果で元寸の文字を精錬する。判断の根拠は2つ。
// (1) 全会一致: すべての倍率が揃って「元寸とは違う同じ文字」を出した場合、そちらを採る。
//     元寸は高い確信度のまま誤ることがあり、確信度ではゲートできない
//     （実測: 誤った「バ」が確信度94、一方で全倍率が正しい「パ」を出していた。
//      濁点・半濁点の取り違えは読み上げで別語になるため影響が大きい）。
//     独立した複数倍率が全会一致した事実そのものを根拠にする。
//     実ページ24枚の実測で 改善13・悪化0。
// (2) 低確信度の漢字: 確信度の合計が上回る漢字へ置き換える（従来からの機能）。
// options.kanji / options.unanimous で対象を切り替える（既定は両方）。
// 置換した文字数を返す（0 なら呼び出し側は元のテキストをそのまま使う）。
function fuseOcrSymbols(baseBlocks, otherBlocksList, options = {}) {
    const useKanji = options.kanji !== false;
    const useUnanimous = options.unanimous !== false;
    const isKanji = (t) => OCR_KANJI_ONE_RE.test(t);
    const baseEntries = collectOcrSymbols(baseBlocks);
    if (!baseEntries.length) return 0;

    const candidates = new Map();
    for (const pairs of alignOcrVariants(baseEntries, otherBlocksList)) {
        for (const [index, symbol] of pairs) {
            if (!candidates.has(index)) candidates.set(index, []);
            candidates.get(index).push(symbol);
        }
    }

    const touchedWords = new Set();
    let replaced = 0;
    baseEntries.forEach((entry, index) => {
        const symbol = entry.symbol;
        const alts = candidates.get(index) || [];

        // (1) 全会一致による置換。確信度ではゲートしない（上のコメント参照）。
        if (useUnanimous && alts.length >= 2) {
            const first = alts[0].text;
            if (first !== symbol.text && alts.every((a) => a.text === first)) {
                symbol.text = first;
                touchedWords.add(entry.word);
                replaced++;
                return;
            }
        }

        // (2) 低確信度の漢字。同じ文字を出したバリアントの確信度を合計し、最大の文字を選ぶ。
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

// 語彙辞書によるリランキング。
// 融合の残存誤りは「非語」になることが多い（実測: 條恨は非語／悔恨は語）。しかも誤字が
// 高確信度（實測: 誤り「條」94）だと融合の確信度ゲートに掛からず救えない。そこで、
// 「元寸で非辞書語の漢字連続」を「複数の拡大版が揃って出す辞書語」へ置き換える。
// Tesseract の語分割は縦書きで1字ずつに割れることがある（実測）ため語境界には依存せず、
// 漢字連続の2-4字窓を辞書と照合する。安全のため:
// - base が既に辞書語なら触れない（正解の保護）
// - 各字が漢字で、2つ以上の拡大版が同一の辞書語で一致したときだけ置換（偶発誤りの排除）
// - 長い窓・支持の多い順に貪欲適用し、文字の重複置換を避ける
// 読みを捏造せず OCR 自身が出した候補から選ぶだけなので回帰リスクが低い
// （実測: 條恨→悔恨を修正し、ルビなしコーパスで悪化ゼロ・複数ケースでCER改善）。
function rerankOcrByDictionary(baseBlocks, otherBlocksList) {
    if (!ocrWordSet || !ocrWordSet.size) return 0;
    const isKanji = (t) => OCR_KANJI_ONE_RE.test(t);
    const baseEntries = collectOcrSymbols(baseBlocks);
    if (!baseEntries.length) return 0;

    // 各拡大版について base シンボルへの対応表（baseIndex→文字）を作る
    const variantMaps = [];
    for (const pairs of alignOcrVariants(baseEntries, otherBlocksList)) {
        const map = new Map();
        for (const [index, symbol] of pairs) {
            if (!map.has(index)) map.set(index, symbol.text);
        }
        variantMaps.push(map);
    }
    if (!variantMaps.length) return 0;

    const kanji = baseEntries.map((e) => isKanji(e.symbol.text));
    const candidates = [];
    let i = 0;
    while (i < baseEntries.length) {
        if (!kanji[i]) { i++; continue; }
        let j = i;
        while (j < baseEntries.length && kanji[j]) j++;
        // 漢字連続 [i, j) の中で 4→2字の窓を評価
        for (let len = Math.min(4, j - i); len >= 2; len--) {
            for (let start = i; start + len <= j; start++) {
                const baseStr = baseEntries.slice(start, start + len).map((e) => e.symbol.text).join("");
                if (ocrWordSet.has(baseStr)) continue; // 既に辞書語なら保護
                const votes = new Map();
                for (const map of variantMaps) {
                    let str = "";
                    let ok = true;
                    for (let k = 0; k < len; k++) {
                        const t = map.get(start + k);
                        if (!t || t.length !== 1 || !isKanji(t)) { ok = false; break; }
                        str += t;
                    }
                    if (ok) votes.set(str, (votes.get(str) || 0) + 1);
                }
                for (const [str, support] of votes) {
                    if (str !== baseStr && support >= 2 && ocrWordSet.has(str)) {
                        candidates.push({ start, len, str, support });
                    }
                }
            }
        }
        i = j;
    }
    // 長い窓・支持の多い順に貪欲適用（文字の重複を避ける）
    candidates.sort((a, b) => (b.len - a.len) || (b.support - a.support));
    const used = new Uint8Array(baseEntries.length);
    const touchedWords = new Set();
    let replaced = 0;
    for (const cand of candidates) {
        let free = true;
        for (let k = 0; k < cand.len; k++) if (used[cand.start + k]) { free = false; break; }
        if (!free) continue;
        for (let k = 0; k < cand.len; k++) {
            baseEntries[cand.start + k].symbol.text = cand.str[k];
            used[cand.start + k] = 1;
            touchedWords.add(baseEntries[cand.start + k].word);
        }
        replaced++;
    }
    rebuildOcrWordTexts(touchedWords);
    return replaced;
}

// OCRモデルが構造の近い漢字を全倍率で同じように誤る場合や、時間・面積の予算により
// 拡大再認識を行えない場合、上の多数決リランキングでは候補を得られず補正できない。
// 提示された実画像でも低解像度の元寸認識は「自巳主張」になり、そのままVOICEVOXへ
// 渡すと「ジミシュチョウ」と読まれることを確認した。
// そこで、字形がほぼ同じ文字だけを対象に、非辞書語から辞書語への置換が一意に決まる場合に
// 限って補正する。正しい珍しい語を一般語へ寄せないため、元が辞書語・候補が複数・一度に
// 2文字以上変わるケースはすべて触らない。
const OCR_VISUAL_CONFUSION_GROUPS = [
    ["己", "已", "巳"]
];
const OCR_VISUAL_CONFUSIONS = new Map();
for (const group of OCR_VISUAL_CONFUSION_GROUPS) {
    for (const char of group) OCR_VISUAL_CONFUSIONS.set(char, group.filter((other) => other !== char));
}

function correctOcrVisualConfusionsByDictionary(blocks) {
    if (!ocrWordSet || !ocrWordSet.size) return 0;
    const entries = collectOcrSymbols(blocks);
    if (!entries.length) return 0;
    const isKanji = (text) => OCR_KANJI_ONE_RE.test(text);
    const kanji = entries.map((entry) => isKanji(entry.symbol.text));
    const candidates = [];

    let i = 0;
    while (i < entries.length) {
        if (!kanji[i]) { i++; continue; }
        let j = i;
        while (j < entries.length && kanji[j]) j++;
        for (let len = Math.min(4, j - i); len >= 2; len--) {
            for (let start = i; start + len <= j; start++) {
                const chars = entries.slice(start, start + len).map((entry) => entry.symbol.text);
                const baseStr = chars.join("");
                if (ocrWordSet.has(baseStr)) continue;

                const replacements = new Set();
                for (let offset = 0; offset < chars.length; offset++) {
                    for (const replacement of (OCR_VISUAL_CONFUSIONS.get(chars[offset]) || [])) {
                        const changed = chars.slice();
                        changed[offset] = replacement;
                        const word = changed.join("");
                        if (ocrWordSet.has(word)) replacements.add(`${offset}\u0000${word}`);
                    }
                }
                // 一意性は「置換後の語」だけでなく位置も含めて判定する。同じ語を別位置の
                // 変更で作れる場合も、根拠が一つに定まらないため補正しない。
                if (replacements.size !== 1) continue;
                const [encoded] = replacements;
                const separator = encoded.indexOf("\u0000");
                candidates.push({
                    start,
                    len,
                    offset: Number(encoded.slice(0, separator)),
                    word: encoded.slice(separator + 1)
                });
            }
        }
        i = j;
    }

    // 長い語の根拠を優先し、重なる短い窓による二重補正を避ける。
    candidates.sort((a, b) => b.len - a.len);
    const used = new Uint8Array(entries.length);
    const touchedWords = new Set();
    let replaced = 0;
    for (const candidate of candidates) {
        let overlaps = false;
        for (let k = 0; k < candidate.len; k++) {
            if (used[candidate.start + k]) { overlaps = true; break; }
        }
        if (overlaps) continue;
        const index = candidate.start + candidate.offset;
        entries[index].symbol.text = candidate.word[candidate.offset];
        for (let k = 0; k < candidate.len; k++) used[candidate.start + k] = 1;
        touchedWords.add(entries[index].word);
        replaced++;
    }
    rebuildOcrWordTexts(touchedWords);
    return replaced;
}
