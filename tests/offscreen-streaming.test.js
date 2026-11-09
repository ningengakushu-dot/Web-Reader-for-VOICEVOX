const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const base = path.resolve(__dirname, "..");
const PCM_RATE = 24000;

function wav(frames, channels = 1, rate = PCM_RATE) {
    const bytes = new Uint8Array(44 + frames * channels * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, str) => [...str].forEach((char, i) => {
        bytes[offset + i] = char.charCodeAt(0);
    });
    ascii(0, "RIFF"); view.setUint32(4, bytes.length - 8, true);
    ascii(8, "WAVEfmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    ascii(36, "data"); view.setUint32(40, bytes.length - 44, true);
    for (let i = 0; i < frames * channels; i++) {
        view.setInt16(44 + i * 2, (i % 500) - 250, true);
    }
    return bytes;
}

function environment({ speakerType = "streaming_talk", feature = true,
    responseBytes = null, chunkSizes = null, noAudioContext = false } = {}) {
    let contexts = [];
    let fetchPaths = [];
    class FakeContext {
        constructor() {
            this.startedAt = Date.now();
            this.state = "running";
            this.destination = {};
            this.sources = [];
            contexts.push(this);
        }
        get currentTime() { return (Date.now() - this.startedAt) / 1000; }
        async resume() { this.state = "running"; }
        createBuffer(channels, frames, rate) {
            const data = Array.from({ length: channels }, () => new Float32Array(frames));
            return { duration: frames / rate, getChannelData(channel) { return data[channel]; }, data };
        }
        createBufferSource() {
            const ctx = this;
            const src = {
                buffer: null, onended: null,
                connect() {}, disconnect() {},
                start(at) {
                    this.at = at;
                    ctx.sources.push(this);
                    this.timer = setTimeout(() => this.onended?.(),
                        Math.max(1, 1000 * (at + this.buffer.duration - ctx.currentTime)));
                },
                stop() { clearTimeout(this.timer); }
            };
            return src;
        }
        async close() { this.state = "closed"; }
    }
    const query = { outputSamplingRate: PCM_RATE, outputStereo: false };
    const input = responseBytes || wav(18000);
    const cuts = chunkSizes || [1, 2, 7, 12, 20, 3, 1, 8191, 3, 8192, 65535];
    function streamResponse() {
        let at = 0;
        let count = 0;
        return {
            ok: true,
            headers: { get(name) { return name === "content-length" ? String(input.length) : null; } },
            body: { getReader() {
                return {
                    async read() {
                        if (at >= input.length) return { done: true };
                        const size = cuts[count++ % cuts.length];
                        const chunk = input.subarray(at, Math.min(input.length, at + size));
                        at += chunk.length;
                        return { done: false, value: chunk };
                    },
                    async cancel() {},
                    releaseLock() {}
                };
            } }
        };
    }
    const context = vm.createContext({
        console, setTimeout, clearTimeout, Date, AbortController, Uint8Array, DataView,
        VOICEVOX_BASE_URL: "http://127.0.0.1:50021",
        AudioContext: noAudioContext ? undefined : FakeContext,
        async fetch(url) {
            const path = new URL(url).pathname;
            fetchPaths.push(path);
            if (path === "/streaming_synthesis") return streamResponse();
            const payload = path === "/engine_manifest"
                ? { uuid: "test", supported_features: { streaming_synthesis: feature } }
                : path === "/speakers"
                    ? [{ styles: [{ id: 5, type: speakerType }] }]
                    : "0.26.0";
            return { ok: true, payload };
        },
        async readJsonResponseWithLimit(res) { return res.payload; }
    });
    vm.runInContext(fs.readFileSync(path.join(base, "offscreen-streaming.js"), "utf8"),
        context, { filename: "offscreen-streaming.js" });
    return { api: context.VVRadioStreaming, contexts, fetchPaths, query };
}

async function run() {
    const e = environment();
    assert.equal(await e.api.supports(5), true);
    assert.equal(await e.api.supports(5), true);
    assert.equal(e.fetchPaths.filter(x => x === "/engine_manifest").length, 1,
        "capability response is cached");
    assert.equal(await e.api.supports(6), false, "unlisted style falls back");
    assert.equal(await environment({ speakerType: "talk" }).api.supports(5), false);
    assert.equal(await environment({ feature: { value: true } }).api.supports(5), false,
        "raw manifest JSON object is not API boolean");
    assert.equal(await environment({ noAudioContext: true }).api.supports(5), false);

    const valid = wav(10);
    assert.equal(e.api.pcmHeader(valid.subarray(0, 44), e.query, valid.length).dataBytes, 20);
    const invalid = valid.slice();
    invalid[34] = 8; // not 16 bit
    assert.throws(() => e.api.pcmHeader(invalid.subarray(0, 44), e.query, invalid.length));
    const stereo = wav(20, 2, 48000);
    assert.equal(e.api.pcmHeader(stereo.subarray(0, 44),
        { outputSamplingRate: 48000, outputStereo: true }, stereo.length).channels, 2);

    let started = 0;
    const player = e.api.createPlayer(e.query, 5, () => started++);
    await player.run();
    assert.equal(started, 1);
    assert.equal(player.started, true);
    const sources = e.contexts[0].sources;
    const samples = sources.flatMap(s => Array.from(s.buffer.data[0]));
    assert.equal(samples.length, 18000);
    for (const sampleIndex of [0, 1, 4095, 4096, 8191, 8192, 17999]) {
        assert.ok(Math.abs(samples[sampleIndex] -
            ((sampleIndex % 500) - 250) / 32768) < 1e-7);
    }
    for (let i = 1; i < sources.length; i++) {
        assert.ok(Math.abs(sources[i].at -
            (sources[i - 1].at + sources[i - 1].buffer.duration)) < 1e-6,
            "PCM buffers must be scheduled without gaps or overlap");
    }
    assert.equal(e.contexts[0].state, "closed", "AudioContext released after final sample");

    const broken = wav(5000);
    broken[0] = 0;
    const f = environment({ responseBytes: broken });
    const invalidPlayer = f.api.createPlayer(f.query, 5, () => {});
    await assert.rejects(invalidPlayer.run(), /WAV/);
    assert.equal(invalidPlayer.started, false, "malformed header may safely fall back");

    const shorter = wav(5000).subarray(0, 44 + 3500);
    const g = environment({ responseBytes: shorter });
    await assert.rejects(g.api.createPlayer(g.query, 5, () => {}).run(), /WAV|末尾/);

    console.log("offscreen streaming support, WAV, PCM split, playback and error: OK");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
