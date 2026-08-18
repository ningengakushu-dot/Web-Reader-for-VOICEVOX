// offscreen.js の公開前監査で修正した挙動の回帰検査:
// - 合成が失敗したら残りの文は合成せず、PLAYBACK_ERROR は文の数だけ連発しない
// - 何も再生していないときの STOP_AUDIO は PLAYBACK_STOPPED を通知しない
// - OCR 要求の requestId を OCR_COMPLETE にそのまま返す（成功・失敗とも）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
let listener;
const notifications = [];
let synthesisAttempts = 0;
// 合成へ渡ったテキスト（分割して読み直す挙動の検査に使う）
const synthesizedTexts = [];
let ocrResult = { text: '認識結果', confidence: 90 };
// 合成の振る舞い: 呼び出し回数(1始まり)ごとに 'ok' | 'unreachable' | 'http' を返す
let synthesisPlan = () => 'unreachable';

class MockAudio {
    constructor(url) { this.url = url; }
    play() { setImmediate(() => this.onended?.()); return Promise.resolve(); }
    pause() {}
    removeAttribute() {}
    load() {}
}

const chrome = {
    runtime: {
        id: 'ext-id',
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage(message) { notifications.push(message); return Promise.resolve(); }
    }
};
const context = vm.createContext({
    console: { ...console, error() {} }, chrome, Audio: MockAudio, setTimeout, clearTimeout, setImmediate, Promise,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 100,
    VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100, OCR_WORKER_IDLE_RELEASE_MS: 1000,
    OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (url) => {
        // 1回の合成 = audio_query + synthesis の2リクエスト。audio_query 側で振る舞いを決める。
        if (url.includes('/audio_query')) {
            synthesisAttempts++;
            synthesizedTexts.push(decodeURIComponent(String(url).split('&text=')[1] || ''));
            const mode = synthesisPlan(synthesisAttempts);
            if (mode === 'unreachable') throw new TypeError('Failed to fetch');
            if (mode === 'http') return { ok: false, status: 500 };
            // 話者がこのエンジンに存在しない等、要求そのものが拒否される場合
            if (mode === 'reject') return { ok: false, status: 404 };
            // VOICEVOX ではない何かが同じポートで応答した場合
            if (mode === 'garbage') return { ok: true, __garbage: true };
            return { ok: true };
        }
        return { ok: true };
    },
    readJsonResponseWithLimit: async (response) => {
        // 本文が JSON でない応答は JSON.parse と同じ SyntaxError を投げる
        if (response?.__garbage) throw new SyntaxError('Unexpected token \'<\'');
        return { accent_phrases: [] };
    },
    readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    createPrimaryOcrProgressTracker: () => ({ reset() {}, update: () => null }),
    recognizeWithOrientation: async () => ocrResult,
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 1, height: 1 }),
    fetch: async () => ({ blob: async () => ({}) })
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
assert.equal(typeof listener, 'function');

const sender = { id: 'ext-id' };
const send = (message) => new Promise((resolve) => listener(message, sender, resolve));
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const settings = { speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, pauseLengthScale: 1 };

