const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
let listener;
let audioMode = 'error';
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
    fetchWithTimeout: async (url) => ({ ok: true, status: 200, marker: url.includes('audio_query') ? 'json' : 'blob' }),
    readJsonResponseWithLimit: async () => ({}), readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    resetOcrProgress() {}, recognizeWithOrientation: async () => ({ text: '', confidence: 0 }),
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 1, height: 1 }),
    fetch: async () => ({ blob: async () => ({}) })
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
assert.strictEqual(typeof listener, 'function');

function enqueue(text) {
    return new Promise((resolve) => {
        listener({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: [text], settings: {
            speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, pauseLengthScale: 1
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

    console.log('offscreen playback terminal states: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
