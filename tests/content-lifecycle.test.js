const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function listenerRegistry() {
    const byType = new Map();
    return {
        add(type, fn) {
            if (!byType.has(type)) byType.set(type, new Set());
            byType.get(type).add(fn);
        },
        remove(type, fn) { byType.get(type)?.delete(fn); },
        count(type) { return byType.get(type)?.size || 0; },
        first(type) { return [...(byType.get(type) || [])][0]; }
    };
}

const documentListeners = listenerRegistry();
const windowListeners = listenerRegistry();
const runtimeListeners = new Set();
const storageListeners = new Set();

const createElement = () => ({
    id: '', style: {}, textContent: '', className: '', hidden: false, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, attachShadow() { return createElement(); },
    querySelector() { return createElement(); }, focus() {},
    offsetWidth: 16, offsetHeight: 16, offsetLeft: 0, offsetTop: 0
});
const documentMock = {
    body: createElement(), documentElement: createElement(), activeElement: null,
    createElement, getElementById() { return null; },
    addEventListener(type, fn) { documentListeners.add(type, fn); },
    removeEventListener(type, fn) { documentListeners.remove(type, fn); },
    hasFocus() { return true; }
};
const windowMock = {
    self: {}, top: {}, innerWidth: 1280, innerHeight: 720,
    addEventListener(type, fn) { windowListeners.add(type, fn); },
    removeEventListener(type, fn) { windowListeners.remove(type, fn); },
    getSelection() { return { toString: () => '' }; },
    open() { return null; }, requestAnimationFrame(fn) { fn(); }
};
windowMock.window = windowMock;

const chromeMock = {
    runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop', lastError: null, getURL: (p) => p,
        sendMessage(_message, callback) { callback?.({ success: true, shouldShow: false }); },
        onMessage: {
            addListener(fn) { runtimeListeners.add(fn); },
            removeListener(fn) { runtimeListeners.delete(fn); }
        }
    },
    storage: {
        local: { get(_keys, callback) { callback({}); }, set() {}, remove() {} },
        onChanged: {
            addListener(fn) { storageListeners.add(fn); },
            removeListener(fn) { storageListeners.delete(fn); }
        }
    }
};
const context = vm.createContext({
    console, window: windowMock, document: documentMock, chrome: chromeMock,
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn()
});

vm.runInContext(source, context, { filename: 'content.js' });
const first = context.window.__vvRadioReaderInstance;
assert.ok(first);
assert.equal(runtimeListeners.size, 1);
assert.equal(documentListeners.count('keydown'), 1);
assert.equal(windowListeners.count('pageshow'), 1);

// 生きている content script へ再注入しても、インスタンスやリスナーを増やさない。
vm.runInContext(source, context, { filename: 'content.js#reinjected' });
assert.strictEqual(context.window.__vvRadioReaderInstance, first);
assert.equal(runtimeListeners.size, 1);
assert.equal(documentListeners.count('keydown'), 1);
assert.equal(windowListeners.count('pageshow'), 1);

// stale インスタンスなら古いリスナーを外したうえで新しいインスタンスへ置き換える。
first.active = false;
vm.runInContext(source, context, { filename: 'content.js#stale-replaced' });
const second = context.window.__vvRadioReaderInstance;
assert.notStrictEqual(second, first);
assert.equal(runtimeListeners.size, 1);
assert.equal(documentListeners.count('keydown'), 1);
assert.equal(windowListeners.count('pageshow'), 1);

// bfcache 復帰時は「再生中」のローカル状態を必ず待機へ戻す。
let uiState = null;
let toastRemoved = 0;
second.isPlaying = true;
second.updateUIState = (state) => { uiState = state; };
second.removeOcrToast = () => { toastRemoved++; };
windowListeners.first('pageshow')({ persisted: true });
assert.equal(second.isPlaying, false);
assert.equal(uiState, 'idle');
assert.equal(toastRemoved, 1);

second.deactivate();
assert.equal(runtimeListeners.size, 0);
assert.equal(documentListeners.count('keydown'), 0);
assert.equal(windowListeners.count('pageshow'), 0);

console.log('content lifecycle contract: PASSED');
