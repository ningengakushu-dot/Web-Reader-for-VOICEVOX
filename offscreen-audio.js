/**
 * 分割済みのテキストをまとめて合成待ちキューに追加し、合成プロセスを開始する。
 * 1文ずつ別メッセージで受け取ると、短い文では先頭の再生が終わった時点で
 * キューが空になり、まだ後続が残っているのに読み上げ終了として通知してしまう
 * （アイコンが途中で待機状態に戻る）。必ず全文をまとめて積む。
 */
function enqueueTexts(texts, settings) {
    if (!Array.isArray(texts) || texts.length === 0) return;
    for (const text of texts) {
        textQueue.push({ text, settings });
    }
    processSynthesis();
}

// エンジンが特定の文だけを HTTP エラーで拒否したとき、その文を捨てる前に何回まで
// 半分に割って試すか（1文が最大8片になる）。
// エンジンは1回の要求のアクセント句が49を超えると 500 を返し（実測:
// tools/reading-corpus-check.mjs）、従来はその文が音声から黙って消え、前後の文が
// つながって聞こえていた＝利用者から見た「読み飛ばし」。分割して出し直せば読める。
const MAX_SYNTHESIS_SPLIT_DEPTH = 3;
// これより短い文は、長さが原因ではないので割らずに従来どおり諦める。
const MIN_SYNTHESIS_SPLIT_CHARS = 8;
// 続けてこの回数だけ文の合成に失敗したら、残りのキューを捨てて通知を打ち切る。
// 話者IDが今のエンジンに存在しない（VOICEVOXの入れ替え・キャラ構成の変更）、同じポートを
// 別のプロセスが使っている、といった原因はどの文でも同じように失敗するため、続けても
// 利用者は無音のまま待たされ、文の数だけエラー表示が上書きされ続けるだけになる。
// 1〜2件なら「その文だけ読めなかった」可能性があるので続行する。
const MAX_CONSECUTIVE_SYNTHESIS_FAILURES = 3;
let consecutiveSynthesisFailures = 0;

/**
 * 合成に失敗した文を2つに割る。句読点・閉じ括弧の直後のうち中央にいちばん近い位置で
 * 切り、区切りが無ければ中央で切る。割れないときは null。
 * @param {string} text
 * @returns {[string, string] | null}
 */
function splitSynthesisText(text) {
    const chars = [...(text || "")];
    if (chars.length < MIN_SYNTHESIS_SPLIT_CHARS) return null;
    const middle = Math.floor(chars.length / 2);
    let cut = -1;
    for (let i = 1; i < chars.length; i++) {
        if (!/[。．！？!?、，,」』）)]/.test(chars[i - 1])) continue;
        if (cut < 0 || Math.abs(i - middle) < Math.abs(cut - middle)) cut = i;
    }
    if (cut <= 0 || cut >= chars.length) cut = middle;
    const head = chars.slice(0, cut).join("").trim();
    const tail = chars.slice(cut).join("").trim();
    if (!head || !tail) return null;
    return [head, tail];
}

/**
 * 合成待ちキューを処理し、音声を生成する
 */
function readyAudioSeconds() {
    return audioQueue.reduce((sum, item) => sum + (item.durationSec || 0), 0);
}

