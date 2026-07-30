const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content-guard.js'), 'utf8');

function loadGuard(chromeMock) {
    const context = vm.createContext({ chrome: chromeMock, Promise });
    vm.runInContext(source, context);
}

function invalidated() {
    throw new Error('Extension context invalidated.');
}

(async () => {
    const chromeMock = {
        storage: {
            local: {
                get: invalidated,
                set: invalidated
            }
        },
        runtime: {
            sendMessage: invalidated
        }
    };

    loadGuard(chromeMock);

    assert.doesNotThrow(() => chromeMock.storage.local.get({}, () => {}));
    assert.doesNotThrow(() => chromeMock.storage.local.set({}, () => {}));
    assert.doesNotThrow(() => chromeMock.runtime.sendMessage({}, () => {}));

    assert.deepStrictEqual(await chromeMock.storage.local.get({}), {});
    assert.strictEqual(await chromeMock.storage.local.set({}), undefined);
    assert.strictEqual(await chromeMock.runtime.sendMessage({}), undefined);

    const realErrorChrome = {
        storage: { local: { get() { throw new Error('real failure'); }, set() {} } },
        runtime: { sendMessage() {} }
    };
    loadGuard(realErrorChrome);
    assert.throws(() => realErrorChrome.storage.local.get({}), /real failure/);

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.version, '1.4.2');
    assert.deepStrictEqual(
        manifest.content_scripts[0].js.slice(0, 3),
        ['content-guard.js', 'dom-text.js', 'content.js'],
        'content-guard.js must load before content.js'
    );

    const pack = fs.readFileSync(path.join(__dirname, '..', 'tools', 'pack.ps1'), 'utf8');
    assert.match(pack, /'content-guard\.js'/, 'release package must include content-guard.js');

    console.log('context invalidation guard: PASSED');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
