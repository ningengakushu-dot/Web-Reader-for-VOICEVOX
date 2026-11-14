import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = createRequire(new URL('./ocr-e2e/package.json', import.meta.url))('playwright-core');
const wav = Buffer.alloc(44 + 24000 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

const engine = {
    '/engine_manifest': { supported_features: { streaming_synthesis: true } },
    '/speakers': [{ name: 'Test', styles: [{ id: 1, type: 'streaming_talk' }] }],
    '/version': '0.26.0',
    '/audio_query': { accent_phrases: [], outputSamplingRate: 24000, outputStereo: false }
};
let started = 0;
let closed = 0;
let normal = 0;
let streamResponse = 'partial';
const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://127.0.0.1');
    request.resume();
    if (pathname === '/probe-page') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><p id="sample">短い文章です。</p>');
    } else if (Object.hasOwn(engine, pathname)) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(engine[pathname]));
    } else if (pathname === '/streaming_synthesis') {
        started++;
        response.on('close', () => closed++);
        if (streamResponse === 'truncated') {
            response.writeHead(200, { 'Content-Type': 'audio/wav' });
            response.end(wav.subarray(0, 4096));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        response.write(wav.subarray(0, 4096));
    } else if (pathname === '/synthesis') {
        normal++;
        response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav);
    } else {
        response.writeHead(404).end();
    }
});

