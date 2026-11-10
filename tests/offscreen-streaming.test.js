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
    onContextClose = null, onSourceStop = null, onReaderCancel = null } = {}) {
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
    function streamResponse() {
        const request = ++requestNo;
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
                        if (onChunk) await onChunk({ count, at, contexts, request });
                        const chunk = input.subarray(at, Math.min(input.length, at + size));
                        at += chunk.length;
                        return { done: false, value: chunk };
                    },
                    async cancel() {
                        if (onReaderCancel) await onReaderCancel({ request, contexts });
                    },
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
    assert.equal(earlyPlayer.canFallback, true, "cancelled prestart source allows normal synthesis");
    assert.equal(earlyFailure.contexts[0].sources.every(s => s.stopped), true);
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
    assert.equal(edgePlayer.canFallback, false);
    assert.equal(edgeFailure.contexts[0].state, "closed");
    assert.equal(edgeFailure.listenerStats.active, 0);

    // 開始5ms前: 予約音源を確実に停止してから通常合成へ復帰できること。
    // 従来テストはここを「started=true」として音声欠落を許していた。
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
    assert.equal(boundaryPlayer.started, false,
        "5ms before first output is not audible after cancellation");
    assert.equal(boundaryPlayer.canFallback, true,
        "5ms boundary must allow normal synthesis after successful cancellation");
    assert.equal(boundaryGuard.contexts[0].sources.every(s => s.stopped), true);
    assert.equal(boundaryGuard.contexts[0].state, "closed");
    assert.equal(boundaryGuard.listenerStats.active, 0);

    // 一つでも予約取消しに失敗したら、安全を証明できないので二重再生を禁止する。
    const cancelFail = environment({
        responseBytes: wav(45000), chunkSizes: [44 + 35000 * 2, 100000],
        onChunk({ count }) { if (count === 2) throw new Error("prestart error"); },
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