async function processSynthesis() {
    if (isSynthesizing || textQueue.length === 0
        || audioQueue.length >= MAX_READY_AUDIO_QUEUE
        || readyAudioSeconds() >= MAX_READY_AUDIO_SECONDS) return;

    isSynthesizing = true;
    const item = textQueue.shift();
    // この合成が属する世代を記録。完了時に世代が進んでいれば stale とみなす。
    const generation = synthesisGeneration;

    try {
        const { url: blobUrl, durationSec } = await generateVoiceBlob(item.text, item.settings);
        // 合成中に stopAll() が走った場合、生成済み Blob を破棄して状態を触らない
        if (generation !== synthesisGeneration) {
            URL.revokeObjectURL(blobUrl);
            return;
        }
        consecutiveSynthesisFailures = 0;
        audioQueue.push({ url: blobUrl, text: item.text, durationSec });
        processPlayback();
    } catch (err) {
        // stale な世代のエラーは通知も状態変更もしない
        if (generation !== synthesisGeneration) return;
        console.error("Offscreen: 合成失敗:", err);
        // エンジンが特定の文だけ拒否した場合（HTTP エラー）は、その文を捨てる前に
        // 半分に割って積み直す（MAX_SYNTHESIS_SPLIT_DEPTH のコメント参照）。
        // 割れるあいだは通知しない: まだ文は失われていない。
        const splitDepth = item.splitDepth || 0;
        // 割った断片が結局どれも読めなかった場合でも、通知は元の1文につき1回に保つ
        // （最大8片ぶんのエラー表示を出さない）。
        const notice = item.notice || { notified: false };
        if (isVoicevoxRetryableError(err) && splitDepth < MAX_SYNTHESIS_SPLIT_DEPTH) {
            const parts = splitSynthesisText(item.text);
            if (parts) {
                textQueue.unshift(
                    { text: parts[0], settings: item.settings, splitDepth: splitDepth + 1, notice },
                    { text: parts[1], settings: item.settings, splitDepth: splitDepth + 1, notice });
                return;
            }
        }
        if (notice.notified && !isVoicevoxUnreachableError(err)) return;
        notice.notified = true;
        consecutiveSynthesisFailures++;
        // エンジンに届かない・応答が無い失敗では残りの文を合成しない。続けても文の数だけ
        // 同じ失敗と PLAYBACK_ERROR 通知（＝タブのエラー表示・SW起動）を繰り返すだけになる。
        // 到達はできるが毎回同じ理由で拒否される場合も同じなので、連続失敗が続いたら諦める。
        // 割っても駄目だった文はここで諦め、次の文へ進む（既に合成済みの音声は再生を終える）。
        if (isVoicevoxUnreachableError(err)
            || consecutiveSynthesisFailures >= MAX_CONSECUTIVE_SYNTHESIS_FAILURES) {
            textQueue = [];
        }
        // 利用者へ見せる文言を持つエラー（HTTPステータス・応答形式）はそのまま伝える。
        // 内部由来の英語メッセージだけ「合成失敗:」を付けて区別できるようにする。
        notifyBackground("PLAYBACK_ERROR",
            { error: err?.userFacing ? err.message : `合成失敗: ${err.message}` });
    } finally {
        // 現在の世代のみが合成フラグの解除と次処理の継続を行える。
        // stale な世代では stopAll() が既に状態をリセット済みのため何もしない。
        if (generation === synthesisGeneration) {
            isSynthesizing = false;
            processSynthesis();
        }
    }
}

// 文を割って読み直す価値のある失敗か。エンジンは1要求のアクセント句が49を超えると
// 500 を返すので、5xx のときだけ割り直す意味がある。404/422（話者がこのエンジンに無い等）や
// 応答形式の異常はどう割っても同じ結果で、1文あたり最大15回の無駄な要求になるだけ。
function isVoicevoxRetryableError(err) {
    const status = Number(err?.httpStatus);
    return Number.isFinite(status) && status >= 500 && status < 600;
}

// エンジンに接続できない／応答が無い種類の失敗か（fetch の TypeError・タイムアウト）。
// HTTP ステータス由来の失敗（Query失敗(500) 等）は含めない。
function isVoicevoxUnreachableError(err) {
    const message = String(err?.message || "");
    return (err && err.name === "TypeError")
        || /Failed to fetch|NetworkError|ERR_CONNECTION|応答しません/i.test(message);
}

/**
 * audio_query の結果から音声の長さ（秒）を見積もる。先読み量の制御にだけ使うので
 * 厳密でなくてよい（モーラと休止の長さの合計を話速で割る）。
 */
