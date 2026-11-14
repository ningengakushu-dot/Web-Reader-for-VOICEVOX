/**
 * 分割済みのテキストをまとめて合成待ちキューに追加し、合成プロセスを開始する。
 * 1文ずつ別メッセージで受け取ると、短い文では先頭の再生が終わった時点で
 * キューが空になり、まだ後続が残っているのに読み上げ終了として通知してしまう
 * （アイコンが途中で待機状態に戻る）。必ず全文をまとめて積む。
 */
function enqueueTexts(texts, settings) {
    if (!Array.isArray(texts) || texts.length === 0) return;
    // 連続する文章のストリーミング切替は無音区間の実機検証が未完了。
    // 音切れ対策が確立している従来の先読み経路を複数文では優先する。
    const playbackSettings = texts.length > 1
        ? { ...settings, synthesisMode: "normal" } : settings;
    for (const text of texts) {
        textQueue.push({ text, settings: playbackSettings });
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
const STREAMING_PREPARATION_CANCEL_WAIT_MS = 1200;
// 近い音声長は WAV ヘッダーで確かめる。モーラ長の合計と実 WAV には丸め等の差がある。
const STREAMING_DURATION_MARGIN_SECONDS = 0.5;
let consecutiveSynthesisFailures = 0;

function safeErrorMessage(error) {
    try {
        if (error == null) return String(error);
        const message = error.message;
        if (typeof message === "string" && message) return message;
        return String(error);
    } catch (ignored) {
        return "詳細不明のエラー";
    }
}

function waitForStreamingPreparation(preparation) {
    if (!preparation) return Promise.resolve();
    let timer;
    const settled = Promise.resolve(preparation.promise).then(() => undefined, () => undefined);
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
            "ストリーミング準備通信の終了を確認できませんでした")),
        STREAMING_PREPARATION_CANCEL_WAIT_MS);
    });
    return Promise.race([settled, deadline]).catch(error => {
        throw globalThis.VVRadioStreaming?.lockCleanup?.(error) || error;
    }).finally(() => clearTimeout(timer));
}

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

function audioClockMs() {
    return globalThis.performance?.now?.() ?? Date.now();
}

function trackNormalRequest(request) {
    // ENGINE の /synthesis は接続を切っても演算を継続する。停止の表示はすぐ返し、
    // 次の音声要求だけを旧通信の完了または既存のタイムアウトまで待たせる。
    const release = () => {
        if (pendingNormalRequest === done) pendingNormalRequest = null;
    };
    const done = request.then(release, release);
    pendingNormalRequest = done;
    return request;
}

// 文の文字数ではなく、エンジンが返したモーラ長で先の合成負荷を予測する。
// 短文が複数続いてから長文が来る場合も見る必要があるので、次の1件だけにはしない。
// WAVとは別の上限で軽いクエリを先読みする。音声が短い場合、WAVの件数上限で
// クエリも打ち切ると、その先にある長い合成を開始前に発見できない。
async function prepareSynthesisWindow(item, generation) {
    let seconds = readyAudioSeconds();
    let count = audioQueue.length;
    // 再生より少し速いだけのエンジンほど蓄積が遅いので、より遠くまで調べる。
    // 45〜450秒相当、かつ1024件で上限を固定し、全文分を無制限には保持しない。
    const headroom = Math.max(0.1, 1 - synthesisSecondsPerAudioSecond * 1.2);
    const lookaheadSeconds = MAX_READY_AUDIO_SECONDS / headroom;
    for (let index = -1; index < textQueue.length; index++) {
        if (index >= 0 && (count >= MAX_QUERY_LOOKAHEAD_ITEMS || seconds >= lookaheadSeconds)) break;
        const pending = index < 0 ? item : textQueue[index];
        if (!pending.query && !pending.queryError) {
            try {
                const query = await trackNormalRequest(prepareVoiceQuery(pending.text, pending.settings));
                if (generation !== synthesisGeneration) return false;
                pending.query = query;
                pending.durationSec = estimateQueryDurationSec(query, pending.settings.speedScale);
            } catch (error) {
                if (generation !== synthesisGeneration) return false;
                // null/undefined の拒否も、先読み済みの失敗としてキューに残す。
                pending.queryError = error || new Error(safeErrorMessage(error));
            }
        }
        // 失敗は元の合成キューの順番で処理し、分割再試行とエラー通知の契約を保つ。
        // 到達不能のまま後続全件に同じ要求を出さない。
        if (pending.queryError) break;
        seconds += pending.durationSec;
        count++;
    }
    return generation === synthesisGeneration;
}

