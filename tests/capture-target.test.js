const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const image = 'data:image/png;base64,AA==';
const region = { type: 'CAPTURE_OCR_REGION', rect: { x: 0, y: 0, width: 100, height: 50 }, viewportWidth: 1000 };

function event() {
    const listeners = new Set();
    return {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); },
        emit(...args) { for (const fn of [...listeners]) fn(...args); },
        size() { return listeners.size; }
    };
}

function harness(hooks = {}) {
    let receive;
    const original = { id: 11, windowId: 7, active: true, status: 'complete', url: 'https://source.example/', title: 'source', index: 0 };
    const h = {
        tab: { ...original }, documentId: 'document-1', session: {}, captures: 0,
        messages: [], created: [], badges: [], documentChecks: 0,
        events: { onActivated: event(), onUpdated: event(), onRemoved: event(), onDetached: event() },
        activate(tabId, windowId = 7) {
            if (windowId === 7) this.tab.active = tabId === 11;
            this.events.onActivated.emit({ tabId, windowId });
        },
        navigate() {
            this.documentId = 'document-2';
            this.events.onUpdated.emit(11, { status: 'loading' }, this.tab);
        }
    };
    const chrome = {
        runtime: {
            id: 'ext-id', getURL: file => `chrome-extension://ext-id/${file}`,
            getManifest: () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')),
            onInstalled: event(), onMessage: { addListener(fn) { receive = fn; } },
            getContexts: async () => { await hooks.setup?.(h); return [{}]; },
            sendMessage: async message => { h.messages.push(message); return { success: true }; }
        },
        scripting: {
            executeScript: async ({ target }) => {
                if (target.documentIds) {
                    h.documentChecks++;
                    if (target.documentIds[0] !== h.documentId) throw new Error('document no longer exists');
                    return [{ documentId: h.documentId, frameId: 0, result: true }];
                }
                await hooks.inject?.(h);
                if (hooks.failInjection) throw new Error('cannot access PDF viewer');
                return [];
            }
        },
        contextMenus: { onClicked: event() }, commands: { onCommand: event() },
        action: {
            onClicked: event(), setBadgeText: async value => h.badges.push(value),
            setBadgeBackgroundColor: async () => {}, setTitle: async () => {}
        },
        storage: {
            local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
            session: {
                get: async key => ({ [key]: h.session[key] }),
                set: async value => { Object.assign(h.session, value); await hooks.store?.(h); },
                remove: async key => { delete h.session[key]; }
            }
        },
        tabs: {
            ...h.events,
            query: async () => {
                await hooks.query?.(h);
                return h.tab.active ? [{ ...h.tab }] : [{ id: 22, windowId: 7, active: true }];
            },
            captureVisibleTab: async windowId => {
                assert.equal(windowId, 7);
                h.captures++;
                await hooks.capture?.(h);
                return image;
            },
            create: async value => { h.created.push(value); return { id: 33 }; },
            sendMessage: async () => ({ success: true })
        }
    };
    const ctx = vm.createContext({
        chrome, console: { warn() {}, error() {}, log() {} },
        setTimeout: () => 0, clearTimeout() {}, crypto: { randomUUID: () => 'capture-1' }
    });
    ctx.importScripts = (...files) => files.forEach(file =>
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file }));
    ctx.importScripts('background-entry.js');
    const initialListeners = Object.values(h.events).map(e => e.size());
    h.assertReleased = () => assert.deepEqual(Object.values(h.events).map(e => e.size()), initialListeners,
        'capture-scoped listeners must always be removed');
    h.send = () => new Promise(resolve => receive(region, {
        id: 'ext-id', tab: { ...original }, url: original.url, frameId: 0, documentId: 'document-1'
    }, resolve));
    h.fallback = () => ctx.startCaptureOcrInTab({ ...original });
    h.start = () => ctx.startCaptureOcr({ ...original });
    return h;
}

async function rejectedRegion(h, expectedCaptures = 0) {
    const response = await h.send();
    assert.equal(response.success, false);
    assert.match(response.error, /撮影を中止/);
    assert.equal(h.captures, expectedCaptures);
    assert.equal(h.messages.filter(m => m.type === 'OCR_RECOGNIZE').length, 0);
    h.assertReleased();
}

