const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
let listener;
let audioMode = 'error';
let normalSynthesisCalls = 0;
const notifications = [];

class MockAudio {
    constructor(url) { this.url = url; this.error = { code: 3, message: 'decode failed' }; }
    play() {
        setImmediate(() => {
            if (audioMode === 'error') this.onerror?.({ type: 'error' });
            else this.onended?.();
        });
        return Promise.resolve();
    }
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
    console, chrome, Audio: MockAudio, setTimeout, clearTimeout, setImmediate, Promise,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 100,
    VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100, OCR_WORKER_IDLE_RELEASE_MS: 1000,
    OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (url) => {
        if (url.includes('/synthesis?')) normalSynthesisCalls++;
        return { ok: true, status: 200, marker: url.includes('audio_query') ? 'json' : 'blob' };
    },
    readJsonResponseWithLimit: async () => ({ accent_phrases: [] }), readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    createPrimaryOcrProgressTracker: () => ({ reset() {}, update: () => null }),
    recognizeWithOrientation: async () => ({ text: '', confidence: 0 }),
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 1, height: 1 }),
    fetch: async () => ({ blob: async () => ({}) })
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
assert.strictEqual(typeof listener, 'function');

function enqueue(text, mode) {
    return new Promise((resolve) => {
        listener({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: [text], settings: {
            speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
            pauseLengthScale: 1, synthesisMode: mode
        } }, { id: 'ext-id' }, resolve);
    });
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 30));

(async () => {
    let response = await enqueue('error case');
    assert.strictEqual(response.success, true);
    await wait();
    assert.ok(notifications.some((m) => m.type === 'PLAYBACK_ERROR'));
    assert.ok(!notifications.some((m) => m.type === 'PLAYBACK_ENDED'),
        'audio errors must not be immediately overwritten by PLAYBACK_ENDED');

    notifications.length = 0;
    audioMode = 'ended';
    response = await enqueue('normal case');
    assert.strictEqual(response.success, true);
    await wait();
    assert.ok(notifications.some((m) => m.type === 'PLAYBACK_ENDED'),
        'normal completion must still emit PLAYBACK_ENDED');

    // 既存設定を持たないユーザーには新しい合成方式を適用しない。
    let checks = 0;
    let streamAttempts = 0;
    let streamStarted = false;
    context.VVRadioStreaming = {
        supports: async () => { checks++; return true; },
        suppress() {},
        createPlayer: () => ({
            get started() { return streamStarted; },
            async run() { streamAttempts++; throw new Error('stream transport failed'); },
            stop() {}
        })
    };
    notifications.length = 0;
    const beforeNormal = normalSynthesisCalls;
    response = await enqueue('legacy user without mode');
    await wait();
    assert.strictEqual(checks, 0, 'an old installation must not probe or enable streaming');
    assert.strictEqual(normalSynthesisCalls, beforeNormal + 1,
        'legacy settings must continue using /synthesis');

    // 再生開始前だけ通常合成へ戻し、同じテキストを欠落させずに再生する。
    notifications.length = 0;
    const beforeFallback = normalSynthesisCalls;
    response = await enqueue('streaming fallback', 'auto');
    await wait();
    assert.strictEqual(streamAttempts, 1);
    assert.strictEqual(normalSynthesisCalls, beforeFallback + 1,
        'a failed pre-start stream must fall back exactly once');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ENDED'));
    assert.ok(!notifications.some(m => m.type === 'PLAYBACK_ERROR'),
        'successful pre-start fallback must not emit a spurious error');

    // 音声再生開始後に失敗したら先頭から重複して再生しない。
    notifications.length = 0;
    const beforeMidstream = normalSynthesisCalls;
    streamStarted = true;
    response = await enqueue('streaming already audible', 'auto');
    await wait();
    assert.strictEqual(streamAttempts, 2);
    assert.strictEqual(normalSynthesisCalls, beforeMidstream,
        'already audible speech must never restart from its beginning');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ERROR'));

    console.log('offscreen playback terminal states and stream fallback: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
