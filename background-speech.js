// ===== 読み上げテキストの整形と分割 =====
//
// あらゆる読み上げ（選択テキスト・範囲読み上げ・OCR・キャプチャタブ）はここを通り、
// VOICEVOX へ渡す「1件ずつの合成単位」になる。多様な入力（記号・URL・日付・単位が混じる
// 文章、箇条書き・表、OCR特有の崩れ、句読点の無い長文、想定外の文字）でも、
// 途切れず・欠けず・不自然にならずに読み上げることが目的。
//
// 実エンジン（VOICEVOX 0.25、CPU合成）で確認した挙動:
// - 記号・絵文字・罫線（─ = * ・ … ★ ■ ◆ 等）は0モーラ＝無音。読まれないが害も無い。
// - 制御文字 U+0000 が混じると、その位置以降が合成から欠落する。
// - ゼロ幅スペース・BOM・ソフトハイフン・双方向制御・結合文字は「読点相当の長い間」になる。
// - 英単語は辞書読み（quick→クイック）で日本語と同程度の速さ。辞書に無い英字列・16進・
//   大文字略語は1文字ずつ読み（日本語の約2倍の時間）、数字列は数として読む（1桁あたり
//   日本語の3〜4倍の時間）。長さの上限は文字数ではなくこの「読み上げコスト」で決める。
// - 文中の「。」の間と、合成単位の切れ目（前後の無音0.1秒ずつ）はほぼ同じ長さ。
//   読点・空白で切っても、聞こえ方はほぼ変わらない。
// - 合成時間は音声長の約0.3倍（無負荷）〜0.7倍（負荷時）。合成は「再生中の分＋先読み分」
//   で進むため、1件の合成が「直前までの音声の残り時間」を超えると無音になる。
// - 句読点・空白（＝間）の無いまま続く部分でアクセント句が49を超えると audio_query が
//   500 を返す、または以降の読みが欠落する（句読点の無い和文276字、16進60字、
//   句読点の無い英文60語で失敗）。和文は上限120で1件に収めれば約40句以下。

// 1件の読み上げコスト上限。SOFT を超える文だけを区切りで分ける。区切りが何も無い塊は
// 上限で機械的に切る（上のエンジン制約のため、切らずに送る方が害が大きい）。
// 先頭の数件は小さくして、クリックから最初の音が出るまでを短くする
// （120コストの文は合成に4〜15秒かかる）。後続の合成は再生中に先読みで進む。
const SPEECH_SOFT_COST = 120;
const SPEECH_LEAD_COSTS = [40, 60, 90];
// offscreen-security.js の MAX_TEXT_ITEMS と揃える（超えると受理されない）。
const SPEECH_MAX_CHUNKS = 5000;
// 1件の文字数の上限。記号・空白の読み上げコストは0なので、コスト上限だけでは1件の
// 文字数が青天井になる（実測: 「あ」＋「=-」×20000 は splitText で1件40,001文字・
// コスト1）。audio_query はテキストをURLのクエリ文字列に載せるため、長すぎる1件は
// エンジンに拒否され、その1件だけが黙って音声から消える。罫線・アスキーアートを
// 含むOCR結果で到達しうるので、コストとは別に文字数でも切る。
// 通常の日本語はコスト120＝約120文字、英文でも約80文字なので、この値では切れない。
const SPEECH_MAX_CHUNK_CHARS = 600;

/**
 * 読み上げに使う文字列へ整形する（分割の前段）。
 * - 合成を欠落させる制御文字、無音なのに長い「間」を作る不可視文字を取り除く
 * - 同じ記号の3個以上の連続（罫線・点線リーダー・強調の＊＊＊）を1個にする
 *   （無音のまま URL 長だけを消費し、極端な場合はエンジンに拒否される）
 * - エンジンが読めない・不自然に読む表記を、読みが定まるものだけ置き換える
 *   （単位の合成文字、日付 2026/08/16、時刻 10:30 等）
 * @param {string} text
 * @returns {string}
 */
