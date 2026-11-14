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
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        response.write(wav.subarray(0, 4096));
    } else {
        if (pathname === '/synthesis') normal++;
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
        chrome.runtime.onMessage.addListener(message => { stopProbe.push(message.type); });
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
                return { preparing: button.classList.contains('preparing'),
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
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    });
    const events = () => worker.evaluate(() => stopProbe);
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
    console.log('Chromium extension: icon and shortcut stopped partial WAV requests without re-synthesis');
} finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
