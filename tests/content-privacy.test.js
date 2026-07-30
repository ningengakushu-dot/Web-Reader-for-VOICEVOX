const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const listeners = new Map();
const createElement = () => ({
    id: '', style: {}, textContent: '', className: '', classList: { add() {}, remove() {} },
    appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {},
    attachShadow() { return createElement(); }, querySelector() { return createElement(); },
    offsetWidth: 16, offsetHeight: 16, offsetLeft: 0, offsetTop: 0
});
const documentMock = {
    body: createElement(), documentElement: createElement(), activeElement: null,
    createElement, getElementById() { return null; }, addEventListener() {}, removeEventListener() {},
    hasFocus() { return true; }
};
const windowMock = {
    self: 1, top: 1, innerWidth: 1280, innerHeight: 720,
    addEventListener() {}, removeEventListener() {}, getSelection() { return { toString: () => 'fallback' }; },
    open() { return null; }, requestAnimationFrame(fn) { fn(); }
};
windowMock.window = windowMock;
const chromeMock = {
    runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop', lastError: null, getURL: (p) => p,
        sendMessage(_message, callback) { if (callback) callback({ success: true, shouldShow: false }); },
        onMessage: { addListener() {} }
    },
    storage: {
        local: { get(_keys, callback) { callback({}); }, set() {} },
        onChanged: { addListener() {}, removeListener() {} }
    }
};
const context = vm.createContext({
    console, window: windowMock, document: documentMock, chrome: chromeMock,
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn()
});
vm.runInContext(source, context, { filename: 'content.js' });
const reader = context.window.__vvRadioReaderInstance;
assert.ok(reader);

documentMock.activeElement = {
    tagName: 'INPUT', type: 'password', value: 'top-secret', selectionStart: 0, selectionEnd: 10
};
assert.strictEqual(reader.getSelectedText(), '', 'password input must never be returned');
let spoken = null;
reader.speakText = (text) => { spoken = text; };
reader.toggleReading();
assert.strictEqual(spoken, null, 'password input must never reach speech generation');

documentMock.activeElement = {
    tagName: 'INPUT', type: 'text', value: 'normal text', selectionStart: 0, selectionEnd: 6
};
assert.strictEqual(reader.getSelectedText(), 'normal', 'normal selected input text must remain supported');

console.log('content privacy boundaries: PASSED');
