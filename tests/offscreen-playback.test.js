const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
let listener;
let audioMode = 'error';
let normalSynthesisCalls = 0;
const notifications = [];

class MockAudio {
    constructor(url) { this.url = url; this.error = { code: 3, message: 'decode failed' }; }
    play() {
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
    console, chrome, Audio: MockAudio, setTimeout, clearTimeout, setImmediate, Promise,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 100,
    VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100, OCR_WORKER_IDLE_RELEASE_MS: 1000,
    OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (url) => {
        if (url.includes('/synthesis?')) normalSynthesisCalls++;
        return { ok: true, status: 200, marker: url.includes('audio_query') ? 'json' : 'blob' };
    },
    readJsonResponseWithLimit: async () => ({ accent_phrases: [] }), readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    createPrimaryOcrProgressTracker: () => ({ reset() {}, update: () => null }),
    recognizeWithOrientation: async () => ({ text: '', confidence: 0 }),
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 1, height: 1 }),
    fetch: async () => ({ blob: async () => ({}) })
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
assert.strictEqual(typeof listener, 'function');

function enqueue(text, mode) {
    return new Promise((resolve) => {
        listener({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts: [text], settings: {
            speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
            pauseLengthScale: 1, synthesisMode: mode
        } }, { id: 'ext-id' }, resolve);
    });
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

    // 既存設定を持たないユーザーには新しい合成方式を適用しない。
    let checks = 0;
    let streamAttempts = 0;
    let streamStarted = false;
    const realStreaming = context.VVRadioStreaming;
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
    context.readJsonResponseWithLimit = async () => ({
        accent_phrases: [], outputSamplingRate: 24000, outputStereo: false
    });
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
                start(at) { this.at = at; ctx.sources.push(this); },
                stop() { this.cancelled = true; }
            };
        }
        async close() { this.state = 'closed'; }
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
    context.AudioContext = class extends IntegratedAudioContext {
        constructor() { super(); integratedContext = this; }
    };
    context.fetch = async url => {
        const pathName = new URL(url).pathname;
        if (pathName === '/engine_manifest') {
            return { ok: true, payload: { supported_features: { streaming_synthesis: true } } };
        }
        if (pathName === '/speakers') {
            return { ok: true, payload: [{ styles: [{ id: 1, type: 'streaming_talk' }] }] };
        }
        if (pathName === '/version') return { ok: true, payload: '0.26.0' };
        if (pathName !== '/streaming_synthesis') throw new Error('unexpected endpoint: ' + pathName);
        integratedStreamRequests++;
        let readCount = 0;
        return {
            ok: true,
            headers: { get: () => String(wavBytes.length) },
            body: { getReader() {
                return {
                    async read() {
                        readCount++;
                        if (readCount === 1) {
                            return { done: false, value: wavBytes.subarray(0, 44 + 35000 * 2) };
                        }
                        integratedContext.forcedClock =
                            integratedContext.sources[0].at + (integratedStreamRequests === 1 ? -0.005 : 0.005);
                        throw new Error('injected boundary transport failure');
                    },
                    async cancel() {},
                    releaseLock() {}
                };
            } }
        };
    };
    notifications.length = 0;
    const synthesisBeforeEdge = normalSynthesisCalls;
    response = await enqueue('real player prestart 5ms', 'auto');
    assert.strictEqual(response.success, true);
    await wait();
    assert.strictEqual(integratedStreamRequests, 1);
    assert.strictEqual(normalSynthesisCalls, synthesisBeforeEdge + 1,
        'real stream player at 5ms before start must retry /synthesis once');
    assert.ok(integratedContext.sources.every(src => src.cancelled));
    assert.strictEqual(integratedContext.state, 'closed');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ENDED'));
    assert.ok(!notifications.some(m => m.type === 'PLAYBACK_ERROR'),
        'successful boundary cancellation must not cause missing-audio error');

    context.VVRadioStreaming.invalidate(1);
    notifications.length = 0;
    const synthesisBeforeAudible = normalSynthesisCalls;
    response = await enqueue('real player after audio start', 'auto');
    assert.strictEqual(response.success, true);
    await wait();
    assert.strictEqual(integratedStreamRequests, 2);
    assert.strictEqual(normalSynthesisCalls, synthesisBeforeAudible,
        'once audio start time has passed, never restart from the first PCM');
    assert.ok(notifications.some(m => m.type === 'PLAYBACK_ERROR'));

    console.log('offscreen playback terminal states and stream fallback: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