function sanitizeSpeechText(text) {
    if (!text) return "";
    let s = String(text);
    try { s = s.normalize("NFC"); } catch (error) { /* 環境依存の失敗は無視 */ }
    s = s.replace(/\r\n?/g, "\n").replace(/[\t\v\f]/g, " ")
        // 制御文字（改行以外）・書式文字（ゼロ幅・BOM・双方向制御・ソフトハイフン）・
        // 単独の結合文字・私用領域・不正なサロゲート・特殊用途文字
        .replace(/[\p{Cc}\p{Cf}\p{Mn}\p{Co}\p{Cs}\uFFF0-\uFFFF]/gu, (ch) => (ch === "\n" ? "\n" : ""))
        // 同じ記号の連続（文字・数字・空白以外）
        .replace(/([^\p{L}\p{N}\s])\1{2,}/gu, "$1")
        // 全角英数字は半角へ（読みは同じ。URL・日付・時刻・桁区切りの判定を効かせる）
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        // 「\12,800」は日本語フォントで円記号として表示される（OCR は \ と読む）
        .replace(/\\(?=\d)/g, "¥")
        // URL は読まない（content.js / ocr-common.js でも置換するが、OCR で「https:/」と
        // 崩れたもの、www. や「ドメイン/パス」で書かれたものはここで拾う。
        // 「example.com」のようなドメインだけの表記はそのまま読める）。
        // 英数字の塊への空白挿入より前に行う（URL の長いパスを壊さない）
        .replace(/https?:\/{1,2}[\w\/:%#$&?()~.=+\-]*/gi, "URL省略")
        .replace(/\bwww\.[\w\-]+(?:\.[\w\-]+)+[\w\/:%#$&?()~.=+\-]*/gi, "URL省略")
        .replace(/\b(?:[a-z0-9\-]+\.)+[a-z]{2,}\/[\w\/:%#$&?()~.=+\-]+/gi, "URL省略")
        // 長い英数字の塊（ハッシュ・base64・ID）は12文字ごとに空白で区切る。VOICEVOX は
        // 辞書に無い英字列を1文字1アクセント句として読み、間の無いアクセント句が49を超えると
        // audio_query が 500 になる／以降が欠落する（実測: 16進60字で 500、50字で欠落）。
        // 空白は間になり、1文字ずつ読む塊では聞こえ方も自然。24字以下の語（通常の英単語・
        // 型番）は触らない
        // 17桁以上の数字列は4桁ずつに（数として読むと途中で欠落し意味も無い）
        .replace(/(?<![\d,.])\d{17,}(?![\d,.])/g, (run) => run.replace(/\d{4}(?=\d)/g, "$& "))
        .replace(/(?=[0-9]*[A-Za-z])[A-Za-z0-9]{25,}/g, (run) => run.replace(/.{12}(?=.)/g, "$& "))
        // 単位・会社表記の合成文字（VOICEVOX は無音）
        .replace(/[㎡㎠㎢㎝㎜㎞㎏㎎㎖㍑㈱㈲№℡]/g, (ch) => SPEECH_COMPAT_CHARS[ch] || ch)
        // 無音になると意味が変わる記号（実測 VOICEVOX 0.25: いずれも0モーラ＝読まれない）。
        //   「誤差は±5です」→「ゴサワゴデス」（誤差の向きが消える）
        //   「約≒100個」→「ヤクヒャッコ」
        //   「受付は9時〜17時」→「クジ ジュウシチジ」（範囲が消えて2つの時刻に聞こえる）
        //   「角度は90°です」→「キュウジュウ」（単位が消える）
        // 逆に ×（カケル）÷（ワル）℃（ド）‰（パアミル）％（パアセント）は正しく読まれるので触らない。
        // ≦≧ は「10以下」と語順が入れ替わるため、単純な置換では直せない（据え置き）。
        .replace(/±/g, "プラスマイナス")
        .replace(/≒/g, "およそ")
        // 範囲の波ダッシュは数字に挟まれているときだけ「から」にする
        // （文末の「そうですね〜」のような用法を変えない）
        // 「9時〜17時」「5月〜8月」のように単位が1つ挟まる形もよくあるので許す
        .replace(/(?<=[0-9０-９][年月日時分秒%％円℃度]?)\s*[〜～]\s*(?=[0-9０-９])/g, "から")
        // 度は数字の直後に限る（「°」単独の飾りには触れない）
        .replace(/(?<=[0-9０-９])\s*°(?![CFｃｆ])/g, "度")
        // 金額 ¥12,800 → 12,800円（そのままだと「エン、イチマン…」と先に読まれる）
        .replace(/[¥￥]\s*(\d[\d,]*(?:\.\d+)?)/g, "$1円")
        // 日付 2026/08/16・2026-08-16（そのままだと「ゼロハチ、ジュウロク」と読まれる）
        .replace(/(?<!\d)(\d{4})[\/／\-](\d{1,2})[\/／\-](\d{1,2})(?![\d\/／\-])/g,
            (m, y, mo, d) => (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31)
                ? `${y}年${Number(mo)}月${Number(d)}日` : m)
        // 時刻 10:00 / 9:30（そのままだと「ジュウ、ゼロゼロ」と読まれる）
        .replace(/(?<![\d０-９:：])(\d{1,2})[:：](\d{2})(?![\d０-９:：])/g,
            (m, h, mi) => (Number(h) <= 24 && Number(mi) <= 59)
                ? `${Number(h)}時${Number(mi) === 0 ? "" : `${Number(mi)}分`}` : m);
    return s;
}

const SPEECH_COMPAT_CHARS = {
    "㎡": "平方メートル", "㎠": "平方センチメートル", "㎢": "平方キロメートル",
    "㎝": "センチメートル", "㎜": "ミリメートル", "㎞": "キロメートル",
    "㎏": "キログラム", "㎎": "ミリグラム", "㎖": "ミリリットル", "㍑": "リットル",
    "㈱": "株式会社", "㈲": "有限会社", "№": "ナンバー", "℡": "電話"
};

// 1文字あたりの読み上げコスト（実測の音声長比。日本語1文字≒1）。
function speechCharCost(ch) {
    if (/[0-9０-９]/.test(ch)) return 3;
    if (/[A-Za-zＡ-Ｚａ-ｚ]/.test(ch)) return 1.5;
    if (/[\p{L}\p{N}]/u.test(ch)) return 1;
    return 0;
}

function speechCost(str) {
    let cost = 0;
    for (const ch of str) cost += speechCharCost(ch);
    return cost;
}

// 読み上げ対象になる文字（文字・数字）を含むか。記号・空白だけの断片は無音になる。
const SPEECH_READABLE_RE = /[\p{L}\p{N}]/u;

// 分割してよい位置を、区切りの強い順に列挙する（すべて幅ゼロ＝文字を落とさない）。
//   0: 文末。。！？（直後の閉じ括弧・閉じ引用符まで含める）、改行、全角ピリオド（学術文書の
//      句点。小数点「３．５」、英字の前「example．com」、行頭の番号「１．項目」は除く）
//   1: 英文の文末（空白の前の . ! ?）と節（読点・セミコロン）。コロンは項目名と値を
//      結ぶ（「価格：12,800円」）ので切らない
//   2: 語（空白の直後）
//   3: 文字と記号の境（括弧・中黒・スラッシュ等の前後）
// 0 は無条件に切る（1文＝1件）。1 以降は上限を超える文だけに使う。
const SPEECH_CLOSERS = "」』）)\\]】〕〉》\"'’”";
const SPEECH_SPLIT_LEVELS = [
    new RegExp(`(?<=[。！？][${SPEECH_CLOSERS}]*)(?![。！？${SPEECH_CLOSERS}])|(?<=\\n)`
        + `|(?<=．)(?![0-9A-Za-z])(?<!^\\s*[0-9]{1,3}．)`, "um"),
    // 英文の文末: 略語（Mr. / e.g. / 頭文字 J.）の直後、数字の桁区切り「1,000」では切らない
    /(?<=[.!?])(?=\s)(?<!\b(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|St|No|vs|etc|Fig|Inc|Ltd|Co|Jr|Sr|e\.g|i\.e)\.)|(?<=[、，;；])|(?<=,)(?![0-9])/u,
    /(?<=\s)/u,
    // 記号の前後、および和文と英数字の境（「情報ですb3f9…」）
    /(?<=[^\p{L}\p{N}\s])(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])(?=[^\p{L}\p{N}\s])|(?<=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])(?=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])/u
];

/**
 * 1つの断片を、コスト上限以内の断片へ分ける。
 * 強い区切りから順に候補位置で切り、それでも上限を超える断片は次に弱い区切りへ進む。
 * 弱い区切りでも収まらない（記号も空白も無い長い塊）ときだけ上限で機械的に切る。
 * 分ける必要があるときは、上限いっぱいに詰めて端数を余らせるのではなく、
 * 件数を変えない範囲で各件の長さを揃える（「…across all major regions」＋「this year.」
 * のような不自然な切れ端を作らない）。
 * maxLevel を指定した場合はそれより弱い区切りは使わず、収まらない断片はそのまま返す。
 * @param {string} text
 * @param {number} limit
 * @param {number} level SPEECH_SPLIT_LEVELS の添字
 * @param {number} [maxLevel]
 * @returns {string[]}
 */
function splitByCost(text, limit, level, maxLevel = Infinity, balanced = true) {
    const total = speechCost(text);
    if (total <= limit) return [text];
    if (level > maxLevel) return [text];
    // 区切りが何も無い塊は上限で機械的に切る。語の途中で切ると読みが変わることがあるが、
    // 間の無い塊をそのまま送ると VOICEVOX 側で失敗する（実測: 句読点の無い276字で
    // audio_query が 500、アクセント句が49を超えると欠落）方が害が大きい。
    if (level >= SPEECH_SPLIT_LEVELS.length) return hardCutByCost(text, limit);
    const pieces = text.split(SPEECH_SPLIT_LEVELS[level]).filter((p) => p.length > 0);
    if (pieces.length <= 1) return splitByCost(text, limit, level + 1, maxLevel, balanced);
    // 残りを件数最小で均等に分けたときの1件の目安。詰めるたびに残りから計算し直す。
    const targetFor = (remaining) => (balanced
        ? Math.max(limit / 2, remaining / Math.ceil(remaining / limit)) : limit);
    const out = [];
    let buffer = "";
    let bufferCost = 0;
    let remaining = total;
    let target = targetFor(remaining);
    const flush = () => {
        if (buffer) out.push(buffer);
        remaining -= bufferCost;
        buffer = "";
        bufferCost = 0;
        target = targetFor(remaining);
    };
    for (const piece of pieces) {
        const cost = speechCost(piece);
        if (buffer && bufferCost + cost > target) flush();
        if (cost > limit) {
            // この断片単体で上限を超える → より弱い区切りで分ける
            flush();
            out.push(...splitByCost(piece, limit, level + 1, maxLevel, balanced));
            remaining -= cost;
            target = targetFor(remaining);
            continue;
        }
        buffer += piece;
        bufferCost += cost;
    }
    flush();
    return out;
}

function hardCutByCost(text, limit) {
    let remaining = speechCost(text);
    const targetFor = () => Math.max(limit / 2, remaining / Math.ceil(remaining / limit));
    const out = [];
    let buffer = "";
    let bufferCost = 0;
    let target = targetFor();
    for (const ch of text) {
        const cost = speechCharCost(ch);
        if (buffer && bufferCost + cost > target) {
            out.push(buffer);
            remaining -= bufferCost;
            buffer = "";
            bufferCost = 0;
            target = targetFor();
        }
        buffer += ch;
        bufferCost += cost;
    }
    if (buffer) out.push(buffer);
    return out;
}

/**
 * 読み上げテキストを VOICEVOX へ渡す合成単位の配列にする。
 *
 * 1. 整形（sanitizeSpeechText）
 * 2. 文末（。！？ 改行）で1文ずつに分ける。通常の長さの文はそのまま1件にする
 *    （読点等は VOICEVOX が自然な間として処理する）。
 * 3. 上限コストを超える文だけを、読点→空白→記号境界の順で上限以内に分ける。
 *    句点の無い長い箇条書き（メールの求人紹介等）が1件になると、その合成
 *    （実測: 約390字＝音声55秒に26秒）が直前の文の再生中に終わらず、文の間に
 *    20〜30秒の無音が空いた。読点単位なら1件の合成が数秒に収まり、先読みが追いつく。
 * 4. 文字・数字を含まない断片（罫線・区切り線・記号だけの行・「！！」の残り）は
 *    無音の合成要求になるだけなので落とす。
 * 5. 件数上限を超える分は読まず、その旨を最後に一言添える（黙って失敗しない）。
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitText(text) {
    const cleaned = sanitizeSpeechText(text);
    if (!cleaned.trim()) return [];

    const sentences = cleaned.split(SPEECH_SPLIT_LEVELS[0]);
    const result = [];
    const push = (piece) => {
        const chunk = piece.trim();
        if (!chunk || !SPEECH_READABLE_RE.test(chunk)) return;
        const chars = [...chunk];
        // コスト0の記号だけが続く塊は文字数で切る（SPEECH_MAX_CHUNK_CHARS のコメント参照）
        if (chars.length <= SPEECH_MAX_CHUNK_CHARS) { result.push(chunk); return; }
        for (let i = 0; i < chars.length; i += SPEECH_MAX_CHUNK_CHARS) {
            const part = chars.slice(i, i + SPEECH_MAX_CHUNK_CHARS).join("").trim();
            if (part && SPEECH_READABLE_RE.test(part)) result.push(part);
        }
    };
    for (const sentence of sentences) {
        let rest = sentence.trim();
        if (!rest || !SPEECH_READABLE_RE.test(rest)) continue;
        // 先頭の数件は、節の区切り（読点・英文の文末）で小さく切り出せるならそうする。
        // 節の区切りが無い文は無理に語の途中で切らず、通常の上限で扱う。
        // 切り出した先頭が上限の半分にも満たない（「新型センサー、」のような短い語句）
        // 場合もやめる: 直後の長い件の合成がその短い音声の再生中に終わらず、開始直後に
        // 途切れる方が、待ち時間より目立つ。
        while (rest && result.length < SPEECH_LEAD_COSTS.length) {
            const lead = SPEECH_LEAD_COSTS[result.length];
            const [head, ...tail] = splitByCost(rest, lead, 1, 1, false);
            const headCost = speechCost(head);
            if (headCost > lead || (tail.length > 0 && headCost < lead / 2)) break;
            push(head);
            rest = tail.join("");
        }
        if (rest) splitByCost(rest, SPEECH_SOFT_COST, 1).forEach(push);
        if (result.length >= SPEECH_MAX_CHUNKS) break;
    }
    if (result.length >= SPEECH_MAX_CHUNKS) {
        result.length = SPEECH_MAX_CHUNKS - 1;
        result.push("読み上げの上限に達したため、ここまでで終了します。");
    }
    return result;
}
