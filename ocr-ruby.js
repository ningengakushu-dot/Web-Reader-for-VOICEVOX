// ルビ（ふりがな）優先読み。
// ルビは「その漢字を作者の意図どおりに読ませる」ために振られるので、読み上げでは
// 漢字の一般的な読みではなくルビの読みが正解になる。そこで、ルビが振られた漢字は
// ルビの文字列に差し替え、漢字自体は読み上げない（例:「鯨幕」→「くじらまく」）。
// ルビを信頼できる形で読み取れなかった場合は、そのルビを捨てて漢字のまま読む
// （＝従来のルビ除去と同じ挙動）。縦書きではルビ列が本文列の右側にあり Tesseract は
// 右の列から出力するため、ここで処理しないとルビだけが先に読み上げられてしまう。
//
// 依存: ocr-image.js（cropOcrCanvas）/ ocr-refine.js（forEachOcrLine・漢字判定・段落境界）

const OCR_RUBY_SIZE_RATIO = 0.6;   // 本文サイズのこの割合未満の行をルビ候補とする
const OCR_RUBY_MIN_KEEP_RATIO = 0.3; // 残存文字がこれ未満なら誤検出とみなし中止
// ルビ列は極端に小さく（実測8px幅）、そのままでは Tesseract の最適域20-30pxを
// 大きく下回って化ける（実測: つぶて→「っtet」、くじらまく→「くじにらまく」）。
// ルビ列だけを切り出してこのサイズまで拡大し直すと正読できる
// （実測: 同じ列が x1「つよはてくじらまく」→ x4「つぶてくじらまく」で完全一致）。
const OCR_RUBY_TARGET_GLYPH_PX = 28;
const OCR_RUBY_RESCAN_MIN_SCALE = 2;
const OCR_RUBY_RESCAN_MAX_SCALE = 8;
const OCR_RUBY_RESCAN_MAX_AREA = 4000000; // 再認識画像の面積上限（処理時間の保護）
const OCR_RUBY_MAX_RESCAN_LINES = 16;     // 1回のOCRで再認識するルビ列数の上限
// ルビ列の中で、本文1文字のこの割合を超える空きがあれば別の親文字のルビとみなす
const OCR_RUBY_GROUP_GAP_RATIO = 0.6;
// 親文字がルビ群と重なっているとみなす割合（親文字1字の長さに対する比）
const OCR_RUBY_OVERLAP_RATIO = 0.35;
// 親文字1字あたりのルビ長の上限。これを超える対応付けは誤りとみなして差し替えない
const OCR_RUBY_MAX_KANA_PER_KANJI = 4;

// ルビとして採用してよい文字（かな・長音・繰り返し記号のみ）。
// 化けたルビ（ラテン文字混じり等）を本文に差し込まないための門番。
const OCR_RUBY_TEXT_RE = /^[ぁ-ゖァ-ヺーゝゞヽヾ]+$/;

/**
 * blocks から行の一覧を取り出す。
 * サイズは必ず「行の bbox」から測る。単語単位の bbox は縦書きで信用できず、
 * 実測ではルビ行（実際の行幅8px）の単語幅が 8,8,8,6,22,22,22,22 と乱れ、その
 * 中央値22が本文（17px）より大きくなってルビ判定が完全に外れていた。
 * @param {object[]} blocks
 * @param {"vertical"|"horizontal"} orientation
 */
function collectOcrLines(blocks, orientation) {
    const lines = [];
    forEachOcrLine(blocks, (line) => {
        const words = (line.words || []).filter((w) => (w.text || "").trim());
        if (!words.length) return;
        const text = words.map((w) => w.text).join(" ").trim();
        lines.push({
            text,
            // 文字位置は等間隔で見積もるため、空白を除いた文字列で数える
            chars: Array.from(text.replace(/\s+/g, "")),
            bbox: line.bbox,
            size: orientation === "vertical"
                ? line.bbox.x1 - line.bbox.x0
                : line.bbox.y1 - line.bbox.y0,
            hasKanji: OCR_KANJI_RE.test(text),
            subs: []
        });
    });
    return lines;
}

// 本文サイズ = 行代表サイズの文字数重み付き中央値。
// ルビ行は短いため、文字数で重み付けすると本文サイズに引き寄せられにくい。
// サイズ情報が乏しい場合は null（判定せず生テキストにフォールバックさせる）。
function estimateOcrBodySize(lines) {
    const weighted = [];
    for (const line of lines) {
        if (line.size > 0) {
            for (let i = 0; i < line.chars.length; i++) weighted.push(line.size);
        }
    }
    if (weighted.length < 4) return null;
    weighted.sort((a, b) => a - b);
    return weighted[Math.floor(weighted.length / 2)];
}

// ルビ行の判定条件は次の2つ:
// (1) 行の bbox サイズ（縦書き=幅／横書き=高さ）が本文サイズより十分小さい
// (2) 行に漢字を含まない（ルビは かな。漢字を含む小さい行＝傍注等は残す）
// かつては「すべて かな」を要求していたが、ルビがOCRで化けると条件を外れて
// 除去できなかったため「漢字を含まない」に緩めた。サイズ判定が幾何的で
// 信頼できるため、これで足りる。
function isOcrRubyLine(line, bodySize) {
    return !line.hasKanji && line.size > 0 && line.size < bodySize * OCR_RUBY_SIZE_RATIO;
}

