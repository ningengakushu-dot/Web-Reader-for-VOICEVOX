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
let normalStatus = 200;
let heldNormal;
let holdNextNormal = false;
let normalInFlight = 0;
let peakNormalInFlight = 0;
const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://127.0.0.1');
    request.resume();
    if (pathname === '/probe-page') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><p id="sample">短い文章です。</p>');
    } else if (Object.hasOwn(engine, pathname)) {
        response.setHeader('Content-Type', 'application/json');
        const body = pathname === '/audio_query' && new URL(request.url, 'http://127.0.0.1').searchParams.get('text') === '長い音声。'
            ? { ...engine[pathname], accent_phrases: [{ moras: [{ vowel_length: 7 }] }] }
            : engine[pathname];
        response.end(JSON.stringify(body));
    } else if (pathname === '/streaming_synthesis') {
        started++;
        response.on('close', () => closed++);
        if (streamResponse === 'http500') return response.writeHead(500).end();
        if (streamResponse === 'complete') return response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav);
        if (streamResponse === 'truncated') {
            response.writeHead(200, { 'Content-Type': 'audio/wav' });
            response.end(wav.subarray(0, 4096));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        response.write(wav.subarray(0, 4096));
        if (streamResponse === 'recover') {
            const timer = setTimeout(() => response.end(wav.subarray(4096)), 35000);
            response.on('close', () => clearTimeout(timer));
        }
    } else if (pathname === '/synthesis') {
        normal++;
        normalInFlight++;
        peakNormalInFlight = Math.max(peakNormalInFlight, normalInFlight);
        response.on('close', () => normalInFlight--);
        const finish = () => response.writeHead(normalStatus, { 'Content-Type': 'audio/wav' }).end(wav);
        if (holdNextNormal) {
            holdNextNormal = false;
            heldNormal = finish;
        } else finish();
    } else {
        response.writeHead(404).end();
    }
});

