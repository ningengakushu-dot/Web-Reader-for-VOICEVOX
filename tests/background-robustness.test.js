const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let onMessage;
const localData = {};
const local = {
    get(keys, callback) {
        const result = Array.isArray(keys)
            ? Object.fromEntries(keys.map((k) => [k, localData[k]]))
            : { ...keys, ...localData };
        if (callback) { callback(result); return; }
        return Promise.resolve(result);
    },
    set(value, callback) { Object.assign(localData, value); if (callback) callback(); return Promise.resolve(); }
};
const session = {
    get() { return Promise.resolve({}); }, set() { return Promise.resolve(); },
    remove() { return Promise.resolve(); }
};
const chrome = {
    runtime: {
        id: 'ext-id', lastError: null, getURL: (p) => `chrome-extension://ext-id/${p}`,
        getContexts: () => Promise.resolve([{ contextType: 'OFFSCREEN_DOCUMENT' }]),
        sendMessage: (message) => Promise.resolve(message.target === 'offscreen'
            ? { success: false, error: 'offscreen rejected request' } : { success: true }),
        onInstalled: { addListener() {} }, onMessage: { addListener(fn) { onMessage = fn; } },
        openOptionsPage() {}
    },
    scripting: { executeScript: () => Promise.resolve() },
    storage: { local, session },
    contextMenus: { removeAll(cb) { cb(); }, create(_v, cb) { if (cb) cb(); }, onClicked: { addListener() {} } },
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
    console, chrome, importScripts() {}, setTimeout, clearTimeout, Promise, Date,
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 15000,
    SETTING_DEFAULTS: { speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, pauseLengthScale: 1 },
    OCR_SETTING_DEFAULTS: { ocrRemoveRuby: false }, CAPTURE_STORAGE_KEY: 'capture',
    PLAYBACK_TAB_STORAGE_KEY: 'playback', fetch: async () => { throw new Error('not used'); },
    OffscreenCanvas: function() {}, createImageBitmap: async () => ({}), btoa: () => ''
});
vm.runInContext(source, context, { filename: 'background.js' });
assert.strictEqual(typeof onMessage, 'function');

(async () => {
    const response = await new Promise((resolve) => {
        const keepOpen = onMessage({ type: 'GENERATE_VOICE', text: 'test' }, { tab: { id: 7 } }, resolve);
        assert.strictEqual(keepOpen, true);
    });
    assert.strictEqual(response.success, false, 'offscreen rejection must propagate to the caller');
    assert.match(response.error, /offscreen rejected request/);
    console.log('background failure propagation: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
