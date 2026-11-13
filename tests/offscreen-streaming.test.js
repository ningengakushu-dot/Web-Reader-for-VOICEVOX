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
    manifestStatus = 200, onChunk = null, timeScale = 1, timerScale = 1,
    onContextClose = null, onSourceStop = null, onReaderCancel = null,
    onSourceStart = null, onReaderRelease = null, monotonicScale = 1,
    freezeAudioClock = false, neverEndSources = false, makeReader = null } = {}) {
    let contexts = [];
    let fetchPaths = [];
    let readerReleaseCount = 0;
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
        get currentTime() {
            return freezeAudioClock ? 0 : (Date.now() - this.startedAt) / 1000 * timeScale;
        }
        async resume() { this.state = "running"; }
        createAnalyser() {
            return { fftSize: 16384, connect() {}, getFloatTimeDomainData(data) { data.fill(0); } };
        }
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
                    if (onSourceStart) onSourceStart(this, ctx);
                    if (!neverEndSources) {
                        this.timer = setTimeout(() => this.onended?.(),
                            Math.max(1, 1000 * (at + this.buffer.duration - ctx.currentTime) / timeScale));
                    }
                },
                stop() {
                    if (onSourceStop) onSourceStop(this);
                    clearTimeout(this.timer);
                    this.stopped = true;
                }
            };
            return src;
        }
        async close() {
            if (onContextClose) await onContextClose(this);
            this.state = "closed";
        }
    }
    const query = { outputSamplingRate: PCM_RATE, outputStereo: false, ...queryOptions };
    const input = responseBytes || wav(18000);
    const cuts = chunkSizes || [1, 2, 7, 12, 20, 3, 1, 8191, 3, 8192, 65535];
    let requestNo = 0;
    function streamResponse(signal) {
        const request = ++requestNo;
        let at = 0;
        let count = 0;
        return {
            ok: true,
            headers: { get(name) { return name === "content-length" ? String(input.length) : null; } },
            body: { getReader() {
                if (makeReader) return makeReader({ request, contexts, bytes: input, signal });
                return {
                    async read() {
                        if (at >= input.length) return { done: true };
                        const size = cuts[count++ % cuts.length];
                        if (onChunk) await onChunk({ count, at, contexts, request });
                        const chunk = input.subarray(at, Math.min(input.length, at + size));
                        at += chunk.length;
                        return { done: false, value: chunk };
                    },
                    async cancel() {
                        if (onReaderCancel) await onReaderCancel({ request, contexts });
                    },
                    releaseLock() { readerReleaseCount++; onReaderRelease?.({ request, contexts }); }
                };
            } }
        };
    }
    const context = vm.createContext({
        console, setTimeout: (callback, ms, ...args) =>
            setTimeout(callback, Math.max(1, ms / timerScale), ...args),
        clearTimeout, Date, performance: { now: () => Date.now() * monotonicScale },
        AbortController: TrackedAbortController, Uint8Array, DataView,
        VOICEVOX_BASE_URL: "http://127.0.0.1:50021",
        AudioContext: noAudioContext ? undefined : FakeContext,
        async fetch(url, options = {}) {
            const path = new URL(url).pathname;
            fetchPaths.push(path);
            if (path === "/streaming_synthesis") return streamResponse(options.signal);
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
    return { api: context.VVRadioStreaming, contexts, fetchPaths, query, listenerStats,
        get readerReleaseCount() { return readerReleaseCount; } };
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

    // 途中でPCMの供給が止まった場合は、本文を検証するまで先頭も出力しない。
    // 通信が再開したら全PCMを連続予約し、無音区間を作らない。
    const slowed = environment({ responseBytes: wav(72000),
        chunkSizes: [44 + 36000 * 2, 72000],
        timeScale: 1000, timerScale: 1000,
        async onChunk({ count, contexts }) {
            if (count === 2) {
                assert.equal(contexts[0].sources.length, 0,
                    "no PCM is scheduled while the rest of the response is unverified");
                await new Promise(resolve => setTimeout(resolve, 35));
            }
        } });
    await slowed.api.createPlayer(slowed.query, 5, () => {}).run();
    const delayedSources = slowed.contexts[0].sources;
    assert.equal(delayedSources.reduce((sum, source) => sum + source.buffer.data[0].length, 0), 72000,
        "slow transport must not drop any PCM samples");
    assert.ok(delayedSources.every((source, index) => index === 0
        || Math.abs(source.at - (delayedSources[index - 1].at
            + delayedSources[index - 1].buffer.duration)) < 1e-6),
        "a slow network response must not create silence between scheduled PCM blocks");
    assert.equal(await slowed.api.supports(5), true,
        "network stalls do not suppress a valid future stream");

    const tooLong = environment({ responseBytes: wav(24000 * 6) });
    const tooLongPlayer = tooLong.api.createPlayer(tooLong.query, 5, () => {});
    await assert.rejects(tooLongPlayer.run(), /バッファの上限/);
    assert.equal(tooLong.contexts.length, 0,
        "oversized streams fall back before any PCM is audible");
    assert.equal(tooLongPlayer.canFallback, true);

    // 5秒以内の本文は完成後に全てを予約し、終了時にabort listenerを残さない。
    const backpressure = environment({ responseBytes: wav(24000 * 4),
        chunkSizes: [44 + 24000 * 4 * 2], timeScale: 25 });
    await backpressure.api.createPlayer(backpressure.query, 5, () => {}).run();
    assert.equal(backpressure.listenerStats.active, 0,
        "all abort listeners must be released after normal playback");
    assert.equal(backpressure.contexts[0].sources.reduce(
        (sum, source) => sum + source.buffer.data[0].length, 0), 24000 * 4);

    // AudioContextの音声クロックが停止しても、単調時計の共通10分期限で最終再生を終了する。
    const frozenClock = environment({ responseBytes: wav(24000), chunkSizes: [44 + 24000 * 2],
        freezeAudioClock: true, neverEndSources: true, timerScale: 1000, monotonicScale: 1000 });
    const frozenPlayer = frozenClock.api.createPlayer(frozenClock.query, 5, () => {});
    await assert.rejects(frozenPlayer.run(), /全体の時間上限/);
    assert.equal(frozenClock.contexts[0].state, "closed");
    assert.equal(frozenClock.api.cleanupStatus(), "ready");
    assert.equal(frozenClock.listenerStats.active, 0);

    // 本文の完全検証前に通信が壊れたら、音声を一切予約せず通常合成へ戻す。
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
    assert.equal(earlyFailure.contexts[0].sources.length, 0,
        "incomplete PCM must never be scheduled");
    assert.equal(earlyPlayer.started, false, "an incomplete stream has not started playback");
    assert.equal(earlyPlayer.canFallback, true, "cancelled prestart source allows normal synthesis");
    assert.equal(earlyFailure.contexts[0].sources.every(s => s.stopped), true);
    assert.equal(prematureStartNotifications, 0, "canceled source cannot emit PLAYBACK_STARTED");
    assert.equal(earlyFailure.contexts[0].state, "closed");
    assert.equal(earlyFailure.listenerStats.active, 0);

    // 最初の音源予約直後に音声クロックが開始境界を越えた失敗は、
    // 通常合成を先頭から再生すると重複するため復帰させない。
    const edgeFailure = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onSourceStart(source, ctx) {
            if (ctx.sources.length === 2) {
                ctx.startedAt = Date.now() - 1000 * (ctx.sources[0].at + 0.005);
                throw new Error("audio clock crossed start");
            }
        }
    });
    const edgePlayer = edgeFailure.api.createPlayer(edgeFailure.query, 5, () => {});
    await assert.rejects(edgePlayer.run(), /crossed start/);
    assert.equal(edgePlayer.started, true,
        "audio clock past scheduled start must disable duplicate-producing fallback");
    assert.equal(edgePlayer.canFallback, false);
    assert.equal(edgeFailure.contexts[0].state, "closed");
    assert.equal(edgeFailure.listenerStats.active, 0);

    // 開始5ms前: 音源停止要求後にレンダリング側のPCMが無音と確認できれば復帰できる。
    const boundaryGuard = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onSourceStart(source, ctx) {
            if (ctx.sources.length === 2) {
                ctx.startedAt = Date.now() - 1000 * (ctx.sources[0].at - 0.005);
                throw new Error("failure inside playback start guard");
            }
        }
    });
    const boundaryPlayer = boundaryGuard.api.createPlayer(boundaryGuard.query, 5, () => {});
    await assert.rejects(boundaryPlayer.run(), /inside playback start guard/);
    assert.equal(boundaryPlayer.started, false,
        "5ms before first output is not audible after cancellation");
    assert.equal(boundaryPlayer.canFallback, true,
        "5ms boundary must allow normal synthesis after successful cancellation");
    assert.equal(boundaryGuard.contexts[0].sources[0].stopped, true);
    assert.equal(boundaryGuard.contexts[0].state, "closed");
    assert.equal(boundaryGuard.listenerStats.active, 0);

    // 一つでも予約取消しに失敗したら、安全を証明できないので二重再生を禁止する。
    const cancelFail = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onSourceStart(source, ctx) {
            if (ctx.sources.length === 2) throw new Error("prestart error");
        },
        onSourceStop() { throw new Error("stop not guaranteed"); }
    });
    const cancelFailPlayer = cancelFail.api.createPlayer(cancelFail.query, 5, () => {});
    await assert.rejects(cancelFailPlayer.run(), /再読み込み/,
        "failed source cancellation must surface fatal cleanup instead of transport error");
    assert.equal(cancelFailPlayer.canFallback, false,
        "failed cancellation must not start potentially duplicated normal synthesis");
    assert.equal(cancelFail.api.cleanupStatus(), "failed");

    // 20秒を超える一時停止から復旧したら、同じ reader.read() で再開できる。
    // タイムアウトだけ短縮して実時間では待たない（20ms=20秒相当）。
    const recoverStall = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        timerScale: 1000, timeScale: 1000,
        async onChunk({ count, contexts }) {
            if (count === 2) {
                assert.equal(contexts[0].sources.length, 0,
                    "PCM remains buffered during the 35-second-equivalent network pause");
                await new Promise(resolve => setTimeout(resolve, 35));
            }
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

    // 同一Offscreenの同一APIで再生を停止し、前回AudioContext.close()
    // のPromiseが完了するまで次のAudioContextを作らない。
    let releaseContextClose;
    const closeBlocked = new Promise(resolve => { releaseContextClose = resolve; });
    const rapidRestart = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onContextClose(ctx) {
            if (ctx === rapidRestart.contexts[0]) return closeBlocked;
        },
        onChunk({ count, request }) {
            if (request === 1 && count === 2) return new Promise(() => {});
        }
    });
    const first = rapidRestart.api.createPlayer(rapidRestart.query, 5, () => {});
    const firstRun = first.run();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(rapidRestart.contexts.length, 1, "first player allocated an AudioContext");
    const closing = first.stop();
    const second = rapidRestart.api.createPlayer(rapidRestart.query, 5, () => {});
    const secondRun = second.run();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(rapidRestart.contexts.length, 1,
        "no new AudioContext before prior close Promise resolves");
    releaseContextClose();
    await closing;
    await assert.rejects(firstRun, /中断|AbortError/);
    await secondRun;
    assert.equal(rapidRestart.contexts.length, 2);
    assert.ok(rapidRestart.contexts.every(ctx => ctx.state === "closed"));
    assert.equal(rapidRestart.listenerStats.active, 0);

    // 読み上げ停止の直後に別の読み上げを開始しても、古い通信とイベントリスナーが
    // 後続の再生へ干渉しない。本文の検証中はまだ音源を予約しない。
    const stopEnv = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) { if (count === 2) return new Promise(() => {}); }
    });
    const oldPlayer = stopEnv.api.createPlayer(stopEnv.query, 5, () => {});
    const oldRun = oldPlayer.run();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(stopEnv.contexts[0]?.sources.length, 0, "incomplete stream is not yet scheduled");
    await oldPlayer.stop();
    await assert.rejects(oldRun, /中断|AbortError/);
    assert.equal(stopEnv.listenerStats.active, 0);
    assert.equal(stopEnv.contexts[0].state, "closed");
    const freshEnv = environment({ responseBytes: wav(3000) });
    await freshEnv.api.createPlayer(freshEnv.query, 5, () => {}).run();
    assert.equal(freshEnv.listenerStats.active, 0);
    assert.equal(freshEnv.contexts[0].state, "closed");

    // ① reader.cancel()が返らない場合でもclose()が先に完了し、
    // 有限時間で失敗を返す。以降の再生は安全性を確認できないため禁止。
    const stuckCancel = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        timerScale: 40,
        onChunk({ count }) { if (count === 2) return new Promise(() => {}); },
        onReaderCancel() { return new Promise(() => {}); }
    });
    const cancelPlayer = stuckCancel.api.createPlayer(stuckCancel.query, 5, () => {});
    const cancelRunning = cancelPlayer.run();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(stuckCancel.contexts.length, 1);
    await assert.rejects(cancelPlayer.stop(), /再読み込み/);
    await assert.rejects(cancelRunning, /再読み込み/);
    assert.equal(stuckCancel.contexts[0].state, "closed",
        "AudioContext closes without waiting for a stuck reader.cancel()");
    assert.equal(stuckCancel.api.cleanupStatus(), "failed");
    assert.equal(stuckCancel.listenerStats.active, 0);
    await assert.rejects(stuckCancel.api.createPlayer(stuckCancel.query, 5, () => {}).run(),
        /再読み込み/, "stuck cancel must not block forever or allow reuse");

    // 標準Fetchで起こり得るAbortErrorでのreader.cancel()拒否は正常な停止として扱う。
    // AudioContextが解放済みなら通常合成・次回ストリーミングを利用可能にする。
    const abortedCancel = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) { if (count === 2) return new Promise(() => {}); },
        onReaderCancel() {
            throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        }
    });
    const abortPlayer = abortedCancel.api.createPlayer(abortedCancel.query, 5, () => {});
    const abortRun = abortPlayer.run();
    await new Promise(resolve => setTimeout(resolve, 15));
    await abortPlayer.stop();
    await assert.rejects(abortRun, /中断|AbortError/);
    assert.equal(abortedCancel.api.cleanupStatus(), "ready");
    assert.equal(abortedCancel.contexts[0].state, "closed");
    assert.equal(abortedCancel.listenerStats.active, 0);
    assert.equal(await abortedCancel.api.waitForCleanup(), undefined);
    await abortedCancel.api.createPlayer(abortedCancel.query, 5, () => {}).stop();
    assert.equal(abortedCancel.api.cleanupStatus(), "ready");

    // 通信エラーでread()とcancel()が同じエラーを返す状態も致命的とは扱わない。
    const networkError = new TypeError("network connection failed");
    const erroredStream = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) { if (count === 2) throw networkError; },
        onReaderCancel() { throw networkError; }
    });
    const erroredPlayer = erroredStream.api.createPlayer(erroredStream.query, 5, () => {});
    await assert.rejects(erroredPlayer.run(), /network connection failed/);
    assert.equal(erroredStream.api.cleanupStatus(), "ready");
    assert.equal(erroredStream.contexts[0].state, "closed");
    assert.equal(erroredPlayer.canFallback, true,
        "prestart network failure must allow normal synthesis after safe cancellation");
    assert.equal(erroredStream.listenerStats.active, 0);
    await erroredStream.api.createPlayer(erroredStream.query, 5, () => {}).stop();

    // Node標準WHATWG ReadableStreamを使い、実際のerrored stateでcancel()が
    // 保持エラーを再度rejectする挙動をプレイヤーと結合して確認する。
    const nativeStreamError = new TypeError("native ReadableStream connection error");
    const nativeErrored = environment({
        responseBytes: wav(45000),
        makeReader({ bytes }) {
            let pushed = false;
            return new ReadableStream({
                pull(controller) {
                    if (!pushed) {
                        pushed = true;
                        controller.enqueue(bytes.subarray(0, 44 + 35000 * 2));
                    } else {
                        controller.error(nativeStreamError);
                    }
                }
            }, { highWaterMark: 0 }).getReader();
        }
    });
    const nativeErroredPlayer = nativeErrored.api.createPlayer(nativeErrored.query, 5, () => {});
    await assert.rejects(nativeErroredPlayer.run(), /native ReadableStream connection error/);
    assert.equal(nativeErrored.api.cleanupStatus(), "ready");
    assert.equal(nativeErroredPlayer.canFallback, true);
    assert.equal(nativeErrored.contexts[0].state, "closed");
    assert.equal(nativeErrored.listenerStats.active, 0);

    // AbortSignalを実際のReadableStream controller.errorに接続する。
    // Fetch相当のabort後、同じReader.cancel()がAbortErrorでrejectしても
    // stop()は成功、次の読み上げは利用できる。
    const nativeAborted = environment({
        responseBytes: wav(45000),
        makeReader({ bytes, signal }) {
            const streamAbortError = Object.assign(
                new Error("native stream aborted"), { name: "AbortError" });
            return new ReadableStream({
                start(controller) {
                    controller.enqueue(bytes.subarray(0, 44 + 35000 * 2));
                    const onAbort = () => {
                        signal.removeEventListener("abort", onAbort);
                        controller.error(streamAbortError);
                    };
                    signal.addEventListener("abort", onAbort, { once: true });
                }
            }, { highWaterMark: 0 }).getReader();
        }
    });
    const nativeAbortPlayer = nativeAborted.api.createPlayer(nativeAborted.query, 5, () => {});
    const nativeAbortRun = nativeAbortPlayer.run();
    for (let attempts = 0; !nativeAborted.contexts[0]; attempts++) {
        assert.ok(attempts < 100, "native ReadableStream should start reading");
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(nativeAborted.contexts[0].sources.length, 0,
        "partial PCM is not scheduled before EOF");
    await nativeAbortPlayer.stop();
    await assert.rejects(nativeAbortRun, /中断|AbortError/);
    assert.equal(nativeAborted.api.cleanupStatus(), "ready");
    assert.equal(nativeAborted.contexts[0].state, "closed");
    assert.equal(nativeAborted.listenerStats.active, 0);

    // 失敗理由がundefined/nullでもTypeErrorで状態設定をスキップしない。
    for (const rejectedReason of [undefined, null]) {
        const primitiveClose = environment({
            responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
            onChunk({ count }) { if (count === 2) return new Promise(() => {}); },
            onContextClose() { return Promise.reject(rejectedReason); }
        });
        const rejectedPlayer = primitiveClose.api.createPlayer(primitiveClose.query, 5, () => {});
        const rejectedRun = rejectedPlayer.run();
        await new Promise(resolve => setTimeout(resolve, 15));
        await assert.rejects(rejectedPlayer.stop(), /再読み込み/);
        await assert.rejects(rejectedRun, /再読み込み/);
        assert.equal(primitiveClose.api.cleanupStatus(), "failed",
            "primitive close rejection must always lock unsafe context");
        await assert.rejects(primitiveClose.api.createPlayer(primitiveClose.query, 5, () => {}).run(),
            /再読み込み/);
        assert.equal(primitiveClose.contexts.length, 1);
        assert.equal(primitiveClose.listenerStats.active, 0);
    }

    // 読取エラーが無いのにcancel()がundefined/nullで拒否したら安全と推定しない。
    for (const rejectedReason of [undefined, null]) {
        const primitiveCancel = environment({
            responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
            onChunk({ count }) { if (count === 2) return new Promise(() => {}); },
            onReaderCancel() { return Promise.reject(rejectedReason); }
        });
        const rejectedPlayer = primitiveCancel.api.createPlayer(primitiveCancel.query, 5, () => {});
        const rejectedRun = rejectedPlayer.run();
        await new Promise(resolve => setTimeout(resolve, 15));
        await assert.rejects(rejectedPlayer.stop(), /再読み込み/);
        await assert.rejects(rejectedRun, /再読み込み/);
        assert.equal(primitiveCancel.api.cleanupStatus(), "failed");
        assert.equal(primitiveCancel.contexts[0].state, "closed");
        assert.equal(primitiveCancel.listenerStats.active, 0);
    }

    // WHATWG ReadableStreamのnull読取理由と同じcancel拒否は正常な終了理由として扱う。
    let nullReasonReader;
    const nullRead = environment({
        responseBytes: wav(45000),
        makeReader({ bytes }) {
            let sent = false;
            const stream = new ReadableStream({
                pull(controller) {
                    if (!sent) {
                        sent = true;
                        controller.enqueue(bytes.subarray(0, 44 + 35000 * 2));
                    } else {
                        controller.error(null);
                    }
                }
            }, { highWaterMark: 0 });
            nullReasonReader = stream;
            return stream.getReader();
        }
    });
    const nullReadPlayer = nullRead.api.createPlayer(nullRead.query, 5, () => {});
    let nullReadFailure = "not rejected";
    try { await nullReadPlayer.run(); } catch (error) { nullReadFailure = error; }
    assert.equal(nullReadFailure, null, "a null read rejection must remain a handled rejection");
    assert.equal(nullRead.api.cleanupStatus(), "ready");
    assert.equal(nullReadPlayer.canFallback, true);
    assert.equal(nullReasonReader.locked, false, "errored reader lock is released after cleanup");

    // AudioContext.close()の拒否値がundefinedでもReader.releaseLock()は必ず実行する。
    let nativeLockStream;
    const closeFailureRelease = environment({
        responseBytes: wav(45000),
        makeReader({ bytes }) {
            nativeLockStream = new ReadableStream({
                start(controller) { controller.enqueue(bytes.subarray(0, 44 + 35000 * 2)); }
            }, { highWaterMark: 0 });
            return nativeLockStream.getReader();
        },
        onContextClose() { return Promise.reject(undefined); }
    });
    const closeFailurePlayer = closeFailureRelease.api.createPlayer(
        closeFailureRelease.query, 5, () => {});
    const closeFailureRun = closeFailurePlayer.run();
    for (let attempts = 0; !closeFailureRelease.contexts[0]; attempts++) {
        assert.ok(attempts < 100, "native reader must start before STOP");
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    await assert.rejects(closeFailurePlayer.stop(), /再読み込み/);
    await assert.rejects(closeFailureRun, /再読み込み/);
    assert.equal(closeFailureRelease.api.cleanupStatus(), "failed");
    assert.equal(nativeLockStream.locked, false,
        "Reader release must run even when AudioContext.close() rejects");

    // 停止と再開を50回繰り返しても以前のreader / AudioContextは残さない。
    const repeated = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) { if (count === 2) return new Promise(() => {}); },
        onReaderCancel() {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
    });
    for (let n = 0; n < 50; n++) {
        const item = repeated.api.createPlayer(repeated.query, 5, () => {});
        const running = item.run();
        for (let spin = 0; repeated.contexts.length <= n; spin++) {
            assert.ok(spin < 200, "iteration " + n + " must start reading");
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        await item.stop();
        await assert.rejects(running, /中断|AbortError/);
        assert.equal(repeated.api.cleanupStatus(), "ready");
        assert.equal(repeated.listenerStats.active, 0);
        assert.equal(repeated.contexts[n].state, "closed");
        assert.equal(repeated.contexts[n].sources.length, 0,
            "stopped incomplete streams must never schedule PCM");
    }
    assert.equal(repeated.contexts.length, 50);

    // ② close()が拒否された場合はSTOP失敗を返し、次のAudioContextを作らない。
    const failedClose = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) { if (count === 2) return new Promise(() => {}); },
        onContextClose() { throw new Error("audio device close refused"); }
    });
    const failurePlayer = failedClose.api.createPlayer(failedClose.query, 5, () => {});
    const failureRunning = failurePlayer.run();
    await new Promise(resolve => setTimeout(resolve, 15));
    await assert.rejects(failurePlayer.stop(), /再読み込み/);
    await assert.rejects(failureRunning, /再読み込み/);
    assert.equal(failedClose.api.cleanupStatus(), "failed");
    assert.equal(failedClose.contexts.length, 1);
    await assert.rejects(failedClose.api.createPlayer(failedClose.query, 5, () => {}).run(),
        /再読み込み/);
    assert.equal(failedClose.contexts.length, 1, "no second AudioContext after close failure");
    assert.equal(failedClose.listenerStats.active, 0);

    // ③ close()が永久に未解決でも、停止完了応答は期限付きで失敗し再生を禁止。
    const stuckClose = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        timerScale: 100,
        onChunk({ count }) { if (count === 2) return new Promise(() => {}); },
        onContextClose() { return new Promise(() => {}); }
    });
    const closingPlayer = stuckClose.api.createPlayer(stuckClose.query, 5, () => {});
    const closingRun = closingPlayer.run();
    await new Promise(resolve => setTimeout(resolve, 15));
    await assert.rejects(closingPlayer.stop(), /再読み込み/);
    await assert.rejects(closingRun, /再読み込み/);
    assert.equal(stuckClose.api.cleanupStatus(), "failed");
    assert.equal(stuckClose.contexts.length, 1);
    await assert.rejects(stuckClose.api.createPlayer(stuckClose.query, 5, () => {}).run(),
        /再読み込み/);
    assert.equal(stuckClose.listenerStats.active, 0);

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
