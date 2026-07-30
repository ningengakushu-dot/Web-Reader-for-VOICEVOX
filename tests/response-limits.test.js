const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'constants.js'), 'utf8');
const context = vm.createContext({
    console, fetch: async () => {}, AbortController, setTimeout, clearTimeout,
    Uint8Array, TextDecoder, Blob, JSON, Number, Math, Error
});
vm.runInContext(source, context, { filename: 'constants.js' });

(async () => {
    const ok = new Response(JSON.stringify({ value: 1 }), { headers: { 'content-type': 'application/json' } });
    const parsed = await context.readJsonResponseWithLimit(ok, 1024);
    assert.strictEqual(parsed.value, 1);

    const declaredTooLarge = new Response('x', { headers: { 'content-length': '10000' } });
    await assert.rejects(() => context.readResponseBytesWithLimit(declaredTooLarge, 100), /大きすぎ/);

    const streamedTooLarge = new Response('x'.repeat(101));
    await assert.rejects(() => context.readResponseBytesWithLimit(streamedTooLarge, 100), /大きすぎ/);

    let cancelled = false;
    const stalled = new Response(new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { cancelled = true; }
    }));
    await assert.rejects(() => context.readResponseBytesWithLimit(stalled, 100, 20), /完了しません/);
    assert.strictEqual(cancelled, true);

    const wavHeader = new Uint8Array([
        82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69
    ]);
    const audio = await context.readBlobResponseWithLimit(new Response(wavHeader), 1024, 100);
    assert.strictEqual(audio.type, 'audio/wav');
    await assert.rejects(() => context.readBlobResponseWithLimit(
        new Response('not audio'), 1024, 100), /不正な音声/);

    console.log('VOICEVOX response limits: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