// 拡大再認識したルビ列から「親文字ごとのルビ群」を切り出す。
// 群の区切りは語 bbox の主軸方向の空きだけで決める（ルビ列内の語の並び順は
// そのまま読み順なので、順序は Tesseract の出力に従う）。語 bbox は入れ子に
// なることがある（実測: 「くじ」が群全体を覆い、その中に「ら」「ま」「く」）ため、
// 群の範囲は和集合として広げる。
// offset/scale は切り出し画像の座標を元の canvas 座標へ戻すための値。
function extractOcrRubyGroups(blocks, orientation, offset, scale, bodySize) {
    const words = [];
    forEachOcrLine(blocks, (line) => {
        for (const word of (line.words || [])) {
            const text = (word.text || "").replace(/\s+/g, "");
            if (!text) continue;
            const bbox = word.bbox;
            const [a, b] = orientation === "vertical"
                ? [bbox.y0, bbox.y1]
                : [bbox.x0, bbox.x1];
            words.push({ text, start: offset + a / scale, end: offset + b / scale });
        }
    });
    const maxGap = bodySize * OCR_RUBY_GROUP_GAP_RATIO;
    const groups = [];
    let current = null;
    for (const word of words) {
        if (current && word.start - current.end > maxGap) {
            groups.push(current);
            current = null;
        }
        if (!current) current = { text: "", start: word.start, end: word.end };
        current.text += word.text;
        current.start = Math.min(current.start, word.start);
        current.end = Math.max(current.end, word.end);
    }
    if (current) groups.push(current);
    return groups;
}

// ルビ行の親（本文）行を探す。縦書きではルビは親文字の右側、横書きでは上側に
// 置かれるため、それぞれ「左隣」「下」で主軸方向に重なる本文行を選ぶ。
function findOcrRubyParent(ruby, bodyLines, orientation, bodySize) {
    let best = null;
    let bestDistance = Infinity;
    for (const line of bodyLines) {
        let distance;
        let overlap;
        if (orientation === "vertical") {
            distance = ruby.bbox.x0 - line.bbox.x1;
            overlap = Math.min(line.bbox.y1, ruby.bbox.y1) - Math.max(line.bbox.y0, ruby.bbox.y0);
        } else {
            distance = line.bbox.y0 - ruby.bbox.y1;
            overlap = Math.min(line.bbox.x1, ruby.bbox.x1) - Math.max(line.bbox.x0, ruby.bbox.x0);
        }
        // わずかな食い込みは許すが、離れすぎているものは親とみなさない
        if (distance < -bodySize || distance > bodySize * 1.5) continue;
        if (overlap <= 0) continue;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = line;
        }
    }
    return best;
}

// ルビ群を親行の漢字に対応付けて差し替え予約を積む。
// 日本語の縦組み・横組みは全角等幅なので、親行の主軸方向の長さを文字数で等分すると
// 各文字の位置を精度よく見積もれる（記号単位の bbox は縦書きで x が 0-0 になるなど
// 完全に壊れており使えない。実測で確認済み）。
// 見積もった窓の中から「最もルビ群と重なる漢字の連続」を親文字として選ぶ。
function planOcrRubySubstitution(parent, group, orientation) {
    const [p0, p1] = orientation === "vertical"
        ? [parent.bbox.y0, parent.bbox.y1]
        : [parent.bbox.x0, parent.bbox.x1];
    const n = parent.chars.length;
    if (n === 0 || !(p1 > p0)) return false;
    if (!OCR_RUBY_TEXT_RE.test(group.text)) return false;

    const unit = (p1 - p0) / n;
    const overlapOf = (i) => {
        const s = p0 + i * unit;
        return Math.min(s + unit, group.end) - Math.max(s, group.start);
    };

    // ルビ群と十分重なる文字の窓を求め、その中の漢字の連続を親文字候補にする
    let bestStart = -1;
    let bestLength = 0;
    let bestScore = 0;
    let runStart = -1;
    let runScore = 0;
    for (let i = 0; i <= n; i++) {
        const inWindow = i < n
            && overlapOf(i) > unit * OCR_RUBY_OVERLAP_RATIO
            && OCR_KANJI_RE.test(parent.chars[i]);
        if (inWindow) {
            if (runStart < 0) { runStart = i; runScore = 0; }
            runScore += overlapOf(i);
        } else if (runStart >= 0) {
            if (runScore > bestScore) {
                bestScore = runScore;
                bestStart = runStart;
                bestLength = i - runStart;
            }
            runStart = -1;
        }
    }
    if (bestStart < 0) return false;
    // ルビが親文字数に対して不自然に長い対応付けは誤りとみなす
    if (group.text.length > bestLength * OCR_RUBY_MAX_KANA_PER_KANJI) return false;

    parent.subs.push({ start: bestStart, length: bestLength, text: group.text });
    return true;
}

