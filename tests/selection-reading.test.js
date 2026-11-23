const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readContentSource } = require('./content-source');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function createHarness({ voiceError } = {}) {
    const frames = [];
    const voices = [];
    const injections = [];
    const deliveries = [];
    const pending = [];
    let backgroundListener;
    let stops = 0;
    let playback;
    const storage = {
        local: { get(_keys, cb) { cb?.({}); }, set(_value, cb) { cb?.(); }, remove(_key, cb) { cb?.(); } },
        session: {
            async get(key) { return { [key]: playback }; },
            async set(value) { playback = Object.values(value)[0]; },
            async remove() { playback = undefined; }
        },
        onChanged: { addListener() {}, removeListener() {} }
    };
    const chrome = {
        runtime: {
            id: 'test-extension', getURL: (p) => `chrome-extension://test-extension/${p}`,
            getManifest: () => manifest,
            getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
            async sendMessage(message) {
                if (message.type === 'STOP_AUDIO') stops++;
                return { success: true };
            },
            onInstalled: { addListener() {} },
            onMessage: { addListener(fn) { backgroundListener = fn; } }
        },
        storage,
        scripting: { async executeScript(target) { injections.push(target); } },
        contextMenus: { onClicked: { addListener() {} } },
        action: { onClicked: { addListener() {} } },
        commands: { onCommand: { addListener() {} } },
        tabs: {
            async sendMessage(tabId, message, options) {
                deliveries.push({ tabId, message, options });
                for (const frame of frames) {
                    if (!options || options.frameId === frame.frameId) frame.listener(message, {}, () => {});
                }
            },
            onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
        }
    };
    const background = vm.createContext({ console, chrome, setTimeout, clearTimeout });
    background.importScripts = (...files) => {
        for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), background);
    };
    background.importScripts('background-entry.js');

    function addFrame(frameId, { selected = '', child = false, focused = true, input = null } = {}) {
        const element = () => ({
            style: {}, classList: { add() {}, remove() {} }, listeners: new Map(),
            appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
            addEventListener(type, fn) { this.listeners.set(type, fn); }, removeEventListener() {},
            attachShadow() { return element(); },
            setPointerCapture(id) { this.capturedPointer = id; },
            hasPointerCapture(id) { return this.capturedPointer === id; },
            releasePointerCapture() { this.capturedPointer = null; },
            offsetWidth: 32, offsetHeight: 32, offsetLeft: 100, offsetTop: 100
        });
        const documentListeners = new Map();
        const document = {
            body: element(), documentElement: element(),
            activeElement: input || { tagName: child ? 'IFRAME' : 'BODY' },
            createElement: element, getElementById() { return null; },
            addEventListener(type, fn) { documentListeners.set(type, fn); },
            removeEventListener(type) { documentListeners.delete(type); },
            hasFocus() { return focused; }
        };
        const window = {
            self: 1, top: frameId === 0 ? 1 : 2, innerWidth: 1280, innerHeight: 720,
            addEventListener() {}, removeEventListener() {},
            getSelection() { return { toString: () => selected }; }
        };
        const frame = { frameId, document, documentListeners, notices: [], responses: [] };
        frames.push(frame);
        const frameChrome = {
            runtime: {
                id: chrome.runtime.id, getURL: chrome.runtime.getURL,
                onMessage: { addListener(fn) { frame.listener = fn; }, removeListener() {} },
                sendMessage(message, callback) {
                    if (message.type === 'GENERATE_VOICE') {
                        voices.push({ frameId, text: message.text });
                        callback?.(voiceError ? { success: false, error: voiceError } : { success: true });
                        return;
                    }
                    if (message.type === 'CHECK_CONNECTION' || message.type === 'CLAIM_UPDATE_NOTICE') {
                        callback?.({ success: true, shouldShow: false }); return;
                    }
                    const operation = new Promise((resolve) => {
                        const keepOpen = backgroundListener(message, {
                            id: chrome.runtime.id, tab: { id: 7 }, frameId, url: `https://frame${frameId}.example/`
                        }, (response) => { frame.responses.push(response); callback?.(response); resolve(); });
                        if (keepOpen !== true) resolve();
                    });
                    pending.push(operation);
                }
            }, storage
        };
        const context = vm.createContext({
            console, window, document, chrome: frameChrome,
            setTimeout() { return 1; }, clearTimeout() {}, requestAnimationFrame(fn) { fn(); }
        });
        vm.runInContext(readContentSource(), context);
        frame.reader = context.window.__vvRadioReaderInstance;
        frame.reader.showOcrToast = (text) => frame.notices.push(text);
        return frame;
    }
    const settle = async () => {
        for (let i = 0; i < pending.length; i++) await pending[i];
    };
    const click = async (frame) => {
        frame.reader.indicator.listeners.get('pointerdown')({ pointerId: 1, button: 0, clientX: 100, clientY: 100, preventDefault() {} });
        frame.documentListeners.get('pointerup')({ pointerId: 1, clientX: 100, clientY: 100 });
        frame.reader.indicator.listeners.get('click')({ preventDefault() {} });
        await settle();
    };
    return { addFrame, setPlaying: () => vm.runInContext('setPlaybackOwner({ tabId: 7 })', background), voices, injections, deliveries, click, settle, backgroundListener, get stops() { return stops; } };
}

