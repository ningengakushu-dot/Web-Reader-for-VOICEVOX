const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let onMessage;
const calls = [];
const local = {
    get(keys, cb) {
        const value = Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, undefined])) : { ...keys };
        if (cb) { cb(value); return; }
        return Promise.resolve(value);
    },
    set(_v, cb) { cb?.(); return Promise.resolve(); }
};
let sessionValue = {};
const session = {
    get() { return Promise.resolve({ ...sessionValue }); },
    set(v) { Object.assign(sessionValue, v); return Promise.resolve(); },
    remove(k) { delete sessionValue[k]; return Promise.resolve(); }
};
let firstStop = true;
const chrome = {
    runtime: {
        id: 'ext-id', lastError: null, getURL: (p) => `chrome-extension://ext-id/${p}`,
        getContexts: () => Promise.resolve([{ contextType: 'OFFSCREEN_DOCUMENT' }]),
        sendMessage(message) {
            if (message.target !== 'offscreen') return Promise.resolve({ success: true });
            calls.push(message.type);
            if (message.type === 'STOP_AUDIO' && firstStop) {
                firstStop = false;
                return new Promise((resolve) => setTimeout(() => resolve({ success: true }), 20));
            }
            return Promise.resolve({ success: true });
        },
        onInstalled: { addListener() {} }, onMessage: { addListener(fn) { onMessage = fn; } },
        openOptionsPage: () => Promise.resolve()
    },
    scripting: { executeScript: () => Promise.resolve() },
    storage: { local, session },
    contextMenus: { removeAll(cb) { cb(); }, create(_v, cb) { cb?.(); }, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} }, setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
    commands: { onCommand: { addListener() {} } },
    tabs: {
        sendMessage: () => Promise.resolve(), query: () => Promise.resolve([]), create: () => Promise.resolve(),
        captureVisibleTab: () => Promise.resolve('data:image/png;base64,AA=='),
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
    },
    offscreen: { createDocument: () => Promise.resolve() }
};
const context = vm.createContext({
    console, chrome, importScripts() {}, setTimeout, clearTimeout, Promise, Date, Math,
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 15000,
    SETTING_DEFAULTS: { speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, pauseLengthScale: 1 },
    OCR_SETTING_DEFAULTS: { ocrRemoveRuby: false }, CAPTURE_STORAGE_KEY: 'capture',
    PLAYBACK_TAB_STORAGE_KEY: 'playback', fetch: async () => { throw new Error('unused'); },
    OffscreenCanvas: function() {}, createImageBitmap: async () => ({}), btoa: () => ''
});
vm.runInContext(source, context, { filename: 'background.js' });
assert.strictEqual(typeof onMessage, 'function');

function generate(tabId, text) {
    return new Promise((resolve) => {
        const keep = onMessage({ type: 'GENERATE_VOICE', text }, { tab: { id: tabId } }, resolve);
        assert.strictEqual(keep, true);
    });
}

(async () => {
    const [a, b] = await Promise.all([generate(1, 'first'), generate(2, 'second')]);
    assert.strictEqual(a.success, true);
    assert.strictEqual(b.success, true);
    assert.deepStrictEqual(calls, ['STOP_AUDIO', 'ENQUEUE_TEXTS', 'STOP_AUDIO', 'ENQUEUE_TEXTS'],
        'voice operations must not interleave across tabs');
    console.log('background voice operation serialization: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
