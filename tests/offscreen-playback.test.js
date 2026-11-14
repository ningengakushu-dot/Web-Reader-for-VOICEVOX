const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
let listener;
let audioMode = 'error';
let normalSynthesisCalls = 0;
let failNextNormalSynthesis = false;
let rejectNextQuery = null;
let revokedUrls = 0;
const notifications = [];

class MockAudio {
    constructor(url) { this.url = url; this.error = { code: 3, message: 'decode failed' }; }
    play() {
        if (audioMode === 'reject-null') return Promise.reject(null);
        if (audioMode === 'reject-undefined') return Promise.reject(undefined);
        if (audioMode === 'error-and-reject') {
            this.onerror?.({ type: 'error' });
            return Promise.reject(undefined);
        }
        setImmediate(() => {
            if (audioMode === 'error') this.onerror?.({ type: 'error' });
            else this.onended?.();
        });
        return Promise.resolve();
    }
    pause() {}
    removeAttribute() {}
    load() {}
}

const chrome = {
    runtime: {
        id: 'ext-id',
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage(message) { notifications.push(message); return Promise.resolve(); }
    }
};
const context = vm.createContext({
    console, chrome, Audio: MockAudio, AbortController, Uint8Array, DataView,
    setTimeout, clearTimeout, setImmediate, Promise,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() { revokedUrls++; } },
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 100,
    VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100, OCR_WORKER_IDLE_RELEASE_MS: 1000,
    OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (url) => {
        if (url.includes('/audio_query?') && rejectNextQuery) {
            const { reason } = rejectNextQuery;
            rejectNextQuery = null;
            throw reason;
        }
        if (url.includes('/synthesis?')) {
            normalSynthesisCalls++;
            if (failNextNormalSynthesis) {
                failNextNormalSynthesis = false;
                throw new Error('injected normal synthesis failure');
            }
        }
        return { ok: true, status: 200, marker: url.includes('audio_query') ? 'json' : 'blob' };
    },
    readJsonResponseWithLimit: async () => ({ accent_phrases: [] }), readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    createPrimaryOcrProgressTracker: () => ({ reset() {}, update: () => null }),
    recognizeWithOrientation: async () => ({ text: '', confidence: 0 }),
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 1, height: 1 }),
    fetch: async (url) => url.includes('/audio_query')
        ? { ok: true, payload: { accent_phrases: [] } }
        : { blob: async () => ({}) }
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
assert.strictEqual(typeof listener, 'function');

function request(message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message.type + ' did not respond')), 500);
        listener({ ...message, target: 'offscreen' }, { id: 'ext-id' }, response => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

function enqueue(text, mode) {
    return request({ type: 'ENQUEUE_TEXTS', texts: [text], settings: {
        speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
        pauseLengthScale: 1, synthesisMode: mode
    } });
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 30));

