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
    responseBytes = null, chunkSizes = null, noAudioContext = false, queryOptions = {},
    manifestStatus = 200, onChunk = null, timeScale = 1, timerScale = 1 } = {}) {
    let contexts = [];
    let fetchPaths = [];
    const listenerStats = { active: 0, maxActive: 0, added: 0 };
    class TrackedAbortController extends AbortController {
        constructor() {
            super();
            const signal = this.signal;
            const originalAdd = signal.addEventListener.bind(signal);
            const originalRemove = signal.removeEventListener.bind(signal);
            const tracked = new Set();
            signal.addEventListener = (type, listener, options) => {
                if (type === "abort" && !tracked.has(listener)) {
                    tracked.add(listener);
                    listenerStats.added++;
                    listenerStats.active++;
                    listenerStats.maxActive = Math.max(listenerStats.active, listenerStats.maxActive);
                }
                return originalAdd(type, listener, options);
            };
            signal.removeEventListener = (type, listener, options) => {
                if (type === "abort" && tracked.delete(listener)) listenerStats.active--;
                return originalRemove(type, listener, options);
            };
        }
    }
    class FakeContext {
        constructor() {
            this.startedAt = Date.now();
            this.state = "running";
            this.destination = {};
            this.sources = [];
            contexts.push(this);
        }
        get currentTime() { return (Date.now() - this.startedAt) / 1000 * timeScale; }
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
                        Math.max(1, 1000 * (at + this.buffer.duration - ctx.currentTime) / timeScale));
                },
                stop() { clearTimeout(this.timer); }
            };
            return src;
        }
        async close() { this.state = "closed"; }
    }
    const query = { outputSamplingRate: PCM_RATE, outputStereo: false, ...queryOptions };
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
                        if (onChunk) await onChunk({ count, at, contexts });
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
        console, setTimeout: (callback, ms, ...args) =>
            setTimeout(callback, Math.max(1, ms / timerScale), ...args),
        clearTimeout, Date, AbortController: TrackedAbortController, Uint8Array, DataView,
        VOICEVOX_BASE_URL: "http://127.0.0.1:50021",
        AudioContext: noAudioContext ? undefined : FakeContext,
        async fetch(url) {
            const path = new URL(url).pathname;
            fetchPaths.push(path);
            if (path === "/streaming_synthesis") return streamResponse();
            if (path === "/engine_manifest" && manifestStatus !== 200) {
                return { ok: false, status: manifestStatus };
            }
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
    return { api: context.VVRadioStreaming, contexts, fetchPaths, query, listenerStats };
}

