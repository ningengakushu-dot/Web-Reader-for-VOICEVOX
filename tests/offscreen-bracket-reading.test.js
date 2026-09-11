// 括弧が作る不自然な間を取り除く判定（offscreen.js）の検査。
//
// 括弧は読まれないが、開き・閉じの両方が「間」を作り、直後の助詞を別のアクセント句へ
// 切り離す。外してよいかは文字の並びからは決められない（実測: 「彼は「ええ」と言った」を
// 外すと助詞の「は」が吸収されて カレ/ハエエト になる）。そのためエンジンに両方の読みを
// 尋ね、モーラ列が変わらないときだけ外す。ここではその判定だけを、読みを固定した
// 疑似エンジンで検査する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8')
    + '\n;globalThis.__test = { bracketFreeCandidate, queryMoraSignature, preferBracketFreeQuery };';

// テキストごとの読み（モーラ）を決める疑似エンジン。未登録のテキストは文字をそのまま返す。
const READINGS = new Map();
let audioQueryCalls = [];
let failOnTexts = new Set();

function makeQuery(text) {
    const moras = READINGS.has(text) ? READINGS.get(text) : [...text];
    // 読点を「間」として持たせ、モーラ列には含めないこと（実エンジンと同じ）を再現する
    const phrases = [];
    let current = [];
    for (const ch of moras) {
        if (ch === '、') {
            phrases.push({ moras: current, pause_mora: { vowel_length: 0.3 } });
            current = [];
            continue;
        }
        current.push({ text: ch, consonant_length: 0, vowel_length: 0.1 });
    }
    phrases.push({ moras: current, pause_mora: null });
    return { accent_phrases: phrases, __text: text };
}

const context = vm.createContext({
    console: { ...console, error() {} },
    chrome: { runtime: { id: 'ext-id', onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() } },
    Audio: class {}, setTimeout, clearTimeout, setImmediate, Promise,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 100,
    VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100, OCR_WORKER_IDLE_RELEASE_MS: 1000,
    OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (url) => {
        if (!String(url).includes('/audio_query')) return { ok: true };
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
const { bracketFreeCandidate, queryMoraSignature, preferBracketFreeQuery } = context.__test;

(async () => {
    // --- 候補の作り方 ---
    {
        assert.equal(bracketFreeCandidate('括弧のない文です。'), null, '外すものが無ければ問い合わせない');
        assert.equal(bracketFreeCandidate('彼は「はい」と答えた。'), '彼ははいと答えた。');
        assert.equal(bracketFreeCandidate('【重要】明日は休みです。'), '重要明日は休みです。');
        assert.equal(bracketFreeCandidate('本（『こころ』）を読む。'), '本こころを読む。');
        // 閉じと開きが隣り合う所は、外すと2つの引用が地続きになる。モーラ列は変わらず
        // エンジンには区別できないので、ここだけ読点1つを残す
        assert.equal(bracketFreeCandidate('「はい」「いいえ」から'), 'はい、いいえから');
        assert.equal(bracketFreeCandidate('「はい」 「いいえ」から'), 'はい、いいえから');
    }

    // --- 読みの比較は「間」に左右されない ---
    {
        assert.equal(queryMoraSignature(makeQuery('カレワ、ハイ、ト')), 'カレワハイト');
        assert.equal(queryMoraSignature(makeQuery('カレワハイト')), 'カレワハイト');
        assert.equal(queryMoraSignature({}), '', '応答の形が違っても落ちない');
    }

    // --- 読みが変わらないなら外す ---
    {
        READINGS.set('彼は「はい」と答えた。', [...'カレワ、ハイ、ト、コタエタ']);
        READINGS.set('彼ははいと答えた。', [...'カレワハイトコタエタ']);
        audioQueryCalls = [];
        const original = makeQuery('彼は「はい」と答えた。');
        const chosen = await preferBracketFreeQuery('彼は「はい」と答えた。', 1, original);
        assert.equal(chosen.__text, '彼ははいと答えた。', '読みが同じなら括弧を外した側を使う');
        assert.deepEqual(audioQueryCalls, ['彼ははいと答えた。'], '追加の問い合わせは1回だけ');
    }

    // --- 読みが変わるなら元のまま（助詞が吸収される・略記が別の語になる） ---
    {
        READINGS.set('彼は「ええ」と言った。', [...'カレワ、エエ、ト、イッタ']);
        READINGS.set('彼はええと言った。', [...'カレハエエトイッタ']);
        const original = makeQuery('彼は「ええ」と言った。');
        const chosen = await preferBracketFreeQuery('彼は「ええ」と言った。', 1, original);
        assert.equal(chosen.__text, '彼は「ええ」と言った。', '読みが変わるなら外さない');

        READINGS.set('ABC（株）の決算', [...'エイビイシイカブシキガイシャノケッサン']);
        READINGS.set('ABC株の決算', [...'エイビイシイカブノケッサン']);
        const kabu = makeQuery('ABC（株）の決算');
        assert.equal((await preferBracketFreeQuery('ABC（株）の決算', 1, kabu)).__text, 'ABC（株）の決算',
            'エンジンが括弧ごと1語として読む略記は外さない');
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

    console.log('offscreen bracket reading: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