(async () => {
    // --- 何も動いていないときの停止は PLAYBACK_STOPPED を出さない ---
    {
        await send({ type: 'STOP_AUDIO', target: 'offscreen' });
        await wait();
        assert.ok(!notifications.some((m) => m.type === 'PLAYBACK_STOPPED'),
            '再生していないときの停止で PLAYBACK_STOPPED を通知しない');
    }

    // --- 合成失敗で残りの文を破棄する ---
    {
        notifications.length = 0;
        synthesisAttempts = 0;
        const texts = Array.from({ length: 30 }, (_, i) => `文${i}。`);
        const response = await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts, settings });
        assert.equal(response.success, true);
        await wait(80);
        const errors = notifications.filter((m) => m.type === 'PLAYBACK_ERROR');
        assert.equal(errors.length, 1, `合成失敗の通知は1回だけ（実際: ${errors.length}）`);
        assert.equal(synthesisAttempts, 1, '最初の失敗で残りの文の合成をやめる');
    }

    // --- 失敗後の停止は状態が空なので通知しない ---
    {
        notifications.length = 0;
        await send({ type: 'STOP_AUDIO', target: 'offscreen' });
        await wait();
        assert.ok(!notifications.some((m) => m.type === 'PLAYBACK_STOPPED'));
    }

    // --- 1文目は成功・2文目でエンジン到達不能: 合成済みの音声は再生を終え、終了通知で待機へ戻る ---
    {
        notifications.length = 0;
        synthesisAttempts = 0;
        synthesisPlan = (n) => (n === 1 ? 'ok' : 'unreachable');
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['一。', '二。', '三。', '四。'], settings });
        await wait(120);
        const types = notifications.map((m) => m.type);
        assert.ok(types.includes('PLAYBACK_STARTED'), '1文目の再生は始まる');
        assert.equal(types.filter((t) => t === 'PLAYBACK_ERROR').length, 1, 'エラー通知は1回');
        assert.equal(synthesisAttempts, 2, '到達不能の失敗以降は合成しない');
        assert.ok(types.includes('PLAYBACK_ENDED'), '再生中の音声が終われば PLAYBACK_ENDED が飛び、アイコンが待機へ戻る');
    }

    // --- HTTP エラー（特定の文だけ拒否）では従来どおり次の文へ進む ---
    {
        notifications.length = 0;
        synthesisAttempts = 0;
        synthesisPlan = (n) => (n === 2 ? 'http' : 'ok');
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['一。', '二。', '三。'], settings });
        await wait(150);
        assert.equal(synthesisAttempts, 3, 'HTTP エラーの文を飛ばして残りを合成する');
        assert.equal(notifications.filter((m) => m.type === 'PLAYBACK_ERROR').length, 1);
        assert.ok(notifications.some((m) => m.type === 'PLAYBACK_ENDED'));
    }

    // --- HTTP エラーで拒否された長い文は、半分に割って読み直す（黙って消さない） ---
    // エンジンは1要求のアクセント句が49を超えると 500 を返す。従来はその1文が音声から
    // 消え、前後がつながって聞こえていた（利用者から見た「読み飛ばし」）。
    {
        notifications.length = 0;
        synthesisAttempts = 0;
        synthesizedTexts.length = 0;
        synthesisPlan = (n) => (n === 1 ? 'http' : 'ok');
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['前半の文です、後半の文です。'], settings });
        await wait(200);
        assert.equal(synthesisAttempts, 3, '拒否された文を2つに割って合成し直す');
        assert.deepEqual(synthesizedTexts.slice(1), ['前半の文です、', '後半の文です。'],
            '句読点で割った断片を元の順序どおりに合成する');
        assert.equal(notifications.filter((m) => m.type === 'PLAYBACK_ERROR').length, 0,
            '割って読めたならエラーは通知しない');
    }

    // --- 割っても読めない文は有限回で諦め、通知は元の1文につき1回だけ ---
    {
        notifications.length = 0;
        synthesisAttempts = 0;
        synthesizedTexts.length = 0;
        synthesisPlan = () => 'http';
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['前半の文です、後半の文です。'], settings });
        await wait(300);
        assert.equal(synthesisAttempts, 3, '断片が分割下限より短くなればそこで打ち切る');
        assert.equal(notifications.filter((m) => m.type === 'PLAYBACK_ERROR').length, 1,
            '断片ごとにエラーを連発しない');
    }

    // --- 短い文は長さが原因ではないので割らない（従来どおり次の文へ進む） ---
    {
        notifications.length = 0;
        synthesisAttempts = 0;
        synthesizedTexts.length = 0;
        synthesisPlan = (n) => (n === 1 ? 'http' : 'ok');
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['短い。', '次の文。'], settings });
        await wait(200);
        assert.deepEqual(synthesizedTexts, ['短い。', '次の文。'], '短い文は分割しない');
    }
    synthesisPlan = () => 'unreachable';

    // --- OCR 要求の requestId をそのまま返す ---
    {
        notifications.length = 0;
        const request = {
            type: 'OCR_RECOGNIZE', target: 'offscreen', dataUrl: 'data:image/png;base64,AAAA',
            rect: { x: 0, y: 0, width: 10, height: 10 }, viewportWidth: 10, tabId: 3, requestId: 42
        };
        await send(request);
        await wait();
        let complete = notifications.find((m) => m.type === 'OCR_COMPLETE');
        assert.ok(complete, 'OCR_COMPLETE を通知する');
        assert.equal(complete.requestId, 42, '成功時に requestId を返す');
        assert.equal(complete.tabId, 3);
        assert.equal(complete.text, '認識結果');

        notifications.length = 0;
        ocrResult = { text: '', confidence: 0 };
        await send({ ...request, requestId: 43 });
        await wait();
        complete = notifications.find((m) => m.type === 'OCR_COMPLETE');
        assert.equal(complete.requestId, 43, '失敗（空認識）時にも requestId を返す');
        assert.ok(complete.error);

        // requestId 無しの要求では付けない（旧形式との互換）
        notifications.length = 0;
        ocrResult = { text: 'x', confidence: 90 };
        const { requestId, ...legacy } = request;
        await send(legacy);
        await wait();
        complete = notifications.find((m) => m.type === 'OCR_COMPLETE');
        assert.ok(!('requestId' in complete));
    }

    // --- 話者がエンジンに無い等（404）は割り直さない。同じ理由で続けて失敗したら打ち切る ---
    // 従来は非2xx全般を「その文だけの拒否」とみなして最大15回の要求を投げ、
    // 文の数だけエラー通知が飛んでいた。
    {
        await send({ type: 'STOP_AUDIO', target: 'offscreen' });
        notifications.length = 0;
        synthesisAttempts = 0;
        synthesisPlan = () => 'reject';
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen',
            texts: ['前半の文です、後半の文です。', '二。', '三。', '四。', '五。'], settings });
        await wait(300);
        assert.equal(synthesisAttempts, 3, '404 の文は割り直さず、連続3回で打ち切る');
        assert.equal(notifications.filter((m) => m.type === 'PLAYBACK_ERROR').length, 3,
            '文の数だけではなく打ち切りまでの回数で止まる');
        const error = notifications.find((m) => m.type === 'PLAYBACK_ERROR').error;
        assert.match(error, /VOICEVOXエンジンが要求を受け付けませんでした（応答コード404）/,
            '利用者に見せる日本語の文言をそのまま伝える');
    }

    // --- VOICEVOX ではない応答（JSONでない）は内部の英語メッセージを出さない ---
    {
        await send({ type: 'STOP_AUDIO', target: 'offscreen' });
        notifications.length = 0;
        synthesisAttempts = 0;
        synthesisPlan = () => 'garbage';
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['一。', '二。'], settings });
        await wait(200);
        const error = notifications.find((m) => m.type === 'PLAYBACK_ERROR').error;
        assert.match(error, /VOICEVOXエンジンから予期しない応答が返りました/);
        assert.doesNotMatch(error, /Unexpected token|Cannot set properties/,
            '内部の英語メッセージを利用者へ出さない');
    }

    // --- 成功が挟まれば連続失敗の数え上げは戻る（1文だけ読めなかった場合に打ち切らない） ---
    {
        await send({ type: 'STOP_AUDIO', target: 'offscreen' });
        notifications.length = 0;
        synthesisAttempts = 0;
        // 短い文なので割らない。1件おきに拒否される並び
        synthesisPlan = (n) => (n % 2 === 1 ? 'reject' : 'ok');
        await send({ type: 'ENQUEUE_TEXTS', target: 'offscreen',
            texts: ['一。', '二。', '三。', '四。', '五。', '六。'], settings });
        await wait(300);
        assert.equal(synthesisAttempts, 6, '成功を挟むかぎり最後の文まで試す');
    }

    console.log('offscreen synthesis failure / stop notification / requestId echo: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