function estimateQueryDurationSec(query, speedScale) {
    let seconds = (Number(query.prePhonemeLength) || 0) + (Number(query.postPhonemeLength) || 0);
    const phrases = Array.isArray(query.accent_phrases) ? query.accent_phrases : [];
    for (const phrase of phrases) {
        const moras = Array.isArray(phrase?.moras) ? phrase.moras : [];
        for (const mora of moras) {
            seconds += (Number(mora?.consonant_length) || 0) + (Number(mora?.vowel_length) || 0);
        }
        seconds += Number(phrase?.pause_mora?.vowel_length) || 0;
    }
    const speed = Number(speedScale) > 0 ? Number(speedScale) : 1;
    return seconds / speed;
}

/**
 * VOICEVOX が非2xxを返したときのエラー。HTTPステータスを err.httpStatus に残し、
 * 「割って読み直すか」の判断をメッセージの文字列一致に頼らずに行えるようにする。
 * userFacing を立てた文言はそのまま利用者へ表示される。
 */
function voicevoxHttpError(status) {
    const message = status >= 500
        ? `VOICEVOXエンジンがこの文を処理できませんでした（応答コード${status}）`
        : `VOICEVOXエンジンが要求を受け付けませんでした（応答コード${status}）。`
            + "オプション画面で話者を選び直すと直ることがあります";
    const error = new Error(message);
    error.httpStatus = status;
    error.userFacing = true;
    return error;
}

/**
 * VOICEVOX ではない応答（JSONでない・音声合成用クエリの形をしていない）に対するエラー。
 */
function voicevoxUnexpectedResponseError() {
    const error = new Error(
        "VOICEVOXエンジンから予期しない応答が返りました。"
        + "ポート50021を別のアプリが使っていないか確認してください");
    error.userFacing = true;
    return error;
}

