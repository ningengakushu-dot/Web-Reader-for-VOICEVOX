const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(file, chrome) {
    const context = vm.createContext({ chrome, console, Set, Number, Object, Array, Promise });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    return context;
}

(() => {
    const chrome = { runtime: { id: 'ext-id', getURL: (p) => `chrome-extension://ext-id/${p}` } };
    const bg = load('background-security.js', chrome).VVRadioBackgroundSecurity;
    assert.ok(bg);
    const tabSender = { id: 'ext-id', tab: { id: 1 }, frameId: 0, url: 'https://example.com/' };
    const optionsSender = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
    const captureSender = { id: 'ext-id', url: 'chrome-extension://ext-id/capture.html?cid=123' };
    const offscreenSender = { id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html' };

    let result = bg.validateRequest({ type: 'GET_SPEAKERS' }, { id: 'other' });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /送信元/);

    result = bg.validateRequest({ type: 'GET_SPEAKERS' }, tabSender);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /設定画面/);
    assert.strictEqual(bg.validateRequest({ type: 'GET_SPEAKERS' }, optionsSender).ok, true);

    result = bg.validateRequest({ type: 'GENERATE_VOICE', text: 'a'.repeat(200001) }, tabSender);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /長すぎ/);
    assert.strictEqual(bg.validateRequest({ type: 'GENERATE_VOICE', text: '正常' }, captureSender).ok, true);

    assert.strictEqual(bg.validateRequest({
        type: 'CAPTURE_OCR_REGION', rect: { x: 0, y: 0, width: -1, height: 10 }, viewportWidth: 100
    }, tabSender).ok, false);
    assert.strictEqual(bg.validateRequest({
        type: 'CAPTURE_OCR_REGION', rect: { x: 0, y: 0, width: 10, height: 10 }, viewportWidth: 100
    }, tabSender).ok, true);

    assert.strictEqual(bg.validateRequest({ type: 'PLAYBACK_STARTED', target: 'background' }, tabSender).ok, false);
    assert.strictEqual(bg.validateRequest({ type: 'PLAYBACK_STARTED', target: 'background' }, offscreenSender).ok, true);
    assert.strictEqual(bg.validateRequest({ type: 'OCR_PROGRESS', target: 'background', tabId: 1, progress: Infinity }, offscreenSender).ok, false);
    assert.strictEqual(bg.validateRequest({ type: 'OCR_PROGRESS', target: 'background', tabId: 1, progress: 0.5 }, offscreenSender).ok, true);
    assert.strictEqual(bg.validateRequest({ type: 'OCR_COMPLETE', target: 'background', tabId: 1, error: {} }, offscreenSender).ok, false);
    assert.strictEqual(bg.validateRequest({ type: 'PLAYBACK_ERROR', target: 'background', error: 'x'.repeat(2001) }, offscreenSender).ok, false);

    const off = load('offscreen-security.js', chrome).VVRadioOffscreenSecurity;
    assert.ok(off);
    result = off.validate({
        type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['abc', '', 123],
        settings: { speakerId: -5, speedScale: 99, pitchScale: -99, volumeScale: NaN, injected: 'drop' }
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(Array.from(result.message.texts), ['abc']);
    assert.strictEqual(result.message.settings.speakerId, 1);
    assert.strictEqual(result.message.settings.speedScale, 2);
    assert.strictEqual(result.message.settings.pitchScale, -0.15);
    assert.strictEqual(result.message.settings.volumeScale, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.message.settings, 'injected'), false);

    assert.strictEqual(off.validate({
        type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: ['a'.repeat(200001)], settings: {}
    }).ok, false);
    assert.strictEqual(off.validate({
        type: 'OCR_RECOGNIZE', target: 'offscreen', dataUrl: 'javascript:alert(1)',
        rect: { x: 0, y: 0, width: 10, height: 10 }, viewportWidth: 100, tabId: 1
    }).ok, false);
    result = off.validate({
        type: 'OCR_RECOGNIZE', target: 'offscreen', dataUrl: 'data:image/png;base64,AAAA',
        rect: { x: 0, y: 0, width: 10, height: 10 }, viewportWidth: 100, tabId: 1, removeRuby: 1
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.message, 'removeRuby'), false,
        '廃止したルビ設定をOCRメッセージへ引き継がない');

    console.log('security message boundaries: PASSED');
})();
