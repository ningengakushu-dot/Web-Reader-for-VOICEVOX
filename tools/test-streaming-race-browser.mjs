import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('./ocr-e2e/package.json', import.meta.url))('playwright-core');
const executablePath = process.env.OCR_CHROMIUM
    || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const source = readFileSync(new URL('../offscreen-streaming.js', import.meta.url), 'utf8');
const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><button id="start">start</button>');
});
const frames = 24000;
const wav = Buffer.alloc(44 + frames * 2);
const ascii = (offset, value) => [...value].forEach((character, index) => {
    wav[offset + index] = character.charCodeAt(0);
});
ascii(0, 'RIFF'); wav.writeUInt32LE(wav.length - 8, 4);
ascii(8, 'WAVEfmt '); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
ascii(36, 'data'); wav.writeUInt32LE(wav.length - 44, 40);
for (let index = 0; index < frames; index++) {
    wav.writeInt16LE(Math.round(Math.sin(index * Math.PI / 12) * 12000), 44 + index * 2);
}

let browser;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath, headless: true,
        args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ content: source });
    await page.evaluate(({ baseUrl, wavBytes }) => {
        const bytes = Uint8Array.from(wavBytes);
        const probe = globalThis.streamingProbe = {
            analyserReads: [], context: null, startAt: null, stopPromise: null, player: null
        };
        globalThis.VOICEVOX_BASE_URL = baseUrl;

        const NativeAbortController = globalThis.AbortController;
        globalThis.AbortController = class SlowAbortController extends NativeAbortController {
            abort(reason) {
                const began = performance.now();
                probe.audioClockBeforeAbort = probe.context.currentTime;
                const until = began + 120;
                while (performance.now() < until) {}
                probe.abortDelayMs = performance.now() - began;
                probe.audioClockAfterAbort = probe.context.currentTime;
                return super.abort(reason);
            }
        };

        const NativeAudioContext = globalThis.AudioContext;
        globalThis.AudioContext = class ProbeAudioContext extends NativeAudioContext {
            constructor(options) {
                super(options);
                probe.context = this;
            }
            createAnalyser() {
                const analyser = super.createAnalyser();
                const read = analyser.getFloatTimeDomainData.bind(analyser);
                analyser.getFloatTimeDomainData = data => {
                    read(data);
                    probe.clockAtCheck = probe.context.currentTime;
                    probe.analyserReads.push(data.some(sample => sample !== 0));
                };
                return analyser;
            }
        };

        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (at) {
            const result = start.call(this, at);
            if (probe.startAt === null) {
                probe.startAt = at;
                queueMicrotask(() => {
                    if (!probe.stopPromise) probe.stopPromise = probe.player.stop();
                });
            }
            return result;
        };

        globalThis.fetch = async (url) => {
            if (!new URL(url).pathname.endsWith('/streaming_synthesis')) {
                throw new Error('unexpected fetch: ' + url);
            }
            const body = new ReadableStream({
                start(controller) { controller.enqueue(bytes); controller.close(); }
            });
            return new Response(body, { status: 200,
                headers: { 'content-length': String(bytes.byteLength) } });
        };

        document.querySelector('#start').addEventListener('click', () => {
            probe.player = globalThis.VVRadioStreaming.createPlayer({
                outputSamplingRate: 24000, outputStereo: false
            }, 1, () => { probe.playbackStarted = true; });
            probe.runPromise = probe.player.run().then(
                () => ({ resolved: true }),
                error => ({ resolved: false, message: String(error?.message ?? error) })
            );
            probe.done = (async () => {
                const run = await probe.runPromise;
                await probe.stopPromise;
                return {
                    run, canFallback: probe.player.canFallback,
                    started: probe.player.started,
                    playbackStarted: probe.playbackStarted === true,
                    startAt: probe.startAt,
                    clockAtCheck: probe.clockAtCheck,
                    audioClockBeforeAbort: probe.audioClockBeforeAbort,
                    audioClockAfterAbort: probe.audioClockAfterAbort,
                    abortDelayMs: probe.abortDelayMs,
                    analyserReads: probe.analyserReads
                };
            })();
        });
    }, { baseUrl: `http://127.0.0.1:${server.address().port}`, wavBytes: [...wav] });

    await page.click('#start');
    const result = await page.evaluate(() => streamingProbe.done);
    assert.equal(result.run.resolved, false, 'the user stop interrupts the pending player run');
    assert.ok(result.startAt > result.clockAtCheck,
        'the stop check happens before the scheduled audio-clock boundary');
    assert.ok(result.abortDelayMs >= 100,
        'the injected synchronous abort delay crosses the scheduled start time');
    assert.ok(result.audioClockBeforeAbort < result.startAt
        && result.audioClockAfterAbort >= result.startAt,
    'the independent Web Audio clock must cross the start boundary during abort()');
    assert.equal(result.started, false);
    assert.equal(result.playbackStarted, false);
    assert.deepEqual(result.analyserReads, [false],
        'the rendering-side analyser must observe no nonzero PCM after source.stop()');
    assert.equal(result.canFallback, true,
        'fallback is safe only after source stop and a silent render-side check');
    console.log(`Chromium ${browser.version()}: delayed abort crossed start; no PCM rendered; fallback safe`);
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
