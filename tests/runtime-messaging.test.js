const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'runtime-messaging.js'), 'utf8');

function load(chrome) {
    const context = vm.createContext({ chrome, console, Promise, Error, Boolean, Object });
    vm.runInContext(source, context, { filename: 'runtime-messaging.js' });
    return context.VVRadioRuntimeMessaging;
}

(async () => {
    let sentMessage = null;
    const chrome = {
        runtime: {
            id: 'ext-id',
            lastError: null,
            sendMessage(message, callback) {
                sentMessage = message;
                callback({ success: true, value: 7 });
            }
        }
    };
    const messaging = load(chrome);
    assert.ok(messaging);
    assert.strictEqual(messaging.isRuntimeAvailable(), true);
    assert.strictEqual(messaging.send({ type: 'PING' }, () => {}), true);
    assert.deepStrictEqual(sentMessage, { type: 'PING' });
    assert.strictEqual((await messaging.request({ type: 'REQUEST' })).value, 7);

    chrome.runtime.lastError = { message: 'context failed' };
    await assert.rejects(() => messaging.request({ type: 'FAIL' }), /context failed/);
    assert.strictEqual(await messaging.requestOrNull({ type: 'FAIL_SAFE' }), null);

    const unavailable = load({ runtime: { id: '' } });
    assert.strictEqual(unavailable.send({ type: 'PING' }, () => {}), false);
    await assert.rejects(() => unavailable.request({ type: 'PING' }), /無効/);

    const throwing = load({ runtime: { get id() { throw new Error('invalidated'); } } });
    assert.strictEqual(throwing.isRuntimeAvailable(), false);
    assert.strictEqual(throwing.send({ type: 'PING' }, () => {}), false);

    console.log('runtime messaging adapter: PASSED');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