async function waitFor(check, description) {
    const deadline = Date.now() + 8000;
    while (!await check()) {
        assert.ok(Date.now() < deadline, description);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

let context;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    context = await chromium.launchPersistentContext('', {
        executablePath: process.env.OCR_CHROMIUM || chromium.executablePath(),
        headless: true,
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
            `--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>']
    });
    const worker = context.serviceWorkers()[0]
        || await context.waitForEvent('serviceworker', { timeout: 8000 });
    await worker.evaluate(async () => {
        await chrome.storage.local.set({ synthesisMode: 'auto', speakerId: 1 });
        globalThis.stopProbe = [];
        chrome.runtime.onMessage.addListener(message => {
            if (message.type !== 'STOP_ALL' || typeof stopAllForTab !== 'function') stopProbe.push(message.type);
        });
        // トグルによる停止は SW 内で直接 STOP_ALL と同じ入口を通る。
        if (typeof stopAllForTab === 'function') {
            const stop = stopAllForTab;
            stopAllForTab = tabId => {
                stopProbe.push('STOP_ALL');
                return stop(tabId);
            };
            const send = notifyTab;
            notifyTab = (tabId, message, context) => {
                if (message.type === 'PLAYBACK_STOPPED') stopProbe.push(message.type);
                return send(tabId, message, context);
            };
        }
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/probe-page`);
    await page.locator('#vvradio-host').waitFor({ state: 'attached', timeout: 5000 });
    const tabId = await worker.evaluate(async () =>
        (await chrome.tabs.query({})).find(tab => tab.url?.endsWith('/probe-page')).id);
    const indicator = () => worker.evaluate(async tabId => {
        const [frame] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const button = window.__vvRadioReaderInstance.indicator;
                const rect = button.getBoundingClientRect();
                return { preparing: button.classList.contains('preparing'), stopping: button.classList.contains('stopping'),
                    reading: button.classList.contains('reading'),
                    x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
        });
        return frame.result;
    }, tabId);
    const clickIndicator = async () => {
        const { x, y } = await indicator();
        await page.mouse.click(x, y);
    };
    const select = () => page.locator('#sample').evaluate(element => {
        window.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    });
    const events = () => worker.evaluate(() => stopProbe);
    await worker.evaluate(() => {
        const setup = setupOffscreen;
        setupOffscreen = async () => {
            await new Promise(resolve => { globalThis.releaseSetup = resolve; });
            setupOffscreen = setup;
            await setup();
        };
    });
    await select();
    await clickIndicator();
    await waitFor(() => worker.evaluate(() => typeof globalThis.releaseSetup === 'function'),
        'Offscreen setup should be waiting');
    assert.equal((await indicator()).preparing, true);
    await clickIndicator();
    await waitFor(async () => (await events()).includes('STOP_ALL'), 'second click must request a stop');
    await worker.evaluate(() => releaseSetup());
    await waitFor(() => worker.evaluate(() => pendingVoiceStarts.size === 0), 'setup cancellation should settle');
    assert.equal(started, 0);
    assert.equal((await events()).filter(type => type === 'GENERATE_VOICE').length, 1);
    await worker.evaluate(() => { stopProbe.length = 0; });

    for (const [index, action] of ['icon', 'shortcut'].entries()) {
        await select();
        await clickIndicator();
        await waitFor(() => started === index + 1, 'stream should begin receiving');
        const { preparing, reading } = await indicator();
        assert.equal(preparing, true);
        assert.equal(reading, false);
        if (action === 'icon') await clickIndicator();
        else await page.keyboard.press('Alt+Shift+u');
        await waitFor(() => closed === index + 1, `${action} must close the open stream`);
        await waitFor(async () => (await events()).filter(type => type === 'PLAYBACK_STOPPED').length === index + 1,
            `${action} must finish stopping`);
        await waitFor(async () => !(await indicator()).preparing, 'preparation must clear');
        const sent = await events();
        assert.equal(sent.filter(type => type === 'GENERATE_VOICE').length, index + 1);
        assert.equal(sent.filter(type => type === 'STOP_ALL').length, index + 1);
        assert.equal(sent.includes('PLAYBACK_STARTED'), false);
        assert.equal(normal, 0);
    }

    const capture = await context.newPage();
    await capture.goto(new URL('capture.html', worker.url()).href);
    await capture.locator('#result-text').fill('短い文章です。');
    const stopButton = capture.locator('#stop-btn');
    const status = capture.locator('#playback-status');
    assert.equal(await stopButton.isDisabled(), true);
    await capture.locator('#speak-btn').click();
    await waitFor(() => started === 3, 'capture page stream should begin receiving');
    assert.equal(await stopButton.isEnabled(), true);
    assert.match(await status.textContent(), /準備中/);
    await stopButton.click();
    await waitFor(() => closed === 3, 'capture stop must close the open stream');
    await waitFor(async () => (await events()).filter(type => type === 'PLAYBACK_STOPPED').length === 3,
        'capture stop must finish stopping');
    assert.equal(await stopButton.isDisabled(), true);
    assert.equal(await status.textContent(), '停止しました。');
    const sent = await events();
    assert.equal(sent.filter(type => type === 'GENERATE_VOICE').length, 3);
    assert.equal(sent.filter(type => type === 'STOP_ALL').length, 3);
    assert.equal(sent.includes('PLAYBACK_STARTED'), false);
    assert.equal(normal, 0);

    const lateFrameShortcut = async () => {
        await worker.evaluate(() => { stopProbe.length = 0; });
        const startCount = started;
        const closeCount = closed;
        const normalCount = normal;
        await select();
        await clickIndicator();
        await waitFor(() => started === startCount + 1, 'original stream should be open');
        await page.evaluate(() => {
            const frame = document.createElement('iframe');
            frame.id = 'late-frame';
            frame.src = '/probe-page';
            document.body.append(frame);
        });
        const sample = page.frameLocator('#late-frame').locator('#sample');
        await sample.waitFor();
        await page.locator('#late-frame').evaluate(frame => { frame.src = '/probe-page?after-navigation'; });
        await waitFor(() => page.frames().some(frame => frame.url().endsWith('?after-navigation')),
            'the new child document should commit');
        assert.equal(closed, closeCount, 'child navigation must preserve the tab playback');
        await sample.evaluate(element => {
            window.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
        });
        assert.equal(await page.frameLocator('#late-frame').locator('#sample').evaluate(() => document.hasFocus()), true);
        await page.keyboard.press('Alt+Shift+u');
        await waitFor(() => closed === closeCount + 1, 'shortcut must close the original stream');
        const counts = {
            stop: (await events()).filter(type => type === 'STOP_ALL').length,
            generate: (await events()).filter(type => type === 'GENERATE_VOICE').length,
            stream: started - startCount
        };
        assert.equal(counts.stop, 1, JSON.stringify(counts));
        await waitFor(async () => !(await indicator()).preparing, 'shortcut must finish stopping');
        assert.equal((await events()).filter(type => type === 'GENERATE_VOICE').length, 1);
        assert.equal(started, startCount + 1, 'no replacement streaming request');
        assert.equal(normal, normalCount, 'no replacement normal request');
        await page.locator('#late-frame').evaluate(frame => {
            frame.remove();
            window.focus();
        });
    };

    const delayStop = () =>
        worker.evaluate(() => {
            const send = sendToOffscreen;
            sendToOffscreen = message => {
                if (message.type !== 'STOP_AUDIO') return send(message);
                sendToOffscreen = send;
                return new Promise((resolve, reject) => {
                    globalThis.rejectStop = () => reject(new Error('停止応答のテストエラー'));
                });
            };
        });

    const rejectedCaptureStop = async () => {
        const startCount = started;
        const closeCount = closed;
        await capture.bringToFront();
        await capture.locator('#speak-btn').click();
        await waitFor(() => started === startCount + 1, 'capture stream should be open');
        await delayStop();
        await stopButton.click();
        await waitFor(() => worker.evaluate(() => typeof globalThis.rejectStop === 'function'),
            'stop should reach the delayed Offscreen boundary');
        const whileStopping = await status.textContent();
        assert.equal(await stopButton.isDisabled(), true);
        assert.equal(closed, closeCount);
        await worker.evaluate(() => { rejectStop(); delete globalThis.rejectStop; });
        assert.match(whileStopping, /停止中/);
        await waitFor(async () => /停止応答のテストエラー/.test(await status.textContent()),
            'capture must present the stop failure reason');
        assert.equal(closed, closeCount);
        assert.equal(await stopButton.isEnabled(), true);
        await stopButton.click();
        await waitFor(() => closed === closeCount + 1, 'retry must close the original stream');
        await waitFor(async () => (await status.textContent()) === '停止しました。', 'retry must confirm stop');
    };

    const rejectedIconStop = async () => {
        await page.bringToFront();
        const startCount = started;
        const closeCount = closed;
        await select();
        await clickIndicator();
        await waitFor(() => started === startCount + 1, 'page stream should be open');
        await delayStop();
        await clickIndicator();
        await waitFor(() => worker.evaluate(() => typeof globalThis.rejectStop === 'function'), 'stop is pending');
        assert.equal((await indicator()).stopping, true);
        await worker.evaluate(() => { rejectStop(); delete globalThis.rejectStop; });
        await waitFor(async () => (await indicator()).stopping === false, 'icon must reflect the rejection');
        const toast = await worker.evaluate(async tabId => {
            const [frame] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => window.__vvRadioReaderInstance.ocrToast?.textContent
            });
            return frame.result;
        }, tabId);
        assert.match(toast, /停止応答のテストエラー/);
        assert.equal(closed, closeCount);
        await clickIndicator();
        await waitFor(() => closed === closeCount + 1, 'icon retry must close the original stream');
        assert.equal(started, startCount + 1);
    };

    const switchTabs = async () => {
        await page.bringToFront();
        const startCount = started;
        const closeCount = closed;
        await select();
        await clickIndicator();
        await waitFor(() => started === startCount + 1, 'first tab stream should open');
        await capture.bringToFront();
        await capture.locator('#speak-btn').click();
        await waitFor(() => started === startCount + 2 && closed === closeCount + 1, 'switch must stop only the old stream');
        await page.reload();
        assert.match(await status.textContent(), /準備中/);
        assert.equal(closed, closeCount + 1);
        await stopButton.click();
        await waitFor(() => closed === closeCount + 2, 'second tab must still be able to stop');
        await waitFor(async () => (await status.textContent()) === '停止しました。', 'second tab has stopped');

        await page.bringToFront();
        await select();
        await clickIndicator();
        await waitFor(() => started === startCount + 3, 'first tab can start again');
        await page.reload();
        await waitFor(() => closed === closeCount + 3, 'reloading the owner document must stop playback');
    };

    const synthesisPaths = async () => {
        await capture.bringToFront();
        streamResponse = 'truncated';
        for (const [mode, text, streams, syntheses] of [
            ['normal', '通常合成。', 0, 1],
            ['auto', '最初の文です。次の文です。', 0, 2],
            ['auto', '切断後に再試行します。', 1, 1]
        ]) {
            const startCount = started;
            const normalCount = normal;
            await worker.evaluate(mode => chrome.storage.local.set({ synthesisMode: mode }), mode);
            await capture.locator('#result-text').fill(text);
            await capture.locator('#speak-btn').click();
            await waitFor(() => normal === normalCount + syntheses, 'normal synthesis requests should arrive');
            await waitFor(async () => (await status.textContent()) === '再生が完了しました。', 'playback should finish');
            assert.equal(started - startCount, streams);
            assert.equal(normal - normalCount, syntheses);
        }
    };

    const regressions = { 'late-frame': lateFrameShortcut, 'capture-rejection': rejectedCaptureStop,
        'icon-rejection': rejectedIconStop, 'tab-switch': switchTabs, synthesis: synthesisPaths };
    const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(regressions);
    for (const name of selected) {
        await regressions[name]();
    }
    const product = await worker.evaluate(async () =>
        (await navigator.userAgentData.getHighEntropyValues(['fullVersionList'])).fullVersionList
            .find(brand => brand.brand === 'Chromium')?.version);
    console.log(`Chromium ${product}: Offscreen setup, partial WAV stop, ${selected.join(', ')}`);
} finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