async function waitFor(check, description, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (!await check()) {
        assert.ok(Date.now() < deadline, description);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

let context;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const loadViaCdp = process.env.OCR_LOAD_VIA_CDP === '1';
    const extensionArgs = loadViaCdp ? ['--enable-unsafe-extension-debugging']
        : [`--disable-extensions-except=${root}`, `--load-extension=${root}`];
    context = await chromium.launchPersistentContext('', {
        executablePath: process.env.OCR_CHROMIUM || chromium.executablePath(),
        headless: process.env.OCR_HEADED !== '1',
        ignoreDefaultArgs: loadViaCdp ? ['--disable-extensions'] : undefined,
        args: [...extensionArgs,
            `--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>']
    });
    if (loadViaCdp) {
        const session = await context.browser().newBrowserCDPSession();
        const { id } = await session.send('Extensions.loadUnpacked', { path: root });
        await session.detach();
        const wake = await context.newPage();
        await wake.goto(`chrome-extension://${id}/capture.html`);
        await wake.evaluate(() => chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }));
        await wake.close();
    }
    let worker = context.serviceWorkers()[0]
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
    const runtimeIssues = [];
    context.on('weberror', error => runtimeIssues.push(error.error().message));
    context.on('console', message => {
        if (/Content Security Policy|violates.*CSP/i.test(message.text())) runtimeIssues.push(message.text());
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
                    globalThis.rejectStop = () => reject(new Error('停止応答のテストエラー <b>文字列</b>'));
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
        assert.match(await status.textContent(), /<b>文字列<\/b>/);
        assert.equal(await status.locator('b').count(), 0, 'untrusted error text must stay text');
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
        await worker.evaluate(() => chrome.scripting.executeScript({
            target: { tabId: playbackOwner.tabId, frameIds: [0] },
            func: () => {
                const listener = window.__vvRadioReaderInstance.pageHideListener;
                if (listener) window.removeEventListener('pagehide', listener);
            }
        }));
        await page.reload();
        await waitFor(() => closed === closeCount + 3, 'replacement document must stop playback without pagehide');
    };

    const offscreenDestroyed = async () => {
        await capture.bringToFront();
        const startCount = started;
        const closeCount = closed;
        await capture.locator('#speak-btn').click();
        await waitFor(() => started === startCount + 1, 'stream should be open before Offscreen destruction');
        await worker.evaluate(() => chrome.offscreen.closeDocument());
        await waitFor(() => closed === closeCount + 1, 'Offscreen destruction must close the stream');
        await waitFor(async () => /音声処理画面/.test(await status.textContent()), 'loss must reach the owning UI');
        assert.equal(await stopButton.isDisabled(), true);
        await capture.locator('#speak-btn').click();
        await waitFor(() => started === startCount + 2, 'retry should create a fresh Offscreen document');
        await stopButton.click();
        await waitFor(() => closed === closeCount + 2, 'new stream should stop');
        await waitFor(async () => (await status.textContent()) === '停止しました。', 'new stop should complete');

        // Offscreen が実際の音声停止処理を待っている間に文書を破棄する。
        await capture.locator('#speak-btn').click();
        await waitFor(() => started === startCount + 3, 'stream should open before pending stop');
        const client = await context.newCDPSession(capture);
        const offscreen = (await client.send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/offscreen.html'));
        const session = await client.send('Target.attachToTarget', { targetId: offscreen.targetId, flatten: false });
        const evaluateOffscreen = async (id, expression) => {
            const reply = new Promise(resolve => {
                const receive = event => {
                    if (event.sessionId !== session.sessionId) return;
                    const message = JSON.parse(event.message);
                    if (message.id !== id) return;
                    client.off('Target.receivedMessageFromTarget', receive);
                    resolve(message.result?.result?.value);
                };
                client.on('Target.receivedMessageFromTarget', receive);
            });
            await client.send('Target.sendMessageToTarget', { sessionId: session.sessionId, message: JSON.stringify({
                id, method: 'Runtime.evaluate', params: { expression, returnByValue: true }
            }) });
            return reply;
        };
        await evaluateOffscreen(1, 'stopAll = () => { globalThis.waitingForStop = true; return new Promise(() => {}); }');
        await stopButton.click();
        let poll = 2;
        await waitFor(() => evaluateOffscreen(poll++, 'globalThis.waitingForStop === true'), 'stop should reach Offscreen');
        assert.match(await status.textContent(), /停止中/);
        await worker.evaluate(() => chrome.offscreen.closeDocument());
        await waitFor(() => closed === closeCount + 3, 'closing Offscreen during stop must close the stream');
        await waitFor(async () => (await status.textContent()) === '停止しました。', 'discarded document counts as stopped');
        await client.detach();

        streamResponse = 'complete';
        await capture.locator('#speak-btn').click();
        await waitFor(async () => (await status.textContent()) === '再生中...', 'audio must begin before Offscreen destruction');
        await worker.evaluate(() => chrome.offscreen.closeDocument());
        await waitFor(async () => /音声処理画面/.test(await status.textContent()), 'active playback loss must reach UI');
        assert.equal(await stopButton.isDisabled(), true);
        streamResponse = 'partial';
    };

    const restartWorker = async () => {
        const startCount = started;
        const closeCount = closed;
        await capture.locator('#speak-btn').click();
        await waitFor(() => started === startCount + 1, 'stream should be open before restarting worker');
        const before = await worker.evaluate(async () => (await getPlaybackOwner()).requestId);
        const devtools = await context.newCDPSession(capture);
        await devtools.send('ServiceWorker.enable');
        await devtools.send('ServiceWorker.stopAllWorkers');
        const restored = await capture.evaluate(async () => {
            await chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' });
            const state = await chrome.storage.session.get('vv_playback_tab_id');
            return state.vv_playback_tab_id.requestId;
        });
        assert.equal(restored, before);
        worker = context.serviceWorkers().find(candidate => candidate.url().endsWith('/background-entry.js'));
        assert.equal(await worker.evaluate(async () => (await getPlaybackOwner()).requestId), before);
        assert.equal(closed, closeCount, 'worker restart must preserve Offscreen playback');
        await stopButton.click();
        await waitFor(() => closed === closeCount + 1, 'restored worker must stop the same request');
        await waitFor(async () => (await status.textContent()) === '停止しました。', 'stop must complete after worker restart');
        await devtools.detach();
    };

    const engineFailure = async () => {
        await capture.bringToFront();
        await worker.evaluate(async () => {
            await chrome.storage.local.set({ synthesisMode: 'auto' });
            if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
                await chrome.offscreen.closeDocument();
            }
        });
        streamResponse = 'http500';
        normalStatus = 500;
        const streamStart = started;
        const normalStart = normal;
        await capture.locator('#result-text').fill('短文。');
        await capture.locator('#speak-btn').click();
        await waitFor(async () => /再生エラー.*500/.test(await status.textContent()), 'Engine failure must reach UI');
        assert.equal(started - streamStart, 1);
        assert.equal(normal - normalStart, 1);
        assert.equal(await stopButton.isDisabled(), true);
        normalStatus = 200;
        await capture.locator('#speak-btn').click();
        await waitFor(async () => (await status.textContent()) === '再生が完了しました。', 'normal synthesis retry must finish');
    };

    const frameRace = async () => {
        await page.bringToFront();
        const startCount = started;
        const closeCount = closed;
        await select();
        await clickIndicator();
        await waitFor(() => started === startCount + 1, 'stream should open before frame race');
        // 別オリジンの子を挿入し、ページ側の合成イベントでは再生状態が変わらないことを確認。
        await page.evaluate(port => {
            const frame = document.createElement('iframe');
            frame.id = 'race-frame';
            frame.src = 'http://localhost:' + port + '/probe-page';
            document.body.append(frame);
        }, port);
        await page.frameLocator('#race-frame').locator('#sample').evaluate(element => {
            window.focus();
            element.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyU', bubbles: true }));
        });
        assert.equal(closed, closeCount);
        assert.equal(started, startCount + 1);
        await delayStop();
        await page.keyboard.press('Alt+Shift+u');
        await page.locator('#race-frame').evaluate(frame => { frame.remove(); window.focus(); });
        await page.keyboard.press('Alt+Shift+u');
        await page.keyboard.press('Alt+Shift+u');
        await waitFor(() => worker.evaluate(() => typeof globalThis.rejectStop === 'function'), 'first shortcut must stop');
        await worker.evaluate(() => { rejectStop(); delete globalThis.rejectStop; });
        await waitFor(async () => !(await indicator()).stopping, 'failure should settle');
        assert.equal(closed, closeCount);
        assert.equal(started, startCount + 1);
        await page.keyboard.press('Alt+Shift+u');
        await waitFor(() => closed === closeCount + 1, 'top-frame retry must stop after iframe removal');
        await waitFor(() => worker.evaluate(() => pendingVoiceStops.size === 0), 'stop queue must drain');
    };

    const concurrentTabs = async () => {
        const second = await context.newPage();
        await second.goto(new URL('capture.html', worker.url()).href);
        const startCount = started;
        const closeCount = closed;
        await Promise.all([capture, second].map(tab => tab.evaluate(() =>
            chrome.runtime.sendMessage({ type: 'GENERATE_VOICE', text: '同時に開始する短文。' }))));
        await waitFor(() => started > startCount, 'at least the latest stream must open');
        const active = [capture, second];
        await waitFor(async () => (await Promise.all(active.map(tab => tab.locator('#stop-btn').isEnabled())))
            .filter(Boolean).length === 1, 'exactly one tab owns the stop button');
        const liveTab = await capture.locator('#stop-btn').isEnabled() ? capture : second;
        const otherTab = liveTab === capture ? second : capture;
        await otherTab.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP_ALL' }));
        assert.equal(await liveTab.locator('#stop-btn').isEnabled(), true, 'other tab must not own this stop');
        await liveTab.locator('#stop-btn').click();
        await waitFor(() => started - startCount === closed - closeCount, 'all opened streams close');
        await waitFor(async () => (await liveTab.locator('#playback-status').textContent()) === '停止しました。', 'last owner stopped');
        await second.close();
    };

    const networkStall = async () => {
        await capture.bringToFront();
        for (const scenario of ['recover', 'partial']) {
            streamResponse = scenario;
            const streamStart = started;
            const normalStart = normal;
            const t = performance.now();
            await capture.locator('#speak-btn').click();
            await waitFor(() => started === streamStart + 1, 'stream should begin');
            await waitFor(async () => (await status.textContent()) === '再生が完了しました。', 'stall must settle', 72000);
            const elapsed = performance.now() - t;
            assert.ok(elapsed >= (scenario === 'recover' ? 35000 : 60000));
            assert.equal(normal - normalStart, scenario === 'recover' ? 0 : 1);
            console.log(JSON.stringify({ scenario, finishMs: Math.round(elapsed), normal: normal - normalStart }));
        }
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

    const normalRestart = async () => {
        await capture.bringToFront();
        await worker.evaluate(() => chrome.storage.local.set({ synthesisMode: 'normal' }));
        const initial = normal;
        peakNormalInFlight = 0;
        holdNextNormal = true;
        await capture.locator('#speak-btn').click();
        await waitFor(() => heldNormal, 'old synthesis must reach ENGINE');
        await stopButton.click();
        await waitFor(async () => (await status.textContent()) === '停止しました。', 'UI must stop while synthesis is pending');
        await capture.locator('#speak-btn').click();
        await waitFor(async () => /準備中/.test(await status.textContent()), 'replacement should be preparing');
        await stopButton.click();
        await waitFor(async () => (await status.textContent()) === '停止しました。', 'a queued replacement can also stop');
        await capture.locator('#speak-btn').click();
        await waitFor(async () => /準備中/.test(await status.textContent()), 'last replacement should be preparing');
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(normal, initial + 1, 'the next synthesis must wait for the uncancellable old request');
        heldNormal();
        heldNormal = undefined;
        await waitFor(async () => (await status.textContent()) === '再生が完了しました。', 'replacement should complete');
        assert.equal(normal, initial + 2);
        assert.equal(peakNormalInFlight, 1);
    };

    const longBypass = async () => {
        await capture.bringToFront();
        await worker.evaluate(() => chrome.storage.local.set({ synthesisMode: 'auto' }));
        streamResponse = 'complete';
        await capture.locator('#result-text').fill('長い音声。');
        const before = [started, normal];
        await capture.locator('#speak-btn').click();
        await waitFor(async () => (await status.textContent()) === '再生が完了しました。', 'long synthesis should complete');
        assert.deepEqual([started - before[0], normal - before[1]], [0, 1], 'avoid synthesizing a request known to exceed the buffer twice');
        await capture.locator('#result-text').fill('短文。');
        await capture.locator('#speak-btn').click();
        await waitFor(() => started === before[0] + 1, 'later short request should still stream');
        await waitFor(async () => (await status.textContent()) === '再生が完了しました。', 'short stream should complete');
        assert.equal(normal, before[1] + 1);
    };

    const regressions = { 'late-frame': lateFrameShortcut, 'capture-rejection': rejectedCaptureStop,
        'icon-rejection': rejectedIconStop, 'tab-switch': switchTabs, 'offscreen-destroyed': offscreenDestroyed,
        'worker-restart': restartWorker, 'frame-race': frameRace, 'tab-race': concurrentTabs,
        'network-stall': networkStall, 'normal-restart': normalRestart, 'long-bypass': longBypass,
        synthesis: synthesisPaths, 'engine-error': engineFailure };
    const selected = process.argv.length > 2 ? process.argv.slice(2)
        : Object.keys(regressions).filter(name => name !== 'network-stall');
    for (const name of selected) {
        await regressions[name]();
    }
    const product = context.browser().version();
    assert.deepEqual(runtimeIssues, [], 'no uncaught page exception or CSP warning');
    console.log(`Chromium ${product}: Offscreen setup, partial WAV stop, ${selected.join(', ')}`);
} finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