(async () => {
    const valid = harness();
    assert.equal((await valid.send()).success, true);
    assert.equal(valid.captures, 1);
    assert.equal(valid.messages.find(m => m.type === 'OCR_RECOGNIZE').tabId, 11);
    assert.ok(valid.documentChecks >= 2, 'sender document must be checked before and after capture');
    valid.assertReleased();

    const inactive = harness();
    inactive.tab.active = false;
    await rejectedRegion(inactive);

    const changedUrl = harness();
    changedUrl.tab.url = 'https://different.example/';
    await rejectedRegion(changedUrl);

    const staleDocument = harness();
    staleDocument.documentId = 'document-2';
    await rejectedRegion(staleDocument);

    const moved = harness();
    moved.tab.windowId = 9;
    await rejectedRegion(moved);

    await rejectedRegion(harness({ capture: h => h.activate(22) }), 1);
    await rejectedRegion(harness({ capture: h => { h.activate(22); h.activate(11); } }), 1);
    await rejectedRegion(harness({ capture: h => { h.navigate(); h.tab.status = 'complete'; } }), 1);
    await rejectedRegion(harness({ capture: h => h.events.onRemoved.emit(11) }), 1);
    await rejectedRegion(harness({ capture: h => h.events.onDetached.emit(11, { oldWindowId: 7 }) }), 1);
    await rejectedRegion(harness({ setup: h => h.activate(22) }), 1);
    await rejectedRegion(harness({ query: () => { throw new Error('tab gone'); } }));

    const failedCapture = harness({ capture: () => { throw new Error('capture failed'); } });
    assert.equal((await failedCapture.send()).success, false);
    failedCapture.assertReleased();

    const unrelated = harness({ capture: h => {
        h.activate(99, 8);
        h.events.onUpdated.emit(22, { status: 'loading' });
    } });
    assert.equal((await unrelated.send()).success, true);
    unrelated.assertReleased();

    const fallback = harness();
    await fallback.fallback();
    assert.equal(fallback.captures, 1);
    assert.equal(fallback.session.vv_ocr_capture.dataUrl, image);
    assert.equal(fallback.created.length, 1);
    fallback.assertReleased();

    const inactiveFallback = harness();
    inactiveFallback.tab.active = false;
    await inactiveFallback.fallback();
    assert.equal(inactiveFallback.captures, 0);
    assert.equal(inactiveFallback.created.length, 0);
    inactiveFallback.assertReleased();

    for (const hooks of [
        { capture: h => h.activate(22) },
        { capture: h => { h.activate(22); h.activate(11); } },
        { capture: h => h.navigate() },
        { store: h => h.activate(22) }
    ]) {
        const cancelled = harness(hooks);
        await cancelled.fallback();
        assert.equal(cancelled.created.length, 0, 'cancelled capture must not open a screenshot tab');
        assert.equal(cancelled.session.vv_ocr_capture, undefined, 'cancelled screenshot must not remain stored');
        assert.ok(cancelled.badges.some(b => b.text === 'ERR'));
        cancelled.assertReleased();
    }

    const newer = harness({ store: h => {
        h.session.vv_ocr_capture = { captureId: 'newer', dataUrl: image };
        h.activate(22);
    } });
    await newer.fallback();
    assert.equal(newer.session.vv_ocr_capture.captureId, 'newer', 'cancelling an old request must preserve a newer capture');
    newer.assertReleased();

    const injectionChanged = harness({ failInjection: true, inject: h => { h.navigate(); } });
    await injectionChanged.start();
    assert.equal(injectionChanged.captures, 0, 'navigation during injection must not trigger fallback capture');
    assert.equal(injectionChanged.created.length, 0);
    injectionChanged.assertReleased();

    const pdf = harness({ failInjection: true });
    await pdf.start();
    assert.equal(pdf.captures, 1, 'unchanged PDF viewer must still use the screenshot tab');
    assert.equal(pdf.created.length, 1);
    pdf.assertReleased();
    console.log('capture target tab and navigation boundaries: PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; });
