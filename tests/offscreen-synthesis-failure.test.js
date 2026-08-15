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
            const mode = synthesisPlan(synthesisAttempts);
            if (mode === 'unreachable') throw new TypeError('Failed to fetch');
            if (mode === 'http') return { ok: false, status: 500 };
            return { ok: true };
        }
        return { ok: true };
    },
    readJsonResponseWithLimit: async () => ({}), readBlobResponseWithLimit: async () => ({}),
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

    console.log('offscreen synthesis failure / stop notification / requestId echo: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
