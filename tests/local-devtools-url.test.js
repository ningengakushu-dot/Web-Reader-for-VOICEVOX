const assert = require('node:assert/strict');

(async () => {
    const { localDevtoolsUrl } = await import('../tools/local-devtools-url.mjs');
    const valid = 'ws://127.0.0.1:9337/devtools/page/1234-abcd';
    assert.equal(localDevtoolsUrl(valid, 9337), valid);
    for (const invalid of [
        'ws://example.com:9337/devtools/page/1234',
        'ws://127.0.0.1.example.com:9337/devtools/page/1234',
        'ws://127.0.0.1:9338/devtools/page/1234',
        'wss://127.0.0.1:9337/devtools/page/1234',
        'ws://user@127.0.0.1:9337/devtools/page/1234',
        'ws://127.0.0.1:9337/devtools/page/1234?forward=example.com',
        'ws://127.0.0.1:9337/devtools/page/1234#fragment',
        'ws://127.0.0.1:9337/arbitrary/path',
        'ws://127.0.0.1:9337/devtools/page/id%2Fother',
        null
    ]) {
        assert.throws(() => localDevtoolsUrl(invalid, 9337), '画像の接続先を外部や別ポートに変更させない');
    }
    assert.throws(() => localDevtoolsUrl(valid, '9337'));
    console.log('local-only DevTools image transport: PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; });
