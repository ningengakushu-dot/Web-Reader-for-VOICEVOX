const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content-guard.js'), 'utf8');

function loadGuard(chromeMock, windowMock = { open: () => null }) {
    const context = vm.createContext({ chrome: chromeMock, window: windowMock, Promise, queueMicrotask });
    vm.runInContext(source, context);
}

function invalidated() {
    throw new Error('Extension context invalidated.');
}

(async () => {
    const chromeMock = {
        storage: { local: { get: invalidated, set: invalidated, remove: invalidated } },
        runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', sendMessage: invalidated }
    };
    loadGuard(chromeMock);

    let getCallbackValue = null;
    assert.doesNotThrow(() => chromeMock.storage.local.get({}, (value) => { getCallbackValue = value; }));
    assert.doesNotThrow(() => chromeMock.storage.local.set({}, () => {}));
    assert.doesNotThrow(() => chromeMock.storage.local.remove('x', () => {}));
    assert.doesNotThrow(() => chromeMock.runtime.sendMessage({}, () => {}));
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.strictEqual(getCallbackValue, null, 'stale callback chains must not continue');

    assert.strictEqual(JSON.stringify(await chromeMock.storage.local.get({})), '{}');
    assert.strictEqual(await chromeMock.storage.local.set({}), undefined);
    assert.strictEqual(await chromeMock.runtime.sendMessage({}), undefined);

    const realErrorChrome = {
        storage: { local: { get() { throw new Error('real failure'); }, set() {}, remove() {} } },
        runtime: { id: 'x', sendMessage() {} }
    };
    loadGuard(realErrorChrome);
    assert.throws(() => realErrorChrome.storage.local.get({}), /real failure/);

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/,
        'release version must use the Chrome Web Store compatible x.y.z format');
    assert.strictEqual(manifest.background.service_worker, 'background-entry.js');
    assert.deepStrictEqual(manifest.content_scripts[0].js.slice(0, 3),
        ['content-guard.js', 'dom-text.js', 'content.js']);

    const entry = fs.readFileSync(path.join(root, 'background-entry.js'), 'utf8');
    assert.match(entry, /importScripts\("background-security\.js"\)/);
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    assert.match(background, /CONTENT_SCRIPT_FILES = \["content-guard\.js", "dom-text\.js", "content\.js"\]/);
    assert.match(background, /reinjectContentScriptsAfterUpdate/);

    const pack = fs.readFileSync(path.join(root, 'tools', 'pack.ps1'), 'utf8');
    for (const file of ['background-entry.js', 'background-security.js', 'content-guard.js', 'offscreen-security.js']) {
        assert.match(pack, new RegExp(`'${file.replace('.', '\\.')}'`));
    }

    console.log('context invalidation guard: PASSED');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
