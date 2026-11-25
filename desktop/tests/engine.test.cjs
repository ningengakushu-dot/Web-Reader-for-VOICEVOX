"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const { speakers, synthesize } = require("../engine.cjs");

const settings = { styleId: 3, speed: 1.5, volume: 0.7 };

// Only the test transport changes ports. An installed engine can keep listening on 50021.
async function mockEngine(t, respond) {
    const server = http.createServer(respond);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const original = http.request;
    t.mock.method(http, "request", (options, callback) => {
        assert.equal(options.hostname, "127.0.0.1");
        assert.equal(options.port, 50021);
        assert.equal(options.agent, false);
        return original({ ...options, port }, callback);
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
}

test("voice settings are applied to the same style and WAV bytes are isolated", async t => {
    const paths = [];
    const bodies = [];
    const sample = "日の出を見た。";
    await mockEngine(t, async (req, res) => {
        paths.push(new URL(req.url, "http://localhost"));
        if (paths.length === 1) {
            res.end(JSON.stringify({ accent_phrases: [], outputSamplingRate: 24000 }));
        } else {
            let body = "";
            for await (const chunk of req) body += chunk;
            bodies.push(JSON.parse(body));
            res.end("RIFF0000WAVE1234");
        }
    });
    const wav = await synthesize(sample, {...settings, pitch: -0.15, intonation: 0.4, pause: 0, volume: 2});
    assert.deepEqual(paths.map(url => url.pathname), ["/audio_query", "/synthesis"]);
    assert.deepEqual(paths.map(url => url.searchParams.get("speaker")), ["3", "3"]);
    assert.equal(paths[0].searchParams.get("text"), sample);
    assert.deepEqual(bodies, [{
        accent_phrases: [], outputSamplingRate: 24000, speedScale: 1.5, volumeScale: 2,
        pitchScale: -0.15, intonationScale: 0.4, pauseLengthScale: 0,
        prePhonemeLength: 0.1 * 1.5, postPhonemeLength: 0.1 * 1.5
    }]);
    assert.equal(wav.buffer.byteLength, wav.byteLength);
    assert.equal(Buffer.from(wav).toString(), "RIFF0000WAVE1234");
});

test("only usable talk styles from current or older speakers lists are exposed", async t => {
    await mockEngine(t, (_, res) => res.end(JSON.stringify([
        { name: " 話者 ", styles: [
            { name: "通常", id: 3, type: "talk" }, { name: "旧式", id: 5 },
            { name: "歌", id: 8, type: "sing" }, { name: "不正", id: -1 }, null
        ] }, { name: "", styles: [{ name: "通常", id: 2 }] }, null
    ])));
    assert.deepEqual(await speakers(), [{ name: "話者", styles: [{ name: "通常", id: 3 }, { name: "旧式", id: 5 }] }]);
});

test("invalid input is rejected before contacting the engine", async t => {
    const spy = t.mock.method(http, "request", () => { throw new Error("unexpected request"); });
    for (const text of [null, " ", "。", "あ\0い", "あ\ud800", "あ".repeat(601), "𠮷".repeat(601)]) {
        await assert.rejects(synthesize(text, settings), { message: "invalid" });
    }
    for (const values of [{ styleId: -1 }, { styleId: "1" }, { speed: NaN }, { speed: 2.1 },
        { volume: -1 }, { volume: Infinity }, { volume: 2.1 }, { pitch: -0.16 }, { pitch: 0.16 },
        { intonation: -0.1 }, { intonation: 2.1 }, { pause: -1 }, { pause: 2.1 }]) {
        await assert.rejects(synthesize("声", { ...settings, ...values }), { message: "invalid" });
    }
    assert.equal(spy.mock.callCount(), 0);
});

test("aborting during the query response releases the socket and skips synthesis", async t => {
    const received = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    let requests = 0;
    await mockEngine(t, (_, res) => {
        requests++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write("{");
        res.once("close", disconnected.resolve);
        received.resolve();
    });
    const controller = new AbortController();
    const result = synthesize("本文", settings, controller.signal);
    await received.promise;
    controller.abort();
    await assert.rejects(result, { message: "synthesis" });
    await disconnected.promise;
    assert.equal(requests, 1);
});

test("redirects, oversized bodies and malformed responses fail without reflecting engine text", async t => {
    const replies = [
        res => { res.writeHead(307, { Location: "http://example.invalid" }); res.end(); },
        res => { res.writeHead(200, { "Content-Length": 5 * 1024 * 1024 }); res.end(); },
        res => { res.writeHead(200, { "Transfer-Encoding": "chunked" }); res.end(Buffer.alloc(4 * 1024 * 1024 + 1)); },
        res => res.end("private input copied into an error"),
        res => res.end('{"unexpected":"shape"}'),
        res => res.end('{"accent_phrases":[]}'),
        res => res.end("not a wave file")
    ];
    await mockEngine(t, (_, res) => replies.shift()(res));
    for (let i = 0; i < 6; i++) {
        await assert.rejects(synthesize("本文", settings), { message: "synthesis" });
    }
    assert.equal(replies.length, 0);
});

test("a refused connection is reported as offline", async t => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const original = http.request;
    t.mock.method(http, "request", (options, cb) => original({ ...options, port }, cb));
    await assert.rejects(speakers(), { message: "offline" });
});

test("only HTTP 5xx from a required query or synthesis asks the player to split", async t => {
    const replies = [500, 422, 200, 503, 200, 404];
    await mockEngine(t, (_, res) => {
        res.statusCode = replies.shift();
        res.end('{"accent_phrases":[]}');
    });
    for (const message of ["retryable", "synthesis", "retryable", "synthesis"]) {
        await assert.rejects(synthesize("長い文章を読む。", settings), {message});
    }
    assert.equal(replies.length, 0);
});

test("bracket candidates keep phonemes and existing accent boundaries, and preserve adjacent quotes", async t => {
    const phrase = (...vowels) => ({moras: vowels.map(vowel => ({vowel}))});
    const original = [phrase("a"), phrase("i", "U")];
    const candidates = [
        [phrase("a", "i", "U")],  // removing a boundary is allowed
        [phrase("a", "i", "u")],  // de-voicing changed
        [phrase("a", "i"), phrase("U")], // same phonemes but a new boundary
        null // optional query failed
    ];
    const requested = [], chosen = [];
    await mockEngine(t, async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/audio_query") {
            const text = url.searchParams.get("text");
            requested.push(text);
            const candidate = text === "はい、そうです";
            const phrases = candidate ? candidates.shift() : original;
            if (!phrases) res.statusCode = 500;
            res.end(JSON.stringify({accent_phrases: phrases, kana: candidate ? "candidate" : "original"}));
            return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        chosen.push(JSON.parse(body).kana);
        res.end("RIFF0000WAVE1234");
    });
    const originalText = "「はい」「そうです」";
    for (let i = 0; i < 4; i++) await synthesize(originalText, settings);
    assert.deepEqual(requested, Array.from({length: 4}, () => [originalText, "はい、そうです"]).flat());
    assert.deepEqual(chosen, ["candidate", "original", "original", "original"]);
});
