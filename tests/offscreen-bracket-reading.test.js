// 括弧が作る不自然な間を取り除く判定（offscreen.js）の検査。
//
// 括弧は読まれないが、開き・閉じの両方が「間」を作り、直後の助詞を別のアクセント句へ
// 切り離す。外してよいかは文字の並びからは決められない（実測: 「彼は「ええ」と言った」を
// 外すと助詞の「は」が吸収されて カレ/ハエエト になる）。そのためエンジンに両方の読みを
// 尋ね、音素列と語の切れ目が変わらないときだけ外す。
//
// 疑似エンジンの応答は実エンジンと同じ形（consonant / vowel / accent / pause_mora）で作る。
// カナだけを持つ応答では、無声化（ス su → sU）の退行を検出できないため。
// 読みの値は実エンジン（speaker 1）で測った結果をそのまま写している。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8')
    + '\n;globalThis.__test = { bracketFreeCandidate, queryReadingSignature, isSameReading,'
    + ' preferBracketFreeQuery, generateVoiceBlob };';

// カナ→音素。実エンジンの音素名に合わせる（ン=N、促音=cl）。
const KANA = {
    ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
    カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
    サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
    タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
    ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
    ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
    マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
    ヤ: 'ya', ユ: 'yu', ヨ: 'yo', ラ: 'ra', リ: 'ri',
    ル: 'ru', レ: 're', ロ: 'ro', ワ: 'wa',
    ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
    ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
    ダ: 'da', デ: 'de', ド: 'do',
    バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
    ャ: 'ya', ュ: 'yu', ョ: 'yo', ッ: 'cl', ン: 'N'
};

// 読みの記法: 「、」=間を伴う句切れ、「/」=間のない句切れ、カナの後ろの「^」=無声化。
function mora(kana, devoiced) {
    const romaji = KANA[kana] || kana;
    const vowel = /[aiueo]$/.test(romaji) ? romaji.slice(-1) : romaji;
    const consonant = /[aiueo]$/.test(romaji) ? romaji.slice(0, -1) : '';
    return {
        text: kana,
        consonant: consonant || null,
        consonant_length: consonant ? 0.05 : null,
        vowel: devoiced ? vowel.toUpperCase() : vowel,
        vowel_length: 0.1,
        pitch: 5.5
    };
}

// テキストごとの読みを決める疑似エンジン。未登録のテキストは文字をそのまま1モーラにする。
const READINGS = new Map();
let audioQueryCalls = [];
let synthesisBodies = [];
let failOnTexts = new Set();

function makeQuery(text) {
    const spec = READINGS.has(text) ? READINGS.get(text) : [...text].join('');
    const phrases = [];
    let current = [];
    const push = (pause) => {
        phrases.push({ moras: current, accent: Math.max(1, current.length), pause_mora: pause });
        current = [];
    };
    const chars = [...spec];
    for (let i = 0; i < chars.length; i += 1) {
        const ch = chars[i];
        if (ch === '、') { push({ text: 'pau', vowel: 'pau', vowel_length: 0.3 }); continue; }
        if (ch === '/') { push(null); continue; }
        const devoiced = chars[i + 1] === '^';
        if (devoiced) i += 1;
        current.push(mora(ch, devoiced));
    }
    push(null);
    return { accent_phrases: phrases, kana: spec, __text: text };
}

const context = vm.createContext({
    console: { ...console, error() {} },
    chrome: { runtime: { id: 'ext-id', onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } },
    Audio: class {}, setTimeout, clearTimeout, setImmediate, Promise,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 100,
    VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100, OCR_WORKER_IDLE_RELEASE_MS: 1000,
    OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (url, options) => {
        if (!String(url).includes('/audio_query')) {
            synthesisBodies.push(JSON.parse(options.body));
            return { ok: true };
        }
        const text = decodeURIComponent(String(url).split('&text=')[1] || '');
        audioQueryCalls.push(text);
        if (failOnTexts.has(text)) return { ok: false, status: 500 };
        return { ok: true, __text: text };
    },
    readJsonResponseWithLimit: async (response) => makeQuery(response.__text),
    readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    createPrimaryOcrProgressTracker: () => ({ reset() {}, update: () => null }),
    recognizeWithOrientation: async () => ({ text: '', confidence: 0 }),
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 1, height: 1 }),
    fetch: async () => ({ blob: async () => ({}) })
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
const {
    bracketFreeCandidate, queryReadingSignature, isSameReading,
    preferBracketFreeQuery, generateVoiceBlob
} = context.__test;

const SETTINGS = {
    speakerId: 1, speedScale: 1, pitchScale: 0,
    intonationScale: 1, volumeScale: 1, pauseLengthScale: 1
};

// 判定を「元／括弧なし」の読みの組で確かめる小道具。
async function decide(text, originalSpec, candidateSpec) {
    READINGS.set(text, originalSpec);
    READINGS.set(bracketFreeCandidate(text), candidateSpec);
    const original = makeQuery(text);
    const chosen = await preferBracketFreeQuery(text, 1, original);
    return chosen === original ? '残す' : '外す';
}

