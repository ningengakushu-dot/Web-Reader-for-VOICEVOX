const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
let listener;
const chrome = {
    runtime: {
        id: 'ext-id',
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage() { return Promise.resolve(); }
    }
};
const context = vm.createContext({
    console, chrome, Audio: class {}, setTimeout, clearTimeout, Promise,
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    VOICEVOX_BASE_URL: '', VOICEVOX_FETCH_TIMEOUT_MS: 100, VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100,
    OCR_WORKER_IDLE_RELEASE_MS: 1000, OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async () => ({ ok: true }), readJsonResponseWithLimit: async () => ({}),
    readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    recognizeWithOrientation: () => new Promise(() => {}),
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 10, height: 10 }),
    fetch: async () => ({ blob: async () => ({}) })
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
assert.strictEqual(typeof listener, 'function');

function request() {
    return new Promise((resolve) => listener({
        type: 'OCR_RECOGNIZE', target: 'offscreen', dataUrl: 'data:image/png;base64,AAAA',
        rect: { x: 0, y: 0, width: 10, height: 10 }, viewportWidth: 10, tabId: 1
    }, { id: 'ext-id' }, resolve));
}

(async () => {
    const responses = await Promise.all([request(), request(), request(), request()]);
    assert.deepStrictEqual(responses.map((r) => r.success), [true, true, true, false]);
    assert.match(responses[3].error, /混み合/);
    console.log('offscreen OCR queue limit: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