// ===== 括弧が作る不自然な間を取り除く =====
//
// 括弧そのものは読まれないが、開き・閉じの両方が「間」を作り、直後の助詞を別の
// アクセント句へ切り離す。実測（VOICEVOX 0.25.2 / 話者1）:
//   彼は「はい」と答えた。  カレワ、ハイ、ト/コタエタ  無音0.94秒・全体3.27秒
//   括弧を外すと            カレワ/ハイト/コタエタ     無音0秒・全体1.92秒
//
// ただし括弧を外すと、隣り合う語がつながって読みが変わることがある。文字の並びからは
// 判別できない（実測: 「彼は「ええ」と言った」を外すと助詞の「は」が吸収されて
// カレ/ハエエト になる。「ABC（株）」はカブシキガイシャがカブになる。
// 「9月1日（月）」はゲツヨオビがツイタチビになる）。
// そこで**エンジン自身に両方の読みを尋ね、モーラ列が変わらないときだけ外す**。
// 読点・アクセント句の切れ目はモーラに現れないので、比較は「間が減ったかどうか」に
// 影響されない。audio_query は実測13ミリ秒で、合成に比べて無視できる。
const OFFSCREEN_BRACKET_RE = /[「」『』（）()｢｣〈〉《》【】〔〕]/g;
// 閉じと開きが隣り合う所（「はい」「いいえ」）は、外すと2つの引用が地続きになる。
// モーラ列は変わらないためエンジンには区別できないので、読点1つを残す。
const OFFSCREEN_BRACKET_JUNCTION_RE = /[」』）)｣〉》】〕]\s*[「『（(｢〈《【〔]/g;

/**
 * 括弧を外した読み上げ用の候補を作る。外すものが無ければ null。
 * @param {string} text
 * @returns {string|null}
 */
function bracketFreeCandidate(text) {
    if (!OFFSCREEN_BRACKET_RE.test(text)) {
        OFFSCREEN_BRACKET_RE.lastIndex = 0;
        return null;
    }
    OFFSCREEN_BRACKET_RE.lastIndex = 0;
    const candidate = text
        .replace(OFFSCREEN_BRACKET_JUNCTION_RE, "、")
        .replace(OFFSCREEN_BRACKET_RE, "");
    return candidate && candidate !== text ? candidate : null;
}

/**
 * 読みの並び（モーラ）だけを取り出す。間・アクセントの違いは無視される。
 * @param {object} query
 * @returns {string}
 */
function queryMoraSignature(query) {
    let signature = "";
    const phrases = Array.isArray(query?.accent_phrases) ? query.accent_phrases : [];
    for (const phrase of phrases) {
        const moras = Array.isArray(phrase?.moras) ? phrase.moras : [];
        for (const mora of moras) signature += String(mora?.text || "");
    }
    return signature;
}

/**
 * 括弧を外しても読みが変わらないなら、外したほうのクエリを使う。
 * 判定できない・取得に失敗したときは元のクエリをそのまま返す（読みを壊さない側に倒す）。
 * @param {string} text
 * @param {number} speaker
 * @param {object} queryJson 元のテキストのクエリ
 * @returns {Promise<object>}
 */
async function preferBracketFreeQuery(text, speaker, queryJson) {
    const candidate = bracketFreeCandidate(text);
    if (!candidate) return queryJson;
    let candidateQuery;
    try {
        candidateQuery = await requestAudioQuery(candidate, speaker);
    } catch (error) {
        return queryJson;
    }
    return queryMoraSignature(candidateQuery) === queryMoraSignature(queryJson)
        ? candidateQuery : queryJson;
}

/**
 * 音声合成用クエリを1件取得する。
 * @param {string} text
 * @param {number} speaker
 * @returns {Promise<object>}
 */
async function requestAudioQuery(text, speaker) {
    const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`;
    const queryResponse = await fetchWithTimeout(
        queryUrl, { method: "POST" }, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!queryResponse.ok) throw voicevoxHttpError(queryResponse.status);

    let queryJson;
    try {
        queryJson = await readJsonResponseWithLimit(queryResponse);
    } catch (error) {
        // 本文がJSONでない（同じポートを別のプロセスが使っている、エラーページが返る等）。
        // ここで置き換えないと JSON.parse の英語の内部メッセージがそのまま通知へ出る。
        // realm をまたいで投げられるので instanceof ではなく name で判定する。
        if (error?.name === "SyntaxError") throw voicevoxUnexpectedResponseError();
        throw error;
    }
    // 応答の形を確かめてから書き込む。null や配列以外が返ったとき、この後の代入が
    // TypeError になり「Cannot set properties of null」がそのまま利用者へ出ていた。
    if (!queryJson || typeof queryJson !== "object" || !Array.isArray(queryJson.accent_phrases)) {
        throw voicevoxUnexpectedResponseError();
    }
    return queryJson;
}

/**
 * VOICEVOX APIを使用して音声を合成し、Blob URL と音声長の見積もりを返す。
 * 制限時間つきの fetch（fetchWithTimeout）は constants.js で定義している。
 * @returns {Promise<{url: string, durationSec: number}>}
 */
async function generateVoiceBlob(text, settings) {
    const { speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLengthScale } = settings;
    // speaker はURLに載るため数値に正規化する（不正値が紛れてもURLを壊さない）
    const speaker = Number(speakerId);

    let queryJson = await requestAudioQuery(text, speaker);
    queryJson = await preferBracketFreeQuery(text, speaker, queryJson);

    queryJson.prePhonemeLength = 0.1 * speedScale;
    queryJson.postPhonemeLength = 0.1 * speedScale;
    queryJson.speedScale = speedScale;
    queryJson.pitchScale = pitchScale;
    queryJson.intonationScale = intonationScale;
    queryJson.volumeScale = volumeScale;
    queryJson.pauseLengthScale = pauseLengthScale;

    const synthUrl = `${VOICEVOX_BASE_URL}/synthesis?speaker=${speaker}`;
    const synthResponse = await fetchWithTimeout(synthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queryJson)
    }, VOICEVOX_SYNTHESIS_TIMEOUT_MS);
    if (!synthResponse.ok) throw voicevoxHttpError(synthResponse.status);

    const audioBlob = await readBlobResponseWithLimit(synthResponse);
    return {
        url: URL.createObjectURL(audioBlob),
        durationSec: estimateQueryDurationSec(queryJson, speedScale)
    };
}

/**
 * 再生待ちキューを処理する
 */
async function processPlayback() {
    if (isPlaying || audioQueue.length === 0) return;

    isPlaying = true;
    notifyBackground("PLAYBACK_STARTED");
    const generation = playbackGeneration;

    const current = audioQueue.shift();
    // 完成済みキューに空きができたので、再生と並行して次の1件だけを合成する。
    // processSynthesis 側の上限判定により、それより先の文はテキストのまま待機する。
    processSynthesis();
    const audio = new Audio(current.url);
    currentAudio = audio;
    currentAudioUrl = current.url;

    let isCleanedUp = false;

    const cleanup = (completedNormally) => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(current.url);
        if (currentAudioUrl === current.url) currentAudioUrl = null;
        audio.removeAttribute('src');
        audio.load();

        if (currentAudio === audio) currentAudio = null;
        isPlaying = false;

        if (completedNormally && audioQueue.length === 0 && textQueue.length === 0 && !isSynthesizing) {
            notifyBackground("PLAYBACK_ENDED");
        }

        processPlayback();
    };

    audio.onended = () => cleanup(true);
    audio.onerror = (e) => {
        const errorInfo = audio.error
            ? `Code: ${audio.error.code}, Message: ${audio.error.message}`
            : "Details unavailable";
        console.error(`Offscreen: Audioエラー [${errorInfo}]`, e);
        notifyBackground("PLAYBACK_ERROR", { error: errorInfo });
        cleanup(false);
    };

    try {
        await audio.play();
    } catch (err) {
        if (generation !== playbackGeneration) return;
        console.error("Offscreen: play()失敗:", err.name, err.message);
        notifyBackground("PLAYBACK_ERROR", { error: `${err.name}: ${err.message}` });
        cleanup(false);
    }
}

function stopAll() {
    // 何も動いていないときの停止（読み上げ開始前の STOP_AUDIO・二度目の停止）では
    // PLAYBACK_STOPPED を通知しない。開始直前に「停止」が届くと capture.html の
    // 表示が「停止しました」→「再生中」と往復し、タブのアイコンも一瞬点滅する。
    const wasActive = isPlaying || isSynthesizing || textQueue.length > 0 || audioQueue.length > 0
        || currentAudio != null;
    // in-flight の合成を無効化（完了しても破棄させる）
    synthesisGeneration++;
    // 連続失敗の数え上げは1回の読み上げの中だけで意味を持つ。エンジンを起動し直して
    // やり直したときに、前回の失敗数のせいで1文目で打ち切られないようにする。
    consecutiveSynthesisFailures = 0;
    // in-flight の再生開始処理を無効化（停止後の AbortError 等を通知しない）
    playbackGeneration++;

    if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
        currentAudio = null;
    }
    if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
    }

    textQueue = [];
    audioQueue.forEach(item => URL.revokeObjectURL(item.url));
    audioQueue = [];

    isSynthesizing = false;
    isPlaying = false;

    if (wasActive) notifyBackground("PLAYBACK_STOPPED");
}

function notifyBackground(type, payload = {}) {
    // background 側は応答を返さない通知なので、応答チャネルが閉じたことによる
    // 拒否は無視する（放置すると未処理の Promise 拒否でコンソールが埋まる）。
    chrome.runtime.sendMessage({ type, target: 'background', ...payload }).catch(() => {});
}