async function run() {
    const e = environment();
    assert.equal(await e.api.supports(5), true);
    assert.equal(await e.api.supports(5, true), false, "normal-only setting takes precedence");
    assert.equal(await e.api.supports(5), true);
    assert.equal(e.fetchPaths.filter(x => x === "/engine_manifest").length, 1,
        "capability response is cached");
    assert.equal(await e.api.supports(6), false, "unlisted style falls back");
    assert.equal(await environment({ speakerType: "talk" }).api.supports(5), false);
    assert.equal(await environment({ feature: { value: true } }).api.supports(5), false,
        "raw manifest JSON object is not API boolean");
    assert.equal(await environment({ noAudioContext: true }).api.supports(5), false);
    const oldEngine = environment({ manifestStatus: 404 });
    assert.equal(await oldEngine.api.supports(5), false);
    assert.equal(oldEngine.fetchPaths.join(","), "/engine_manifest",
        "legacy ENGINE must not receive needless /speakers or /version calls");
    const unsupported = environment({ feature: false });
    assert.equal(await unsupported.api.supports(5), false);
    assert.equal(unsupported.fetchPaths.join(","), "/engine_manifest");
    const offline = environment({ manifestStatus: 500 });
    assert.equal(await offline.api.supports(5), false);
    assert.equal(offline.fetchPaths.length, 1);

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

    const stereoEnv = environment({ responseBytes: wav(7000, 2, 48000),
        queryOptions: { outputSamplingRate: 48000, outputStereo: true } });
    await stereoEnv.api.createPlayer(stereoEnv.query, 5, () => {}).run();
    const stereoSources = stereoEnv.contexts[0].sources;
    assert.equal(stereoSources.reduce((sum, x) => sum + x.buffer.data[0].length, 0), 7000);
    assert.equal(stereoSources[0].buffer.data[0][0], -250 / 32768);
    assert.equal(stereoSources[0].buffer.data[1][0], -249 / 32768);

    const halted = environment({ responseBytes: wav(72000) });
    const stoppedPlayer = halted.api.createPlayer(halted.query, 5, () => {});
    const pending = stoppedPlayer.run();
    await new Promise(resolve => setTimeout(resolve, 90));
    stoppedPlayer.stop();
    await assert.rejects(pending, /中断|AbortError/);
    assert.equal(halted.contexts[0].state, "closed", "stop closes audio context");

    // 途中でPCMの供給が止まっても、過去に出した音声を再生し直さず
    // 残りのサンプルを最後まで再生する（無音期間を完全には消せない）。
    const slowed = environment({ responseBytes: wav(72000),
        chunkSizes: [44 + 36000 * 2, 72000],
        onChunk({ count, contexts }) {
            if (count === 2) contexts[0].startedAt -= 2300;
        } });
    await slowed.api.createPlayer(slowed.query, 5, () => {}).run();
    const delayedSources = slowed.contexts[0].sources;
    assert.equal(delayedSources.reduce((sum, source) => sum + source.buffer.data[0].length, 0), 72000,
        "slow transport must not drop any PCM samples");
    assert.ok(delayedSources.some((source, index) => index > 0
        && source.at > delayedSources[index - 1].at
            + delayedSources[index - 1].buffer.duration + 0.1),
        "test must produce a real scheduling underrun");
    assert.equal(await slowed.api.supports(5), false,
        "underruns temporarily disable streaming for future requests");

    // 5秒先読み上限で待機を繰り返したあとでも、通常終了時にabort listenerは残さない。
    const backpressure = environment({ responseBytes: wav(24000 * 7),
        chunkSizes: [44 + 24000 * 7 * 2], timeScale: 25 });
    await backpressure.api.createPlayer(backpressure.query, 5, () => {}).run();
    assert.ok(backpressure.listenerStats.maxActive >= 2,
        "backpressure must exercise both bounded receive and playback wait listeners");
    assert.equal(backpressure.listenerStats.active, 0,
        "all abort listeners must be released after normal playback");

    // Web Audioの予約後・出力時刻前に応答が壊れた場合は、予約音源を
    // キャンセルして通常合成へフォールバックできなければならない。
    let prematureStartNotifications = 0;
    const earlyFailure = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) {
            if (count === 2) throw new Error("network broke before audible playback");
        }
    });
    const earlyPlayer = earlyFailure.api.createPlayer(earlyFailure.query, 5,
        () => prematureStartNotifications++);
    await assert.rejects(earlyPlayer.run(), /before audible/);
    assert.ok(earlyFailure.contexts[0].sources.length > 0,
        "must actually schedule source before the failure");
    assert.equal(earlyPlayer.started, false,
        "future scheduled source is not yet audible and may safely fall back");
    assert.equal(prematureStartNotifications, 0, "canceled source cannot emit PLAYBACK_STARTED");
    assert.equal(earlyFailure.contexts[0].state, "closed");
    assert.equal(earlyFailure.listenerStats.active, 0);

    // 再生時刻を過ぎてから、開始通知のタイマーより先にエラーになっても、
    // 重複音声の危険があるため先頭から再合成してはならない。
    const edgeFailure = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count, contexts }) {
            if (count === 2) {
                contexts[0].startedAt -= 100;
                throw new Error("network broke after audio clock crossed start");
            }
        }
    });
    const edgePlayer = edgeFailure.api.createPlayer(edgeFailure.query, 5, () => {});
    await assert.rejects(edgePlayer.run(), /crossed start/);
    assert.equal(edgePlayer.started, true,
        "audio clock past scheduled start must disable duplicate-producing fallback");
    assert.equal(edgeFailure.contexts[0].state, "closed");
    assert.equal(edgeFailure.listenerStats.active, 0);

    // 開始時刻まで残り5ms（クロック上は未開始）の場合も、
    // 実出力との競合を避けるため保守的に再合成を禁止する。
    const boundaryGuard = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count, contexts }) {
            if (count === 2) {
                const ctx = contexts[0];
                ctx.startedAt = Date.now() - 1000 * (ctx.sources[0].at - 0.005);
                throw new Error("failure inside playback start guard");
            }
        }
    });
    const boundaryPlayer = boundaryGuard.api.createPlayer(boundaryGuard.query, 5, () => {});
    await assert.rejects(boundaryPlayer.run(), /inside playback start guard/);
    assert.equal(boundaryPlayer.started, true, "5ms start boundary forbids duplicate fallback");
    assert.equal(boundaryGuard.listenerStats.active, 0);

    // 20秒を超える一時停止から復旧したら、同じ reader.read() で再開できる。
    // タイムアウトだけ短縮して実時間では待たない（20ms=20秒相当）。
    const recoverStall = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        timerScale: 1000, timeScale: 1000,
        async onChunk({ count }) {
            if (count === 2) await new Promise(resolve => setTimeout(resolve, 35));
        }
    });
    const recoveredPlayer = recoverStall.api.createPlayer(recoverStall.query, 5, () => {});
    await recoveredPlayer.run();
    assert.equal(recoverStall.contexts[0].sources.reduce(
        (sum, item) => sum + item.buffer.data[0].length, 0), 45000,
    "a recoverable stall must preserve all PCM frames");
    assert.equal(recoverStall.listenerStats.active, 0);

    // 合計60秒相当の供給停止は無制限に待たず終了する。
    const fatalStall = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        timerScale: 1000, timeScale: 1000,
        async onChunk({ count }) {
            if (count === 2) await new Promise(resolve => setTimeout(resolve, 90));
        }
    });
    const fatalPlayer = fatalStall.api.createPlayer(fatalStall.query, 5, () => {});
    await assert.rejects(fatalPlayer.run(), /受信タイムアウト/);
    assert.equal(fatalStall.contexts[0].state, "closed");
    assert.equal(fatalStall.listenerStats.active, 0);

    // 読み上げ停止の直後に別の読み上げを開始しても、古いタイマーと
    // イベントリスナーが後続の再生へ干渉しない。
    const stopEnv = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) { if (count === 2) return new Promise(() => {}); }
    });
    const oldPlayer = stopEnv.api.createPlayer(stopEnv.query, 5, () => {});
    const oldRun = oldPlayer.run();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(stopEnv.contexts[0]?.sources.length > 0, "first playback must be scheduled");
    oldPlayer.stop();
    await assert.rejects(oldRun, /中断|AbortError/);
    assert.equal(stopEnv.listenerStats.active, 0);
    assert.equal(stopEnv.contexts[0].state, "closed");
    const freshEnv = environment({ responseBytes: wav(3000) });
    await freshEnv.api.createPlayer(freshEnv.query, 5, () => {}).run();
    assert.equal(freshEnv.listenerStats.active, 0);
    assert.equal(freshEnv.contexts[0].state, "closed");

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