// 予約した差し替えを行テキストに反映する（後ろから適用して添字のずれを防ぐ）
function applyOcrRubySubstitutions(line) {
    if (!line.subs.length) return line.text;
    const chars = line.chars.slice();
    const subs = line.subs.slice().sort((a, b) => b.start - a.start);
    let limit = chars.length;
    for (const sub of subs) {
        if (sub.start + sub.length > limit) continue; // 重複した対応付けは捨てる
        chars.splice(sub.start, sub.length, sub.text);
        limit = sub.start;
    }
    return chars.join("");
}

// ルビ列を切り出して拡大し、認識し直してルビ群を得る
async function rescanOcrRubyLine(ruby, orientation, canvas, worker, output, bodySize) {
    if (!(ruby.size > 0)) return [];
    let scale = Math.round(OCR_RUBY_TARGET_GLYPH_PX / ruby.size);
    scale = Math.max(OCR_RUBY_RESCAN_MIN_SCALE, Math.min(OCR_RUBY_RESCAN_MAX_SCALE, scale));

    // 主軸方向は広めに、直交方向は隣の本文列を巻き込まないよう狭めに余白を取る
    const along = Math.max(2, Math.round(ruby.size));
    const cross = Math.max(2, Math.round(ruby.size * 0.4));
    const [mx, my] = orientation === "vertical" ? [cross, along] : [along, cross];
    const x = Math.max(0, Math.floor(ruby.bbox.x0 - mx));
    const y = Math.max(0, Math.floor(ruby.bbox.y0 - my));
    const width = Math.min(canvas.width, Math.ceil(ruby.bbox.x1 + mx)) - x;
    const height = Math.min(canvas.height, Math.ceil(ruby.bbox.y1 + my)) - y;
    while (scale > OCR_RUBY_RESCAN_MIN_SCALE
        && width * scale * height * scale > OCR_RUBY_RESCAN_MAX_AREA) scale--;
    if (width * scale * height * scale > OCR_RUBY_RESCAN_MAX_AREA) return [];

    const cropped = cropOcrCanvas(canvas, x, y, width, height, scale);
    if (!cropped) return [];
    const rescanned = await worker.recognize(cropped, {}, output);
    const offset = orientation === "vertical" ? y : x;
    return extractOcrRubyGroups(rescanned.data.blocks, orientation, offset, scale, bodySize);
}

/**
 * ルビを親文字に差し替えたテキストを返す。
 * ルビが見つからない場合や、除去しすぎ（本文の大半が消える）・情報不足の場合は
 * null を返し、呼び出し側で生テキストにフォールバックさせる
 * （誤検出による本文欠落を防ぐ安全弁）。
 *
 * @param {object[]} blocks 認識結果の blocks
 * @param {"vertical"|"horizontal"} orientation
 * @param {HTMLCanvasElement} canvas blocks と同じ座標系の画像
 * @param {{recognize: Function}} worker ルビ列の再認識に使うワーカー
 * @param {object} output tesseract の出力指定
 * @returns {Promise<string|null>}
 */
async function applyRubyReadings(blocks, orientation, canvas, worker, output) {
    const lines = collectOcrLines(blocks, orientation);
    const bodySize = estimateOcrBodySize(lines);
    if (bodySize == null) return null;

    const rubyLines = [];
    const bodyLines = [];
    for (const line of lines) {
        (isOcrRubyLine(line, bodySize) ? rubyLines : bodyLines).push(line);
    }
    // ルビが無ければ何もしない（ルビの無いページで挙動を変えないため）
    if (!rubyLines.length || !bodyLines.length) return null;

    const rescanCount = Math.min(rubyLines.length, OCR_RUBY_MAX_RESCAN_LINES);
    for (let i = 0; i < rescanCount; i++) {
        const ruby = rubyLines[i];
        const parent = findOcrRubyParent(ruby, bodyLines, orientation, bodySize);
        if (!parent) continue;
        let groups;
        try {
            groups = await rescanOcrRubyLine(ruby, orientation, canvas, worker, output, bodySize);
        } catch (error) {
            // 再認識に失敗しても、ルビ行を落とすだけの従来動作は成立させる
            continue;
        }
        for (const group of groups) planOcrRubySubstitution(parent, group, orientation);
    }

    let totalChars = 0;
    let keptChars = 0;
    const kept = [];
    for (const line of lines) {
        totalChars += line.chars.length;
        // ルビ行は落とす（差し替えできたルビは親行に入っている）
        if (isOcrRubyLine(line, bodySize)) continue;
        keptChars += line.chars.length;
        const text = applyOcrRubySubstitutions(line);
        if (text) kept.push({ text, bbox: line.bbox });
    }
    if (totalChars === 0 || keptChars < totalChars * OCR_RUBY_MIN_KEEP_RATIO) return null;
    // ルビ経路でも同じ規則で段落境界を入れる（本文行だけで判定する）
    return markOcrParagraphBreaks(kept, orientation, bodySize).join("\n");
}
