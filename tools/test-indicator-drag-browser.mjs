import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

// npm install --prefix tools/ocr-e2e の既存ブラウザ依存を使う。拡張には同梱しない。
const { chromium } = createRequire(new URL('./ocr-e2e/package.json', import.meta.url))('playwright-core');
const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url === '/frame' ? '<!doctype html><p id="text">子フレームの選択本文</p>'
        : `<!doctype html><iframe style="position:absolute;left:300px;top:100px;width:450px;height:400px" src="http://localhost:${server.address().port}/frame"></iframe>`);
});
let browser;
try {
    await new Promise(resolve => server.listen(0, resolve));
    browser = await chromium.launch({ executablePath: process.env.OCR_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
        window.chrome = { runtime: { id: 'test' }, storage: { local: {
            get(_keys, cb) { cb({ vvradio_icon_pos: { left: 100, top: 100 } }); },
            set(value) { window.savedPosition = value.vvradio_icon_pos; }
        } } };
    });
    for (const name of ['content-common.js', 'content-indicator.js']) {
        await page.addScriptTag({ content: readFileSync(new URL('../' + name, import.meta.url), 'utf8') });
    }
    await page.evaluate(() => {
        window.clicks = 0;
        window.reader = Object.assign({ active: true,
            requestToggleReading() { clicks++; }, toggleReading() { clicks++; }
        }, VVRadioContent.parts.indicator);
        reader.injectIndicator();
        document.addEventListener('pointermove', event => event.stopPropagation());
    });
    const child = page.frames().find(frame => frame.url().endsWith('/frame'));
    await child.locator('#text').click();
    await child.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#text'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.mouse.click(116, 116);
    assert.equal(await child.evaluate(() => getSelection().toString()), '子フレームの選択本文');
    assert.ok(await child.evaluate(() => document.hasFocus()));
    assert.equal(await page.evaluate(() => clicks), 1);
    await page.mouse.move(116, 116);
    await page.mouse.down();
    // compositorへドラッグ面が反映された後、1イベントで別オリジンiframeへ移動する。
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.move(600, 300, { steps: 1 });
    assert.deepEqual(await page.evaluate(() => [reader.indicator.offsetLeft, reader.indicator.offsetTop]), [584, 284]);
    await page.mouse.up();
    await page.mouse.move(620, 320, { steps: 1 });
    assert.deepEqual(await page.evaluate(() => savedPosition), { left: 584, top: 284 });
    assert.deepEqual(await page.evaluate(() => [reader.indicator.offsetLeft, reader.indicator.offsetTop]), [584, 284]);
    assert.equal(await page.evaluate(() => clicks), 1, 'ドラッグでは読み上げを開始しない');
    await page.evaluate(() => reader.indicatorDragCleanup());
    assert.equal(await page.evaluate(() => reader.shadowRoot.querySelector('#vvradio-drag-surface')), null);
    assert.deepEqual(errors, []);
    console.log(`Chrome ${browser.version()}: cross-origin iframe drag, release and selection: PASSED`);
} finally {
    await browser?.close();
    server.close();
}