(async () => {
    // 親文書の選択ではなく、実際にフォーカスを持つ最深フレームを読む。
    const h = createHarness();
    const top = h.addFrame(0, { child: true, selected: '外側に残った古い選択' });
    h.addFrame(1, { child: true });
    const leaf = h.addFrame(2, { selected: '教材内で選択した本文' });
    h.addFrame(3, { focused: false, selected: '別のフレーム' });
    await h.click(top);
    assert.deepEqual(h.voices, [{ frameId: 2, text: '教材内で選択した本文' }],
        'アイコンからも子フレームの選択本文を1回だけ読む');
    assert.equal(top.notices.length, 0, '子フレームで選択済みなら未選択案内を出さない');
    assert.deepEqual(JSON.parse(JSON.stringify(h.injections[0])), {
        target: { tabId: 7, allFrames: true }, files: manifest.content_scripts[0].js
    }, '更新前から開いた子フレームにもmanifestと同じ一式を事前注入する');

    // 再生中のアイコンはフォーカス先や選択範囲によらず停止として働く。
    await h.setPlaying();
    await h.click(top);
    assert.equal(h.stops, 1);
    assert.equal(h.voices.length, 1);

    for (const stopWithShortcut of [false, true]) {
        const preparing = createHarness();
        const outer = preparing.addFrame(0, { child: true });
        const focused = preparing.addFrame(1, { selected: '準備中の本文' });
        await preparing.click(outer);
        await preparing.setPlaying();
        outer.listener({ type: 'PLAYBACK_PREPARING' });
        assert.equal(outer.reader.isPlaying, false, 'preparing does not imply audible playback');
        if (stopWithShortcut) {
            focused.documentListeners.get('keydown')({
                altKey: true, shiftKey: true, code: 'KeyU', isTrusted: true,
                preventDefault() {}, stopPropagation() {}
            });
            await preparing.settle();
        } else {
            await preparing.click(outer);
        }
        assert.equal(preparing.stops, 1);
        assert.equal(preparing.voices.length, 1, 'preparing toggle must not regenerate speech');
        for (const frame of [outer, focused]) frame.listener({ type: 'PLAYBACK_STOPPED' });
        await preparing.click(outer);
        assert.equal(preparing.voices.length, 2, 'a new request can start after stop');
    }

    const plain = createHarness();
    const plainTop = plain.addFrame(0, { selected: '通常ページの本文' });
    await plain.click(plainTop);
    assert.deepEqual(plain.voices, [{ frameId: 0, text: '通常ページの本文' }]);
    plainTop.reader.indicator.listeners.get('pointerdown')({ pointerId: 1, button: 0, clientX: 100, clientY: 100, preventDefault() {} });
    plainTop.documentListeners.get('pointermove')({ pointerId: 1, buttons: 1, clientX: 120, clientY: 120 });
    plainTop.documentListeners.get('pointerup')({ pointerId: 1, clientX: 120, clientY: 120 });
    plainTop.reader.indicator.listeners.get('click')({ preventDefault() {} });
    await plain.settle();
    assert.equal(plain.voices.length, 1, 'アイコンのドラッグでは読み上げ要求を送らない');
    assert.equal(plain.injections.length, 1);

    const empty = createHarness();
    const outer = empty.addFrame(0, { child: true });
    empty.addFrame(1);
    await empty.click(outer);
    assert.equal(empty.voices.length, 0);
    assert.deepEqual(outer.notices, ['読み上げるテキストを選択してください。'],
        '子フレーム内でも未選択ならトップフレームへ案内する');

    const password = createHarness();
    const passwordTop = password.addFrame(0, { child: true });
    password.addFrame(1, { selected: 'fallback', input: {
        tagName: 'INPUT', type: 'password', value: 'secret', selectionStart: 0, selectionEnd: 6
    } });
    await password.click(passwordTop);
    assert.equal(password.voices.length, 0, '子フレームでもパスワードを読み上げない');

    for (const reason of ['読み上げられる文字がありません', '読み上げテキストが長すぎます', 'Offscreenの初期化に失敗しました']) {
        const failing = createHarness({ voiceError: reason });
        const parent = failing.addFrame(0, { child: true });
        const child = failing.addFrame(1, { selected: '選択本文' });
        parent.reader.showPlaybackErrorToast = text => parent.notices.push(text);
        child.reader.showPlaybackErrorToast = () => { throw new Error('子フレームにUIを生成しない'); };
        await failing.click(parent);
        assert.deepEqual(parent.notices, [reason], '子フレームの失敗理由をトップフレームに1回表示する');
        const errorDelivery = failing.deliveries.find(d => d.message.type === 'SELECTION_READING_ERROR');
        assert.equal(errorDelivery.tabId, 7);
        assert.equal(errorDelivery.options.frameId, 0);
        for (const [sender, error] of [
            [{ id: 'other', tab: { id: 7 }, frameId: 1 }, reason],
            [{ id: 'test-extension', frameId: 1 }, reason],
            [{ id: 'test-extension', tab: { id: 7 }, frameId: 0 }, reason],
            [{ id: 'test-extension', tab: { id: 7 }, frameId: 1 }, 'x'.repeat(1001)],
            [{ id: 'test-extension', tab: { id: 7 }, frameId: 1 }, {}]
        ]) {
            let response;
            const deliveries = failing.deliveries.length;
            failing.backgroundListener({ type: 'SELECTION_READING_ERROR', error, tabId: 99 }, sender, r => { response = r; });
            assert.equal(response?.success, false);
            assert.equal(failing.deliveries.length, deliveries);
        }
    }

    // アイコン要求から任意のタブへ転送させない。
    for (const sender of [
        { id: 'other', tab: { id: 7 }, frameId: 0 },
        { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' },
        { id: 'test-extension', tab: { id: 7 }, frameId: 2 }
    ]) {
        let response;
        const count = h.deliveries.length;
        h.backgroundListener({ type: 'TOGGLE_READING_REQUEST', tabId: 99 }, sender, r => { response = r; });
        assert.equal(response?.success, false);
        assert.equal(h.deliveries.length, count);
    }
    for (const sender of [
        { id: 'other', tab: { id: 7 }, frameId: 1 },
        { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }
    ]) {
        let response;
        h.backgroundListener({ type: 'SELECTION_REQUIRED', tabId: 99 }, sender, r => { response = r; });
        assert.equal(response?.success, false, '未選択通知も拡張自身のタブからの要求だけを受け付ける');
    }
    const noticeDelivery = empty.deliveries.find(d => d.message.type === 'SELECTION_REQUIRED');
    assert.equal(noticeDelivery.tabId, 7);
    assert.equal(noticeDelivery.options.frameId, 0, '未選択通知は要求元タブのトップフレームだけへ返す');
    assert.equal(leaf.responses.length, 0, '選択文字列の転送は通常のGENERATE_VOICEだけを使う');
    console.log('selection reading across frames: PASSED');
})().catch((error) => { console.error(error); process.exitCode = 1; });
