import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('./ocr-e2e/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
// Chromeの利用中プロファイルには接続せず、拡張を読み込めるChromiumを明示指定する。
if (!process.env.OCR_CHROMIUM) throw new Error('OCR_CHROMIUM に Chromium の実行ファイルを指定してください');
const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><style>html,body{margin:0;background:${request.url === '/source' ? '#ff0000' : '#00ff00'}}</style>`);
});
let context;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext('', {
        executablePath: process.env.OCR_CHROMIUM, headless: true,
        viewport: { width: 1000, height: 700 },
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    // serviceworkerイベントはimportScriptsの完了より先に届くことがある。
    await worker.evaluate(async () => {
        const deadline = Date.now() + 5000;
        while (typeof captureAndRecognizeRegion !== 'function' || typeof sendToOffscreen !== 'function') {
            if (Date.now() > deadline) throw new Error('extension service worker did not initialize');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        // エンジンやOCRへ実データを送らず、画像を渡したかだけ記録する。
        globalThis.fetch = async () => new Response('', { status: 503 });
        globalThis.captureProbe = { messages: [], calls: 0, pause: false };
        setupOffscreen = async () => {};
        sendToOffscreen = async message => { captureProbe.messages.push(message); return { success: true }; };
        const capture = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
        chrome.tabs.captureVisibleTab = async (...args) => {
            captureProbe.calls++;
            if (captureProbe.pause) await new Promise(resolve => { captureProbe.release = resolve; });
            return capture(...args);
        };
    });
    const source = await context.newPage();
    await source.goto(`http://127.0.0.1:${server.address().port}/source`);
    const other = await context.newPage();
    await other.goto(`http://127.0.0.1:${server.address().port}/other`);
    const sourceTab = (await worker.evaluate(() => chrome.tabs.query({}))).find(tab => tab.url?.endsWith('/source'));
    assert.ok(sourceTab);

    const request = () => worker.evaluate(tabId => chrome.scripting.executeScript({
        target: { tabId },
        func: () => chrome.runtime.sendMessage({
            type: 'CAPTURE_OCR_REGION', rect: { x: 0, y: 0, width: 800, height: 600 }, viewportWidth: 1000
        })
    }), sourceTab.id).then(results => results[0].result);
    const reset = pause => worker.evaluate(pause => {
        Object.assign(captureProbe, { calls: 0, messages: [], pause, release: null });
    }, pause);
    const waitUntilPaused = () => worker.evaluate(async () => {
        const deadline = Date.now() + 5000;
        while (!captureProbe.release) {
            if (Date.now() > deadline) throw new Error('capture did not start');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    });

    // 非表示の要求元から届いても、別タブは撮影しない。
    await reset(false);
    const inactive = await request();
    assert.equal(inactive.success, false);
    assert.match(inactive.error, /撮影を中止/);
    assert.equal(await worker.evaluate(() => captureProbe.calls), 0);

    // 通常の撮影では元タブ（赤）の画像だけがOCRへ渡る。
    await source.bringToFront();
    await reset(false);
    assert.equal((await request()).success, true);
    const captured = await worker.evaluate(() => captureProbe.messages[0]);
    assert.equal(captured.tabId, sourceTab.id);
    const image = await loadImage(captured.dataUrl);
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    assert.deepEqual(Array.from(canvas.getContext('2d').getImageData(200, 200, 1, 1).data), [255, 0, 0, 255]);

    // 実際の撮影APIが完了する前に切り替わった画像は、OCRへ渡さない。
    for (const returnToSource of [false, true]) {
        // captureVisibleTab の毎秒2回の上限で失敗するのを避ける。
        await new Promise(resolve => setTimeout(resolve, 550));
        await source.bringToFront();
        await reset(true);
        const pending = request();
        await waitUntilPaused();
        await other.bringToFront();
        if (returnToSource) await source.bringToFront();
        await worker.evaluate(() => captureProbe.release());
        const response = await pending;
        assert.equal(response.success, false);
        assert.match(response.error, /撮影を中止/);
        assert.equal(await worker.evaluate(() => captureProbe.messages.length), 0);
    }
    console.log('Chromium: inactive source blocked; normal image matched; switched and returned tabs discarded');
} finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
}
