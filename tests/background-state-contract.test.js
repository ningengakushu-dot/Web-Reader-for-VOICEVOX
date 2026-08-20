const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function createHarness(initialSession = {}) {
    let onMessage;
    const sessionData = { ...initialSession };
    const tabMessages = [];
    const offscreenMessages = [];
    const local = {
        get(keys, callback) {
            const value = Array.isArray(keys)
                ? Object.fromEntries(keys.map((key) => [key, undefined]))
                : { ...keys };
            if (callback) { callback(value); return; }
            return Promise.resolve(value);
        },
        set(_value, callback) { callback?.(); return Promise.resolve(); },
        remove(_key, callback) { callback?.(); return Promise.resolve(); }
    };
    const session = {
        get(key) { return Promise.resolve(key in sessionData ? { [key]: sessionData[key] } : {}); },
        set(value) { Object.assign(sessionData, value); return Promise.resolve(); },
        remove(key) { delete sessionData[key]; return Promise.resolve(); }
    };
    const chrome = {
        runtime: {
            id: 'ext-id', lastError: null,
            getURL: (p) => `chrome-extension://ext-id/${p}`,
            getContexts: () => Promise.resolve([{ contextType: 'OFFSCREEN_DOCUMENT' }]),
            sendMessage(message) {
                if (message.target === 'offscreen') offscreenMessages.push(message);
                return Promise.resolve({ success: true });
            },
            onInstalled: { addListener() {} },
            onMessage: { addListener(fn) { onMessage = fn; } },
            openOptionsPage: () => Promise.resolve()
        },
        scripting: { executeScript: () => Promise.resolve() },
        storage: { local, session },
        contextMenus: {
            removeAll(cb) { cb?.(); }, create(_value, cb) { cb?.(); }, onClicked: { addListener() {} }
        },
        action: {
            onClicked: { addListener() {} }, setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {}
        },
        commands: { onCommand: { addListener() {} } },
        tabs: {
            sendMessage(tabId, message) { tabMessages.push({ tabId, message }); return Promise.resolve(); },
            query: () => Promise.resolve([]), create: () => Promise.resolve(),
            captureVisibleTab: () => Promise.resolve('data:image/png;base64,AA=='),
            onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
        },
        offscreen: { createDocument: () => Promise.resolve() }
    };
    const context = vm.createContext({
        console, chrome, importScripts() {}, setTimeout, clearTimeout, Promise, Date, Math,
        VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 15000,
        SETTING_DEFAULTS: {
            speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1,
            volumeScale: 1, pauseLengthScale: 1
        },
        CAPTURE_STORAGE_KEY: 'capture', CAPTURE_MAX_DATAURL_LENGTH: 8 * 1024 * 1024,
        PLAYBACK_TAB_STORAGE_KEY: 'playback',
        fetch: async () => { throw new Error('unused'); },
        OffscreenCanvas: function() {}, createImageBitmap: async () => ({}), btoa: () => ''
    });
    vm.runInContext(source, context, { filename: 'background.js' });
    assert.equal(typeof onMessage, 'function');
    const send = (message, sender) => new Promise((resolve) => {
        const keepOpen = onMessage(message, sender, resolve);
        if (keepOpen !== true) resolve(undefined);
    });
    return { send, sessionData, tabMessages, offscreenMessages };
}

(async () => {
    // Service Worker のメモリが消えていても、storage.session の再生宛先を復元して通知する。
    {
        const h = createHarness({ playback: 42 });
        await h.send({ type: 'PLAYBACK_ENDED', target: 'background' }, {
            id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html'
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(h.tabMessages.some(({ tabId, message }) =>
            tabId === 42 && message.type === 'PLAYBACK_ENDED' && message.target === 'tab'),
        'storage.session から復元したタブへ再生終了を転送する');
    }

    // 別タブへ読み上げを切り替えると、旧タブへ停止を通知してから宛先を保存する。
    {
        const h = createHarness({ playback: 7 });
        const response = await h.send({ type: 'GENERATE_VOICE', text: '次のタブ。' }, { tab: { id: 8 } });
        assert.equal(response.success, true);
        assert.equal(h.sessionData.playback, 8);
        assert.ok(h.tabMessages.some(({ tabId, message }) =>
            tabId === 7 && message.type === 'PLAYBACK_STOPPED'),
        '旧再生タブへ停止通知を送る');
        assert.deepEqual(h.offscreenMessages.map((message) => message.type), ['STOP_AUDIO', 'ENQUEUE_TEXTS']);
    }

    console.log('background state contract: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
