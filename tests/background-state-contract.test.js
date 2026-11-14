const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function createHarness(initialSession = {}, { rejectEnqueue = false, beforeOffscreenReply } = {}) {
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
            async sendMessage(message) {
                if (message.target === 'offscreen') offscreenMessages.push(message);
                if (beforeOffscreenReply) await beforeOffscreenReply(message);
                if (rejectEnqueue && message.type === 'ENQUEUE_TEXTS') {
                    return Promise.resolve({ success: false, error: 'injected enqueue failure' });
                }
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
        console, chrome, setTimeout, clearTimeout, Promise, Date, Math,
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
    context.importScripts = (...files) => {
        for (const file of files) {
            vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
        }
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background-entry.js'), 'utf8'), context,
        { filename: 'background-entry.js' });
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
        const h = createHarness({ vv_playback_tab_id: 42 });
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
        const h = createHarness({ vv_playback_tab_id: 7 });
        const response = await h.send({ type: 'GENERATE_VOICE', text: '次のタブ。' },
            { id: 'ext-id', tab: { id: 8 } });
        assert.equal(response.success, true);
        assert.equal(h.sessionData.vv_playback_tab_id, 8);
        assert.ok(h.tabMessages.some(({ tabId, message }) =>
            tabId === 7 && message.type === 'PLAYBACK_STOPPED'),
        '旧再生タブへ停止通知を送る');
        assert.deepEqual(h.offscreenMessages.map((message) => message.type), ['STOP_AUDIO', 'ENQUEUE_TEXTS']);
        assert.deepEqual(h.tabMessages.filter(({ message }) => message.type === 'PLAYBACK_PREPARING')
            .map(({ tabId }) => tabId), [8], 'preparation is only announced to the requesting tab');
    }

    {
        const h = createHarness({}, { rejectEnqueue: true });
        const response = await h.send({ type: 'GENERATE_VOICE', text: '受付に失敗する文。' },
            { id: 'ext-id', tab: { id: 8 } });
        assert.equal(response.success, false);
        assert.deepEqual(h.tabMessages.map(({ message }) => message.type),
            ['PLAYBACK_PREPARING', 'PLAYBACK_STOPPED'], 'failed enqueue must clear preparation');
    }

    {
        let releaseOldStop;
        let oldStopStarted;
        const blocked = new Promise(resolve => { oldStopStarted = resolve; });
        const h = createHarness({ vv_playback_tab_id: 8 }, {
            beforeOffscreenReply(message) {
                if (message.type === 'STOP_AUDIO' && !releaseOldStop) {
                    return new Promise(resolve => {
                        releaseOldStop = resolve;
                        oldStopStarted();
                    });
                }
            }
        });
        const sender = { id: 'ext-id', tab: { id: 8 } };
        const first = h.send({ type: 'GENERATE_VOICE', text: '取り消す文。' }, sender);
        await blocked;
        await h.send({ type: 'PLAYBACK_STOPPED', target: 'background' }, {
            id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html'
        });
        assert.deepEqual(h.tabMessages.map(({ message }) => message.type), ['PLAYBACK_PREPARING'],
            'old playback stop must preserve the preparing state');

        const stop = h.send({ type: 'STOP_ALL' }, sender);
        const next = h.send({ type: 'GENERATE_VOICE', text: '再開する文。' }, sender);
        releaseOldStop();
        assert.equal((await first).cancelled, true);
        assert.equal((await stop).success, true);
        assert.equal((await next).success, true);
        assert.deepEqual(h.offscreenMessages.filter(m => m.type === 'ENQUEUE_TEXTS')
            .map(m => m.texts.join('')), ['再開する文。'], 'only the new start reaches Offscreen');
        assert.deepEqual(h.tabMessages.map(({ message }) => message.type),
            ['PLAYBACK_PREPARING', 'PLAYBACK_PREPARING'], 'old stop must preserve the restarted request');
    }

    console.log('background state contract: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