(async () => {
    let response = await enqueue('error case');
    assert.strictEqual(response.success, true);
    await wait();
    assert.ok(notifications.some((m) => m.type === 'PLAYBACK_ERROR'));
    assert.ok(!notifications.some((m) => m.type === 'PLAYBACK_ENDED'),
        'audio errors must not be immediately overwritten by PLAYBACK_ENDED');

    notifications.length = 0;
    audioMode = 'ended';
    response = await enqueue('normal case');
    assert.strictEqual(response.success, true);
    await wait();
    assert.ok(notifications.some((m) => m.type === 'PLAYBACK_ENDED'),
        'normal completion must still emit PLAYBACK_ENDED');

    for (const reason of [null, undefined]) {
        notifications.length = 0;
        rejectNextQuery = { reason };
        const beforeSynthesis = normalSynthesisCalls;
        assert.strictEqual((await enqueue('normal query rejected')).success, true);
        await wait();
        assert.deepStrictEqual(notifications.map(m => m.type), ['PLAYBACK_ERROR']);
        assert.strictEqual(notifications[0].error, '合成失敗: ' + String(reason));
        assert.strictEqual(normalSynthesisCalls, beforeSynthesis, 'failed query must not be retried');
    }

    for (const mode of ['reject-null', 'reject-undefined', 'error-and-reject']) {
        notifications.length = 0;
        audioMode = mode;
        const beforeRevoke = revokedUrls;
        assert.strictEqual((await enqueue('normal playback rejected')).success, true);
        await wait();
        assert.deepStrictEqual(notifications.map(m => m.type), ['PLAYBACK_STARTED', 'PLAYBACK_ERROR']);
        assert.strictEqual(revokedUrls, beforeRevoke + 1);
        assert.strictEqual(vm.runInContext('isPlaying || currentAudio !== null || currentAudioUrl !== null',
            context), false, 'playback failure must clear the current audio');
    }
    audioMode = 'ended';

    const realStreaming = context.VVRadioStreaming;
    for (const reason of [null, undefined]) {
        context.VVRadioStreaming = {
            cleanupStatus: () => 'pending',
            waitForCleanup: () => Promise.reject(reason)
        };
        for (const reply of [await enqueue('pending cleanup'), await request({ type: 'STOP_AUDIO' })]) {
            assert.strictEqual(reply.success, false);
            assert.strictEqual(reply.error, String(reason));
        }
    }
    context.VVRadioStreaming = realStreaming;

    // 既存設定を持たないユーザーには新しい合成方式を適用しない。
    let checks = 0;
    let streamAttempts = 0;
    let streamStarted = false;
    context.VVRadioStreaming = {
        supports: async () => { checks++; return true; },
        suppress() {},
        createPlayer: () => ({
            get started() { return streamStarted; },
            get canFallback() { return !streamStarted; },
            async run() { streamAttempts++; throw new Error('stream transport failed'); },
            async stop() {}
        })
    };
    notifications.length = 0;
    const beforeNormal = normalSynthesisCalls;
    response = await enqueue('legacy user without mode');
    await wait();
    assert.strictEqual(checks, 0, 'an old installation must not probe or enable streaming');
    assert.strictEqual(normalSynthesisCalls, beforeNormal + 1,
        'legacy settings must continue using /synthesis');

    // 再生開始前だけ通常合成へ戻し、同じテキストを欠落させずに再生する。
    notifications.length = 0;
    const beforeFallback = normalSynthesisCalls;
    response = await enqueue('streaming fallback', 'auto');
    await wait();
    assert.strictEqual(streamAttempts, 1);
    assert.strictEqual(normalSynthesisCalls, beforeFallback + 1,
        'a failed pre-start stream must fall back exactly once');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ENDED'));
    assert.ok(!notifications.some(m => m.type === 'PLAYBACK_ERROR'),
        'successful pre-start fallback must not emit a spurious error');

    // 音声再生開始後に失敗したら先頭から重複して再生しない。
    notifications.length = 0;
    const beforeMidstream = normalSynthesisCalls;
    streamStarted = true;
    response = await enqueue('streaming already audible', 'auto');
    await wait();
    assert.strictEqual(streamAttempts, 2);
    assert.strictEqual(normalSynthesisCalls, beforeMidstream,
        'already audible speech must never restart from its beginning');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ERROR'));

    // 実VVRadioStreamingを結合し、AudioContextの予約時刻5ms前のエラーが
    // processPlaybackの通常合成復帰へ実際につながることを確認する。
    context.VVRadioStreaming = realStreaming;
    context.readJsonResponseWithLimit = async response => response.payload ?? ({
        accent_phrases: [], outputSamplingRate: 24000, outputStereo: false
    });
    let closeBarrier = null;
    let rejectClose = false;
    let holdNextRead = false;
    let failStartTimerMode = null;
    class IntegratedAudioContext {
        constructor() {
            this.origin = Date.now();
            this.state = 'running';
            this.destination = {};
            this.sources = [];
            this.forcedClock = null;
        }
        get currentTime() {
            return this.forcedClock ?? (Date.now() - this.origin) / 1000;
        }
        async resume() { this.state = 'running'; }
        createAnalyser() {
            return { fftSize: 16384, connect() {}, getFloatTimeDomainData(data) { data.fill(0); } };
        }
        createBuffer(channels, frames, rate) {
            const channelsData = Array.from({ length: channels }, () => new Float32Array(frames));
            return {
                duration: frames / rate,
                getChannelData(i) { return channelsData[i]; }
            };
        }
        createBufferSource() {
            const ctx = this;
            return {
                buffer: null, onended: null, connect() {}, disconnect() {},
                start(at) {
                    this.at = at;
                    ctx.sources.push(this);
                    if (streamReaderMode === 'short') {
                        setTimeout(() => this.onended?.(), 70);
                    }
                },
                stop() { this.cancelled = true; }
            };
        }
        async close() {
            if (closeBarrier) await closeBarrier;
            if (rejectClose) throw new Error('close device rejected');
            this.state = 'closed';
        }
    }
    const wavBytes = new Uint8Array(44 + 45000 * 2);
    const view = new DataView(wavBytes.buffer);
    const ascii = (at, str) => [...str].forEach((c, i) => wavBytes[at + i] = c.charCodeAt(0));
    ascii(0, 'RIFF'); view.setUint32(4, wavBytes.length - 8, true);
    ascii(8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, wavBytes.length - 44, true);
    context.AudioContext = IntegratedAudioContext;
    let integratedContext;
    let integratedStreamRequests = 0;
    let activeServerRequests = 0;
    let preparationBlock = null;
    let streamReaderMode = null;
    let streamReadCalls = 0;
    context.AudioContext = class extends IntegratedAudioContext {
        constructor() { super(); integratedContext = this; }
    };
    context.setTimeout = (callback, ms, ...args) => {
        if (failStartTimerMode && callback.name === 'reportActualStart') {
            integratedContext.forcedClock = integratedContext.sources[0].at
                + (failStartTimerMode === 'after' ? 0.005 : -0.005);
            throw new Error('injected start boundary failure');
        }
        return setTimeout(callback, ms, ...args);
    };
    context.fetch = async (url, options = {}) => {
        const pathName = new URL(url).pathname;
        if (preparationBlock?.path === pathName) {
            preparationBlock.started++;
            preparationBlock.active++;
            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    options.signal?.removeEventListener('abort', onAbort);
                    preparationBlock.active--;
                    reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
                };
                options.signal?.addEventListener('abort', onAbort, { once: true });
            });
        }
        if (pathName === '/engine_manifest') {
            return { ok: true, payload: { supported_features: { streaming_synthesis: true } } };
        }
        if (pathName === '/speakers') {
            return { ok: true, payload: [{ styles: [{ id: 1, type: 'streaming_talk' }] }] };
        }
        if (pathName === '/version') return { ok: true, payload: '0.26.0' };
        if (pathName === '/audio_query') return { ok: true, payload: {
            accent_phrases: [], outputSamplingRate: 24000, outputStereo: false
        } };
        if (pathName !== '/streaming_synthesis') throw new Error('unexpected endpoint: ' + pathName);
        integratedStreamRequests++;
        if (['empty', 'long', 'short'].includes(streamReaderMode)) {
            const frames = { empty: 0, long: 24000 * 6, short: 240 }[streamReaderMode];
            const wave = new Uint8Array(44 + frames * 2);
            wave.set(wavBytes.subarray(0, 44));
            const headerView = new DataView(wave.buffer);
            headerView.setUint32(4, wave.length - 8, true);
            headerView.setUint32(40, frames * 2, true);
            let sent = false;
            return {
                ok: true,
                headers: { get: () => String(wave.length) },
                body: { getReader: () => ({
                    async read() {
                        if (sent) return { done: true };
                        sent = true;
                        return { done: false, value: wave };
                    },
                    async cancel() {},
                    releaseLock() {}
                }) }
            };
        }
        if (streamReaderMode === 'null-read') {
            let firstRead = true;
            return {
                ok: true,
                headers: { get: () => String(wavBytes.length) },
                body: { getReader() {
                    return {
                        read() {
                            if (firstRead) {
                                firstRead = false;
                                return Promise.resolve({ done: false,
                                    value: wavBytes.subarray(0, 44 + 35000 * 2) });
                            }
                            return Promise.reject(null);
                        },
                        cancel() { return Promise.reject(null); },
                        releaseLock() {}
                    };
                } }
            };
        }
        let readCount = 0;
        let requestOpen = true;
        const finishRequest = () => {
            if (!requestOpen) return;
            requestOpen = false;
            activeServerRequests--;
        };
        activeServerRequests++;
        return {
            ok: true,
            headers: { get: () => String(wavBytes.length) },
            body: { getReader() {
                let abortRead = null;
                const onAbort = () => abortRead?.();
                options.signal?.addEventListener('abort', onAbort, { once: true });
                return {
                    async read() {
                        readCount++;
                        streamReadCalls++;
                        if (readCount === 1) {
                            return { done: false, value: wavBytes };
                        }
                        if (holdNextRead) return new Promise((resolve, reject) => {
                            abortRead = () => {
                                abortRead = null;
                                finishRequest();
                                reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
                            };
                        });
                        options.signal?.removeEventListener('abort', onAbort);
                        finishRequest();
                        return { done: true };
                    },
                    async cancel() { options.signal?.removeEventListener('abort', onAbort); finishRequest(); },
                    releaseLock() { options.signal?.removeEventListener('abort', onAbort); }
                };
            } }
        };
    };
    notifications.length = 0;
    failStartTimerMode = 'before';
    const synthesisBeforeEdge = normalSynthesisCalls;
    response = await enqueue('real player prestart 5ms', 'auto');
    assert.strictEqual(response.success, true);
    await wait();
    assert.strictEqual(integratedStreamRequests, 1);
    assert.strictEqual(normalSynthesisCalls, synthesisBeforeEdge + 1,
        'real stream player at 5ms before start must retry /synthesis once');
    assert.ok(integratedContext.sources[0].cancelled);
    assert.strictEqual(integratedContext.state, 'closed');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ENDED'));
    assert.ok(!notifications.some(m => m.type === 'PLAYBACK_ERROR'),
        'successful boundary cancellation must not cause missing-audio error');

    failStartTimerMode = null;
    context.VVRadioStreaming.invalidate(1);
    notifications.length = 0;
    failStartTimerMode = 'after';
    const synthesisBeforeAudible = normalSynthesisCalls;
    response = await enqueue('real player after audio start', 'auto');
    assert.strictEqual(response.success, true);
    await wait();
    assert.strictEqual(integratedStreamRequests, 2);
    assert.strictEqual(normalSynthesisCalls, synthesisBeforeAudible,
        'once audio start time has passed, never restart from the first PCM');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ERROR'));

    failStartTimerMode = null;

    const waitUntil = async (predicate, message) => {
        for (let attempts = 0; !predicate(); attempts++) {
            assert.ok(attempts < 200, message);
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    };
    const requestStop = () => new Promise(resolve => {
        const keep = listener({ type: 'STOP_AUDIO', target: 'offscreen' },
            { id: 'ext-id' }, resolve);
        assert.strictEqual(keep, true, 'STOP_AUDIO keeps the response port open');
    });
    const checkPreparationStop = async pathName => {
        preparationBlock = { path: pathName, started: 0, active: 0 };
        context.VVRadioStreaming.invalidate(1);
        response = await enqueue('stop during ' + pathName, 'auto');
        assert.strictEqual(response.success, true);
        await waitUntil(() => preparationBlock.started > 0, pathName + ' request did not start');
        const stopped = await requestStop();
        assert.strictEqual(stopped.success, true, pathName + ' stop must finish successfully');
        assert.strictEqual(preparationBlock.active, 0,
            pathName + ' communication must be closed before STOP_AUDIO succeeds');
        preparationBlock = null;
        const beforeRestart = normalSynthesisCalls;
        assert.strictEqual((await enqueue('immediate restart after ' + pathName, 'normal')).success, true);
        await wait();
        assert.strictEqual(normalSynthesisCalls, beforeRestart + 1,
            'immediate restart must use the normal path after ' + pathName);
    };

    await checkPreparationStop('/engine_manifest');
    await checkPreparationStop('/audio_query');

    // PCM受信中の停止も通信終了を待ってから成功し、直後の読み上げを受け付ける。
    context.VVRadioStreaming.invalidate(1);
    integratedContext = null;
    holdNextRead = true;
    const beforePcmRead = streamReadCalls;
    response = await enqueue('stop during PCM receive', 'auto');
    assert.strictEqual(response.success, true);
    await waitUntil(() => streamReadCalls >= beforePcmRead + 2,
        'PCM receive did not reach the pending EOF read');
    assert.equal(integratedContext.sources.length, 0,
        'partial PCM stays buffered until the response reaches EOF');
    assert.strictEqual(activeServerRequests, 1, 'stream request remains open during PCM receive');
    const pcmStop = await requestStop();
    assert.strictEqual(pcmStop.success, true);
    assert.strictEqual(activeServerRequests, 0,
        'the old stream request must close before STOP_AUDIO succeeds');
    holdNextRead = false;
    assert.strictEqual((await enqueue('immediate restart after PCM receive', 'normal')).success, true);
    await wait();

    notifications.length = 0;
    context.VVRadioStreaming.invalidate(1);
    streamReaderMode = 'empty';
    const beforeEmpty = normalSynthesisCalls;
    const beforeEmptyStream = integratedStreamRequests;
    integratedContext = null;
    assert.strictEqual((await enqueue('empty stream fallback', 'auto')).success, true);
    await wait();
    assert.strictEqual(integratedStreamRequests, beforeEmptyStream + 1);
    assert.strictEqual(normalSynthesisCalls, beforeEmpty + 1);
    assert.strictEqual(integratedContext, null, 'empty PCM must be rejected before AudioContext creation');
    assert.deepStrictEqual(notifications.map(m => m.type), ['PLAYBACK_STARTED', 'PLAYBACK_ENDED'],
        'only the normal fallback may emit playback events');
    streamReaderMode = null;

    notifications.length = 0;
    context.VVRadioStreaming.invalidate(1);
    const beforeLong = normalSynthesisCalls;
    const beforeLongStream = integratedStreamRequests;
    streamReaderMode = 'long';
    assert.strictEqual((await enqueue('over five seconds', 'auto')).success, true);
    await waitUntil(() => notifications.some(m => m.type === 'PLAYBACK_ENDED'), 'long fallback must end');
    assert.strictEqual(normalSynthesisCalls, beforeLong + 1);
    assert.strictEqual(integratedStreamRequests, beforeLongStream + 1);

    notifications.length = 0;
    streamReaderMode = 'short';
    assert.strictEqual((await enqueue('short after long', 'auto')).success, true);
    await waitUntil(() => notifications.some(m => m.type === 'PLAYBACK_ENDED'), 'short stream must end');
    assert.strictEqual(integratedStreamRequests, beforeLongStream + 2,
        'the preceding length limit must not disable streaming for the same speaker');
    assert.strictEqual(normalSynthesisCalls, beforeLong + 1);
    assert.deepStrictEqual(notifications.map(m => m.type), ['PLAYBACK_STARTED', 'PLAYBACK_ENDED']);
    streamReaderMode = null;

    // null読取拒否と同じnull cancel拒否は安全な終了理由として扱う。
    // 通常合成も失敗させ、拒否値を文字列化するエラー通知が一度だけ届くことを確認する。
    context.VVRadioStreaming.invalidate(1);
    streamReaderMode = 'null-read';
    failNextNormalSynthesis = true;
    notifications.length = 0;
    const beforeNullFallback = normalSynthesisCalls;
    assert.strictEqual((await enqueue('null read and cancel reason', 'auto')).success, true);
    await wait();
    streamReaderMode = null;
    assert.strictEqual(normalSynthesisCalls, beforeNullFallback + 1);
    assert.equal(notifications.filter(message => message.type === 'PLAYBACK_ERROR').length, 1,
        'null rejection values must produce one PLAYBACK_ERROR');
    assert.equal(notifications.filter(message => message.type === 'PLAYBACK_ENDED').length, 0,
        'failed normal fallback must not also report PLAYBACK_ENDED');

    // STOP_AUDIO成功を、音声Contextの非同期close終了より前に返さないこと。
    // 同じOffscreen VM内でSTOP中に到着した通常合成も終了まで保留する。
    let releaseClose;
    closeBarrier = new Promise(resolve => { releaseClose = resolve; });
    holdNextRead = false;
    context.VVRadioStreaming.invalidate(1);
    integratedContext = null;
    const beforeStopSynth = normalSynthesisCalls;
    response = await enqueue('stream playing before STOP_AUDIO', 'auto');
    assert.strictEqual(response.success, true);
    await waitUntil(() => integratedContext?.state === 'running'
        && integratedContext.sources.length > 0, 'stream playback must begin before STOP_AUDIO');
    let stopResponse;
    let stopReturn;
    const stopReply = new Promise(resolve => {
        stopReturn = listener({ type: 'STOP_AUDIO', target: 'offscreen' },
            { id: 'ext-id' }, result => { stopResponse = result; resolve(result); });
    });
    assert.strictEqual(stopReturn, true, 'STOP_AUDIO must keep the response port open');
    let waitingEnqueueResult;
    const waitingEnqueue = enqueue('queued normal after stop').then(result => {
        waitingEnqueueResult = result;
        return result;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(stopResponse, undefined, 'STOP success before close completion is forbidden');
    assert.strictEqual(waitingEnqueueResult, undefined,
        'a new normal synthesis must wait for prior AudioContext close');
    assert.strictEqual(normalSynthesisCalls, beforeStopSynth);
    releaseClose();
    assert.strictEqual((await stopReply).success, true);
    assert.strictEqual((await waitingEnqueue).success, true);
    await wait();
    assert.strictEqual(normalSynthesisCalls, beforeStopSynth + 1);
    assert.ok(!notifications.some(m => m.type === 'PLAYBACK_STOPPED'), 'STOP_AUDIO reports through its response');

    // close()失敗後はSTOP_AUDIO失敗を返し、通常合成まで禁止する。
    closeBarrier = null;
    rejectClose = true;
    holdNextRead = false;
    context.VVRadioStreaming.invalidate(1);
    integratedContext = null;
    response = await enqueue('close fails on STOP_AUDIO', 'auto');
    assert.strictEqual(response.success, true);
    await waitUntil(() => integratedContext?.state === 'running'
        && integratedContext.sources.length > 0, 'stream playback must begin before close failure');
    const failedStop = await new Promise(resolve => {
        const keep = listener({ type: 'STOP_AUDIO', target: 'offscreen' },
            { id: 'ext-id' }, resolve);
        assert.strictEqual(keep, true);
    });
    assert.strictEqual(failedStop.success, false);
    assert.match(failedStop.error, /再読み込み/);
    const beforeBlockedEnqueue = normalSynthesisCalls;
    const blockedEnqueue = await enqueue('normal must be blocked after failed close');
    assert.strictEqual(blockedEnqueue.success, false);
    assert.strictEqual(normalSynthesisCalls, beforeBlockedEnqueue);

    console.log('offscreen playback terminal states and stream fallback: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
