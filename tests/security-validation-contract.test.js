const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

function loadSecurity(file, chrome) {
    const context = vm.createContext({ chrome, console, Set, Number, Object, Array, Promise });
    const validationPath = path.join(root, 'validation-utils.js');
    if (fs.existsSync(validationPath)) {
        vm.runInContext(fs.readFileSync(validationPath, 'utf8'), context, { filename: 'validation-utils.js' });
    }
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    return context;
}

const chrome = { runtime: { id: 'ext-id', getURL: (p) => `chrome-extension://ext-id/${p}` } };
const tabSender = { id: 'ext-id', tab: { id: 7 }, frameId: 0, url: 'https://example.com/' };
const offscreenSender = { id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html' };

const background = loadSecurity('background-security.js', chrome).VVRadioBackgroundSecurity;
assert.ok(background, 'background security must be exported');

for (const [rect, viewportWidth, expected] of [
    [{ x: 0, y: 0, width: 1, height: 1 }, 1, true],
    [{ x: 0, y: 0, width: 100000, height: 1000 }, 100000, true],
    [{ x: -1, y: 0, width: 1, height: 1 }, 100, false],
    [{ x: 0, y: 0, width: 0, height: 1 }, 100, false],
    [{ x: 0, y: 0, width: 100001, height: 1 }, 100, false],
    [{ x: 0, y: 0, width: 100000, height: 1001 }, 100, false],
    [{ x: 0, y: 0, width: Infinity, height: 1 }, 100, false],
    [{ x: 0, y: 0, width: 1, height: 1 }, Infinity, false],
]) {
    assert.strictEqual(background.validateRequest({
        type: 'CAPTURE_OCR_REGION', rect, viewportWidth
    }, tabSender).ok, expected, `background rect contract: ${JSON.stringify(rect)}`);
}

assert.strictEqual(background.validateRequest({
    type: 'OCR_PROGRESS', target: 'background', tabId: 7, progress: 0
}, offscreenSender).ok, true);
assert.strictEqual(background.validateRequest({
    type: 'OCR_PROGRESS', target: 'background', tabId: 7, progress: 1
}, offscreenSender).ok, true);
assert.strictEqual(background.validateRequest({
    type: 'OCR_PROGRESS', target: 'background', tabId: 7, progress: 1.000001
}, offscreenSender).ok, false);

const offscreen = loadSecurity('offscreen-security.js', chrome).VVRadioOffscreenSecurity;
assert.ok(offscreen, 'offscreen security must be exported');

function ocrRequest(rect, viewportWidth = 100) {
    return {
        type: 'OCR_RECOGNIZE', target: 'offscreen', dataUrl: 'data:image/png;base64,AAAA',
        rect, viewportWidth, tabId: 7
    };
}
assert.strictEqual(offscreen.validate(ocrRequest({ x: 0, y: 0, width: 1, height: 1 }, 1)).ok, true);
assert.strictEqual(offscreen.validate(ocrRequest({ x: 0, y: 0, width: 100000, height: 1000 }, 100000)).ok, true);
assert.strictEqual(offscreen.validate(ocrRequest({ x: 0, y: 0, width: 100000, height: 1001 })).ok, false);
assert.strictEqual(offscreen.validate(ocrRequest({ x: 0, y: 0, width: NaN, height: 1 })).ok, false);
assert.strictEqual(offscreen.validate(ocrRequest({ x: 0, y: 0, width: 1, height: 1 }, 100001)).ok, false);

console.log('security validation contract: PASSED');