function requiredPlaybackBufferSeconds() {
    // 直近の合成実測に20%の余裕を持たせる。実測値は各合成で更新するので、
    // エンジン起動時の一時的な遅さを以降ずっと引きずらない。
    const rate = synthesisSecondsPerAudioSecond * 1.2;
    let synthesisSeconds = 0;
    let precedingAudioSeconds = 0;
    let required = 0;
    const add = (durationSec, elapsed = 0) => {
        synthesisSeconds += Math.max(0, durationSec * rate - elapsed);
        required = Math.max(required, synthesisSeconds - precedingAudioSeconds);
        precedingAudioSeconds += durationSec;
    };
    if (activeSynthesis?.durationSec != null) {
        add(activeSynthesis.durationSec, Math.max(0, audioClockMs() - activeSynthesis.startedAt) / 1000);
    }
    for (const pending of textQueue) {
        if (!pending.query || pending.queryError) break;
        add(pending.durationSec);
    }
    return required > 0 ? required + 0.1 : 0;
}

function clearPlaybackBufferTimer() {
    if (playbackBufferTimer !== null) clearTimeout(playbackBufferTimer);
    playbackBufferTimer = null;
}

async function processSynthesis() {
    if (isSynthesizing || currentStreamingPlayer || audioQueue.some(item => item.streaming)
        || textQueue.length === 0
        || audioQueue.length >= MAX_READY_AUDIO_QUEUE
        || readyAudioSeconds() >= MAX_READY_AUDIO_SECONDS) return;

    isSynthesizing = true;
    const item = textQueue.shift();
    // この合成が属する世代を記録。完了時に世代が進んでいれば stale とみなす。
    const generation = synthesisGeneration;
    activeSynthesis = { durationSec: null, startedAt: null };

    try {
        if (pendingNormalRequest) await pendingNormalRequest;
        if (generation !== synthesisGeneration) return;
        let streamingQuery = null;
        // 機能照会とクエリ取得も再生準備の一部として扱い、STOP_AUDIOから同じ要求単位の
        // AbortSignalを渡す。準備段階で止められた旧要求が次の再生と重ならないよう記録する。
        if (!item.forceNormal && item.settings.synthesisMode === "auto"
            && globalThis.VVRadioStreaming) {
            const preparation = { controller: new AbortController(), promise: null };
            const signal = preparation.controller.signal;
            preparation.promise = (async () => {
                const supported = await globalThis.VVRadioStreaming.supports(
                    item.settings.speakerId, false, { signal });
                if (!supported) return null;
                return item.query || await prepareVoiceQuery(item.text, item.settings, signal);
            })();
            activeStreamingPreparation = preparation;
            try {
                streamingQuery = await preparation.promise;
            } finally {
                if (activeStreamingPreparation === preparation) activeStreamingPreparation = null;
            }
        }
        if (generation !== synthesisGeneration) return;
        if (streamingQuery) {
            const durationSec = estimateQueryDurationSec(streamingQuery, item.settings.speedScale);
            const longAudio = durationSec > globalThis.VVRadioStreaming.bufferSecondsLimit + STREAMING_DURATION_MARGIN_SECONDS;
            if (!longAudio) {
                audioQueue.push({ streaming: true, query: streamingQuery, settings: item.settings,
                    text: item.text, durationSec, splitDepth: item.splitDepth || 0, notice: item.notice });
                activeSynthesis = null;
                processPlayback();
                return;
            }
            item.query = streamingQuery;
            item.durationSec = durationSec;
        }
        if (!await prepareSynthesisWindow(item, generation)) return;
        if (item.queryError) throw item.queryError;
        activeSynthesis = { durationSec: item.durationSec, startedAt: audioClockMs() };
        processPlayback();
        if (generation !== synthesisGeneration) return;
        const audio = generateVoiceBlob(item.text, item.settings, item.query);
        const { url: blobUrl, durationSec } = await trackNormalRequest(audio);
        // 合成中に stopAll() が走った場合、生成済み Blob を破棄して状態を触らない
        if (generation !== synthesisGeneration) {
            URL.revokeObjectURL(blobUrl);
            return;
        }
        const elapsedSec = Math.max(0, audioClockMs() - activeSynthesis.startedAt) / 1000;
        if (durationSec > 0) synthesisSecondsPerAudioSecond = elapsedSec / durationSec;
        activeSynthesis = null;
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
        const notice = item.notice || { error: null };
        if (isVoicevoxRetryableError(err) && splitDepth < MAX_SYNTHESIS_SPLIT_DEPTH) {
            const parts = splitSynthesisText(item.text);
            if (parts) {
                textQueue.unshift(
                    { text: parts[0], settings: item.settings, forceNormal: item.forceNormal, splitDepth: splitDepth + 1, notice },
                    { text: parts[1], settings: item.settings, forceNormal: item.forceNormal, splitDepth: splitDepth + 1, notice });
                return;
            }
        }
        const unreachable = isVoicevoxUnreachableError(err);
        const alreadyReported = notice.error !== null && !unreachable;
        if (!alreadyReported) {
            consecutiveSynthesisFailures++;
            // ENGINE に届かない場合や連続して失敗する場合は、残りの文を諦める。
            // 既に合成済みの音声は再生を終える。
            if (unreachable) globalThis.VVRadioStreaming?.invalidate?.();
            if (unreachable || consecutiveSynthesisFailures >= MAX_CONSECUTIVE_SYNTHESIS_FAILURES) {
                textQueue = [];
            }
            // HTTP ステータスなど、利用者向けの文言を持つエラーはそのまま伝える。
            const message = safeErrorMessage(err);
            notice.error = err?.userFacing ? message : `合成失敗: ${message}`;
        }
        const terminal = !isPlaying && audioQueue.length === 0 && textQueue.length === 0;
        // 理由の再表示を抑える場合も、キューが空になった時点で SW に要求終了を伝える。
        if (!alreadyReported || terminal) {
            notifyBackground("PLAYBACK_ERROR", { error: notice.error, terminal, alreadyReported });
        }
    } finally {
        // 現在の世代のみが合成フラグの解除と次処理の継続を行える。
        // stale な世代では stopAll() が既に状態をリセット済みのため何もしない。
        if (generation === synthesisGeneration) {
            activeSynthesis = null;
            isSynthesizing = false;
            processSynthesis();
            processPlayback();
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
 * audio_query の結果から音声の長さ（秒）を見積もる。先読み量と再生開始の判断に使い、
 * 話速・休止設定を含める。フレーム丸めの差は再生開始の余裕で吸収する。
 */
function estimateQueryDurationSec(query, speedScale) {
    let seconds = (Number(query.prePhonemeLength) || 0) + (Number(query.postPhonemeLength) || 0);
    const phrases = Array.isArray(query.accent_phrases) ? query.accent_phrases : [];
    for (const phrase of phrases) {
        const moras = Array.isArray(phrase?.moras) ? phrase.moras : [];
        for (const mora of moras) {
            seconds += (Number(mora?.consonant_length) || 0) + (Number(mora?.vowel_length) || 0);
        }
        if (phrase?.pause_mora) {
            const pause = query.pauseLength == null
                ? (Number(phrase.pause_mora.vowel_length) || 0) : Number(query.pauseLength);
            const scale = Number.isFinite(Number(query.pauseLengthScale)) ? Number(query.pauseLengthScale) : 1;
            seconds += pause * scale;
        }
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
// そこで**エンジン自身に両方の読みを尋ね、音素列と語の切れ目が変わらないときだけ外す**。
// 間（pause_mora）と句の結合は比較に含めない。それを減らすことが目的だから。
// audio_query は実測13ミリ秒で、合成に比べて無視できる。
const OFFSCREEN_BRACKET_RE = /[「」『』（）()｢｣〈〉《》【】〔〕]/g;
// 閉じと開きが隣り合う所（「はい」「いいえ」）は、外すと2つの引用が地続きになる。
// 音素列は変わらないためエンジンには区別できないので、読点1つを残す。
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
 * 読みを比べるための情報を取り出す。
 * - phonemes: 子音＋母音の並び。カナだけの比較では拾えない無声化（「す」の u → U）まで見る。
 * - boundaries: アクセント句の切れ目（先頭からのモーラ数）。語のまとまりが変わったかを見る。
 * 間（pause_mora）と句の長さそのものは含めない。間が減ることが目的だから。
 * @param {object} query
 * @returns {{phonemes: string, boundaries: number[]}}
 */
function queryReadingSignature(query) {
    const phonemes = [];
    const boundaries = [];
    const phrases = Array.isArray(query?.accent_phrases) ? query.accent_phrases : [];
    let count = 0;
    for (const phrase of phrases) {
        const moras = Array.isArray(phrase?.moras) ? phrase.moras : [];
        for (const mora of moras) {
            phonemes.push(String(mora?.consonant || "") + String(mora?.vowel || mora?.text || ""));
            count += 1;
        }
        boundaries.push(count);
    }
    return { phonemes: phonemes.join(" "), boundaries };
}

/**
 * 括弧を外した読みが、元の読みと同じと言えるか。
 * 許すのは「アクセント句がつながること」だけ。これが括弧を外す目的そのもので、
 * 直後の助詞が元の句へ戻る（カレワ、ハイ、ト → カレワ/ハイト）。
 * 逆に**新しい切れ目が生まれた**場合は、語のまとまりが変わっている。
 * 実測: 「ここで」「はきもの」を脱ぐ。→ ハキモノ が ハキ/モノオ に割れる。
 * 音素まで一致していても、これは読みが変わったものとして退ける。
 * @param {object} candidateQuery
 * @param {object} originalQuery
 * @returns {boolean}
 */
function isSameReading(candidateQuery, originalQuery) {
    const candidate = queryReadingSignature(candidateQuery);
    const original = queryReadingSignature(originalQuery);
    if (candidate.phonemes !== original.phonemes) return false;
    const originalBoundaries = new Set(original.boundaries);
    return candidate.boundaries.every((at) => originalBoundaries.has(at));
}

/**
 * 括弧を外しても読みが変わらないなら、外したほうのクエリを使う。
 * 判定できない・取得に失敗したときは元のクエリをそのまま返す（読みを壊さない側に倒す）。
 * @param {string} text
 * @param {number} speaker
 * @param {object} queryJson 元のテキストのクエリ
 * @returns {Promise<object>}
 */
async function preferBracketFreeQuery(text, speaker, queryJson, signal = null) {
    const candidate = bracketFreeCandidate(text);
    if (!candidate) return queryJson;
    let candidateQuery;
    try {
        candidateQuery = await requestAudioQuery(candidate, speaker, signal);
    } catch (error) {
        if (signal?.aborted) throw error;
        return queryJson;
    }
    return isSameReading(candidateQuery, queryJson) ? candidateQuery : queryJson;
}

/**
 * 音声合成用クエリを1件取得する。
 * @param {string} text
 * @param {number} speaker
 * @returns {Promise<object>}
 */
async function parseAudioQueryResponse(queryResponse) {
    let queryJson;
    try {
        queryJson = await readJsonResponseWithLimit(queryResponse);
    } catch (error) {
        if (error?.name === "SyntaxError") throw voicevoxUnexpectedResponseError();
        throw error;
    }
    if (!queryJson || typeof queryJson !== "object" || !Array.isArray(queryJson.accent_phrases)) {
        throw voicevoxUnexpectedResponseError();
    }
    return queryJson;
}

async function requestAudioQuery(text, speaker, signal = null) {
    const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`;
    let queryResponse;
    if (signal) {
        if (signal.aborted) throw new Error("音声クエリ取得が中断されました");
        const controller = new AbortController();
        let timedOut = false;
        const abortFromRequest = () => controller.abort();
        signal.addEventListener("abort", abortFromRequest, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, VOICEVOX_FETCH_TIMEOUT_MS);
        try {
            queryResponse = await fetch(queryUrl, { method: "POST", signal: controller.signal });
            if (!queryResponse.ok) throw voicevoxHttpError(queryResponse.status);
            return await parseAudioQueryResponse(queryResponse);
        } catch (error) {
            if (signal.aborted) throw error;
            if (timedOut && error?.name === "AbortError") {
                throw new Error(`VOICEVOXエンジンが応答しません（${Math.round(VOICEVOX_FETCH_TIMEOUT_MS / 1000)}秒）`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abortFromRequest);
            controller.abort();
        }
    }
    queryResponse = await fetchWithTimeout(queryUrl, { method: "POST" }, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!queryResponse.ok) throw voicevoxHttpError(queryResponse.status);

    return parseAudioQueryResponse(queryResponse);
}

/**
 * 読みが変わらない場合だけ括弧の間を除き、先読み・合成で共有するクエリを用意する。
 * 制限時間つきの fetch（fetchWithTimeout）は constants.js で定義している。
 * @returns {Promise<object>}
 */
async function prepareVoiceQuery(text, settings, signal = null) {
    const { speakerId, speedScale, pitchScale, intonationScale, volumeScale, pauseLengthScale } = settings;
    // speaker はURLに載るため数値に正規化する（不正値が紛れてもURLを壊さない）
    const speaker = Number(speakerId);

    let queryJson = await requestAudioQuery(text, speaker, signal);
    queryJson = await preferBracketFreeQuery(text, speaker, queryJson, signal);

    queryJson.prePhonemeLength = 0.1 * speedScale;
    queryJson.postPhonemeLength = 0.1 * speedScale;
    queryJson.speedScale = speedScale;
    queryJson.pitchScale = pitchScale;
    queryJson.intonationScale = intonationScale;
    queryJson.volumeScale = volumeScale;
    queryJson.pauseLengthScale = pauseLengthScale;
    return queryJson;
}

/**
 * 検証済みのクエリを合成する。先読み済みなら同じクエリを再取得しない。
 * @returns {Promise<{url: string, durationSec: number}>}
 */
async function generateVoiceBlob(text, settings, preparedQuery = null) {
    const queryJson = preparedQuery || await prepareVoiceQuery(text, settings);
    const speaker = Number(settings.speakerId);

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
        durationSec: estimateQueryDurationSec(queryJson, settings.speedScale)
    };
}

/**
 * 再生待ちキューを処理する
 */
async function processPlayback(continuePlayback = false) {
    if (isPlaying || audioQueue.length === 0) return;
    if (audioQueue[0].streaming) {
        clearPlaybackBufferTimer();
        const item = audioQueue.shift();
        const generation = playbackGeneration;
        isPlaying = true;
        const player = globalThis.VVRadioStreaming.createPlayer(
            item.query, Number(item.settings.speakerId), () => {
                if (generation === playbackGeneration) notifyBackground("PLAYBACK_STARTED");
            });
        currentStreamingPlayer = player;
        let completed = false;
        try {
            await player.run();
            completed = true; // readerの終了だけではなく最後のAudioBufferの再生完了まで待つ
        } catch (error) {
            if (generation !== playbackGeneration) return;
            const canFallback = player.canFallback === true;
            if (!canFallback || !player.exceedsBufferLimit) {
                globalThis.VVRadioStreaming.suppress(item.settings.speakerId);
            }
            if (canFallback) {
                // 未予約、または開始前の予約取消し・Context解放が完了した場合のみ再試行。
                textQueue.unshift({ text: item.text, settings: item.settings,
                    forceNormal: true, query: item.query, durationSec: item.durationSec,
                    splitDepth: item.splitDepth, notice: item.notice });
            } else {
                // 再生済み音声を先頭から二重に再生しない。途中復旧は安全性未検証。
                textQueue = [];
                for (const ready of audioQueue) if (ready.url) URL.revokeObjectURL(ready.url);
                audioQueue = [];
                console.error("Offscreen: ストリーミング再生失敗:", error);
                notifyBackground("PLAYBACK_ERROR",
                    { error: "ストリーミング再生を中断しました: " + safeErrorMessage(error), terminal: true });
            }
        } finally {
            // stop()失敗はrun()側のcatchで利用者へ通知済み。finallyから二次例外を
            // 発生させると再生キューの終了処理を妨げるため、ここでは再送しない。
            await player.stop().catch(() => {});
            if (generation === playbackGeneration) {
                currentStreamingPlayer = null;
                isPlaying = false;
                if (completed && textQueue.length === 0 && audioQueue.length === 0
                    && !isSynthesizing) notifyBackground("PLAYBACK_ENDED");
                // テストモックや旧拡張との境界で状態APIが存在しない場合は通常経路を維持。
                // 実プレイヤーの終了失敗時はfailedとなり、後続の音声を開始しない。
                if ((globalThis.VVRadioStreaming.cleanupStatus?.() || "ready") === "ready") {
                    processSynthesis();
                    processPlayback(true);
                }
            }
        }
        return;
    }

    clearPlaybackBufferTimer();
    processSynthesis();
    const atBufferLimit = audioQueue.length >= MAX_READY_AUDIO_QUEUE
        || readyAudioSeconds() >= MAX_READY_AUDIO_SECONDS;
    if (!continuePlayback && !atBufferLimit && activeSynthesis?.durationSec === null) return;
    // 未準備の次クエリがある間は負荷を判定できない。準備完了・失敗時に再評価される。
    if (!continuePlayback && !atBufferLimit && !activeSynthesis && textQueue[0]
        && !textQueue[0].query && !textQueue[0].queryError) return;
    const waitSeconds = requiredPlaybackBufferSeconds() - readyAudioSeconds();
    if (!continuePlayback && !atBufferLimit && waitSeconds > 0.001) {
        const generation = playbackGeneration;
        // 合成完了時にも再評価する。長い合成の途中でも残り時間がバッファ内に収まれば
        // 開始でき、全文合成の完了まで待たせない。
        playbackBufferTimer = setTimeout(() => {
            playbackBufferTimer = null;
            if (generation === playbackGeneration) processPlayback();
        }, Math.max(1, waitSeconds * 1000));
        return;
    }

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

        // 既に完成している音声はそのまま続ける。予測の更新を理由に途中へ間を挿入しない。
        // 実際にバッファが空になった場合だけ、再開時に必要量を再び確保する。
        processPlayback(completedNormally && audioQueue.length > 0);
    };

    const reportPlaybackError = (message, error) => {
        if (generation !== playbackGeneration || isCleanedUp) return;
        try {
            console.error("Offscreen: Audioエラー:", error);
            notifyBackground("PLAYBACK_ERROR", { error: message,
                terminal: !isSynthesizing && audioQueue.length === 0 && textQueue.length === 0 });
        } finally {
            cleanup(false);
        }
    };

    audio.onended = () => cleanup(true);
    audio.onerror = (e) => {
        const errorInfo = audio.error
            ? `Code: ${audio.error.code}, Message: ${safeErrorMessage(audio.error)}`
            : "Details unavailable";
        reportPlaybackError(errorInfo, e);
    };

    try {
        await audio.play();
    } catch (err) {
        reportPlaybackError(safeErrorMessage(err), err);
    }
}

async function stopAll() {
    // 停止結果は STOP_AUDIO の応答だけで返す。SW が対象要求へ結果を通知する。
    playbackRequestId = undefined;
    // in-flight の合成を無効化（完了しても破棄させる）
    synthesisGeneration++;
    clearPlaybackBufferTimer();
    activeSynthesis = null;
    synthesisSecondsPerAudioSecond = 0.7;
    // 連続失敗の数え上げは1回の読み上げの中だけで意味を持つ。エンジンを起動し直して
    // やり直したときに、前回の失敗数のせいで1文目で打ち切られないようにする。
    consecutiveSynthesisFailures = 0;
    // in-flight の再生開始処理を無効化（停止後の AbortError 等を通知しない）
    playbackGeneration++;
    const stoppingPlayer = currentStreamingPlayer;
    const playerCleanup = stoppingPlayer ? stoppingPlayer.stop() : Promise.resolve();
    const stoppingPreparation = activeStreamingPreparation;
    let preparationAbortError = null;
    if (stoppingPreparation) {
        try {
            stoppingPreparation.controller.abort();
        } catch (error) {
            preparationAbortError = error;
        }
    }
    const preparationCleanup = waitForStreamingPreparation(stoppingPreparation).then(() => {
        if (preparationAbortError) {
            throw globalThis.VVRadioStreaming?.lockCleanup?.(preparationAbortError)
                || preparationAbortError;
        }
    });
    currentStreamingPlayer = null;

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
    audioQueue.forEach(item => { if (item.url) URL.revokeObjectURL(item.url); });
    audioQueue = [];

    isSynthesizing = false;
    isPlaying = false;

    // 先行stop()がまだ完了していれば、それも含めて待つ。
    // これにより背景側の STOP_AUDIO → ENQUEUE_TEXTS は後始末完了順になる。
    return Promise.allSettled([playerCleanup, preparationCleanup])
        .then(results => {
            const failed = results.find(result => result.status === "rejected");
            if (failed) throw failed.reason;
        })
        .then(() => globalThis.VVRadioStreaming?.waitForCleanup?.());
}

function notifyBackground(type, payload = {}) {
    // background 側は応答を返さない通知なので、応答チャネルが閉じたことによる
    // 拒否は無視する（放置すると未処理の Promise 拒否でコンソールが埋まる）。
    const message = { type, target: 'background', ...payload };
    if (type.startsWith("PLAYBACK_")) message.requestId = playbackRequestId;
    if (type === "PLAYBACK_ENDED" || payload.terminal === true) playbackRequestId = undefined;
    chrome.runtime.sendMessage(message).catch(() => {});
}