(async () => {
    // --- 候補の作り方 ---
    {
        assert.equal(bracketFreeCandidate('括弧のない文です。'), null, '外すものが無ければ問い合わせない');
        assert.equal(bracketFreeCandidate('彼は「はい」と答えた。'), '彼ははいと答えた。');
        assert.equal(bracketFreeCandidate('【重要】明日は休みです。'), '重要明日は休みです。');
        assert.equal(bracketFreeCandidate('本（『こころ』）を読む。'), '本こころを読む。');
        // 閉じと開きが隣り合う所は、外すと2つの引用が地続きになる。音素列は変わらず
        // エンジンには区別できないので、ここだけ読点1つを残す
        assert.equal(bracketFreeCandidate('「はい」「いいえ」から'), 'はい、いいえから');
        assert.equal(bracketFreeCandidate('「はい」 「いいえ」から'), 'はい、いいえから');
    }

    // --- 読みの取り出し方 ---
    {
        const withPause = queryReadingSignature(makeQuery('カレワ、ハイ、ト'));
        const joined = queryReadingSignature(makeQuery('カレワ/ハイト'));
        assert.equal(withPause.phonemes, 'ka re wa ha i to', '間は音素列に現れない');
        assert.equal(joined.phonemes, 'ka re wa ha i to');
        // vm の外へ出た配列は別レルムなので、値だけを比べる
        assert.deepEqual([...withPause.boundaries], [3, 5, 6], '句の切れ目はモーラ数で覚える');
        assert.deepEqual([...joined.boundaries], [3, 6]);
        const empty = queryReadingSignature({});
        assert.equal(empty.phonemes, '', '応答の形が違っても落ちない');
        assert.equal(empty.boundaries.length, 0);
    }

    // --- 句がつながるだけなら外す（これが目的） ---
    {
        audioQueryCalls = [];
        assert.equal(
            await decide('彼は「はい」と答えた。', 'カレワ、ハイ、ト、コタエタ', 'カレワ/ハイト/コタエタ'),
            '外す', '助詞が元の句へ戻るだけなら括弧を外す');
        assert.deepEqual(audioQueryCalls, ['彼ははいと答えた。'], '追加の問い合わせは1回だけ');
    }

    // --- 音素が変わるなら元のまま ---
    {
        // 助詞が吸収される（実測: カレワ/ハイ → カレ/ハエエト）
        assert.equal(
            await decide('彼は「ええ」と言った。', 'カレワ、エエ、ト、イッタ', 'カレ/ハエエトイッタ'),
            '残す', '助詞が前の語に吸収されるなら外さない');
        // 括弧ごと1語として読む略記（実測: カブシキガイシャ → カブ）
        assert.equal(
            await decide('ABC（株）の決算', 'エエビイシイ、カブシキガイシャ、ノケッサン', 'エエビイシイカブノケッサン'),
            '残す', 'エンジンが括弧ごと1語として読む略記は外さない');
        // 無声化だけが変わる（実測: 「す」と言う。→ su が sU になる）。
        // カナは同じなので、音素まで見ないと見逃す
        assert.equal(
            await decide('「す」と言う。', 'ス、ト、イウ', 'ス^ト/イウ'),
            '残す', '無声化が変われば外さない');
    }

    // --- 新しい切れ目が生まれるなら元のまま ---
    {
        // 実測: 「ここで」「はきもの」を脱ぐ。→ ハキモノ が ハキ/モノオ に割れる。
        // 音素列も句の数も一致するため、切れ目の位置を見ないと見逃す
        assert.equal(
            await decide('「ここで」「はきもの」を脱ぐ。', 'ココデ、ハキモノ、オ、ヌグ', 'ココデ、ハキ/モノオ、ヌグ'),
            '残す', '語のまとまりが割れるなら外さない');
    }

    // --- 括弧が無ければ追加の問い合わせをしない ---
    {
        audioQueryCalls = [];
        const original = makeQuery('括弧のない文です。');
        const chosen = await preferBracketFreeQuery('括弧のない文です。', 1, original);
        assert.equal(chosen, original);
        assert.deepEqual(audioQueryCalls, [], '無駄な問い合わせを増やさない');
    }

    // --- 追加の問い合わせが失敗しても、読み上げは元のまま続く ---
    {
        failOnTexts = new Set(['彼ははいと答えた。']);
        const original = makeQuery('彼は「はい」と答えた。');
        const chosen = await preferBracketFreeQuery('彼は「はい」と答えた。', 1, original);
        assert.equal(chosen, original, '判定に失敗したら元のクエリを使う（読みを壊さない側に倒す）');
        failOnTexts = new Set();
    }

    // --- 合成まで通して、選ばれた側が実際に送られる ---
    {
        READINGS.set('彼は「はい」と答えた。', 'カレワ、ハイ、ト、コタエタ');
        READINGS.set('彼ははいと答えた。', 'カレワ/ハイト/コタエタ');
        synthesisBodies = [];
        await generateVoiceBlob('彼は「はい」と答えた。', SETTINGS);
        assert.equal(synthesisBodies.length, 1);
        assert.equal(synthesisBodies[0].kana, 'カレワ/ハイト/コタエタ',
            '括弧を外した側のクエリが合成へ渡る');
        assert.ok(synthesisBodies[0].accent_phrases.every((p) => !p.pause_mora),
            '間が取り除かれている');
        assert.equal(synthesisBodies[0].speedScale, 1, '設定は選ばれたクエリに載る');

        READINGS.set('彼は「ええ」と言った。', 'カレワ、エエ、ト、イッタ');
        READINGS.set('彼はええと言った。', 'カレ/ハエエトイッタ');
        synthesisBodies = [];
        await generateVoiceBlob('彼は「ええ」と言った。', SETTINGS);
        assert.equal(synthesisBodies[0].kana, 'カレワ、エエ、ト、イッタ',
            '読みが変わる文は元のクエリが合成へ渡る');
    }

    console.log('offscreen bracket reading: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
