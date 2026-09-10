// エンジン起動待ちの再確認だけを、エンジンが止まっている状態から検査する。
// 案内どおりに設定した人は、黒い画面もタスクバー項目も見えない。この画面の
// 表示が緑へ変わることだけが成功の合図なので、「見えていて、まだ使える状態に
// なっていなければ、必ず次の確認が控えている」が崩れると設定できたか分からない。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const constants = fs.readFileSync(path.join(root, 'constants.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'options.js'), 'utf8');

const ELEMENT_IDS = [
    'speaker-select', 'save-btn', 'reset-btn', 'status-msg', 'loader',
    'iconRightClick-select', 'iconStyle-select', 'iconStyle-preview', 'iconStyle-hint-character',
    'customIcon-row', 'customIcon-file', 'customIcon-clear',
    'speed-slider', 'speed-value', 'pitch-slider', 'pitch-value', 'intonation-slider',
    'intonation-value', 'volume-slider', 'volume-value', 'pause-slider', 'pause-value',
    'iconSize-slider', 'iconSize-value',
    'engine-status', 'engine-recheck', 'engine-setup', 'engine-path', 'engine-path-copy'
];

class MockClassList {
    constructor() { this.values = new Set(); }
    add(...items) { for (const item of items) this.values.add(item); }
    remove(...items) { for (const item of items) this.values.delete(item); }
    toggle(item, force) { if (force) this.values.add(item); else this.values.delete(item); }
}

class MockElement {
    constructor(id = '') {
        this.id = id;
        this.style = {};
        this.classList = new MockClassList();
        this.listeners = {};
        this.children = [];
        this.value = '';
        this._text = '';
        this.hidden = false;
        this.disabled = false;
        this.min = '';
        this.max = '';
        this.selectedOptions = [];
    }
    get textContent() { return this._text; }
    set textContent(value) {
        this._text = String(value);
        if (this.children.length === 0) return;
        this.children = [];
        this.value = '';
        this.selectedOptions = [];
    }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    appendChild(child) {
        this.children.push(child);
        if (!this.value && child.value !== undefined) {
            this.value = child.value;
            this.selectedOptions = [child];
        }
        return child;
    }
    get options() { return this.children; }
}

/**
 * エンジンが止まっている状態のオプション画面を1つ作る。
 * engineUp を true にすると、以降の問い合わせが成功するようになる。
 */
function openOptionsPage() {
    const page = { engineUp: false };
    const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, new MockElement(id)]));
    for (const id of ['speed-slider', 'pitch-slider', 'intonation-slider', 'volume-slider', 'pause-slider']) {
        Object.assign(elements[id], { min: '0', max: '2', value: '1' });
    }
    Object.assign(elements['iconSize-slider'], { min: '16', max: '128', value: '32' });

    const documentListeners = {};
    let domReady;
    const document = {
        hidden: false,
        addEventListener(type, fn) {
            if (type === 'DOMContentLoaded') domReady = fn;
            else documentListeners[type] = fn;
        },
        getElementById(id) { return elements[id] || null; },
        createElement(tag) { return new MockElement(tag); }
    };
    const windowListeners = {};

    // 5秒後の再確認を待たずに検査するため、その待ちだけ手元で進める。
    // 3秒後のメッセージ消去などは巻き込まないよう、境目を4秒に置く。
    const slowTimers = new Map();
    let nextSlowId = 1;
    const RETRY_TIMER_MS = 4000;
    const setTimeoutMock = (fn, ms) => {
        if (typeof ms === 'number' && ms >= RETRY_TIMER_MS) {
            const id = { slow: nextSlowId++ };
            slowTimers.set(id, fn);
            return id;
        }
        return setTimeout(fn, ms);
    };
    const clearTimeoutMock = (id) => {
        if (id && id.slow) { slowTimers.delete(id); return; }
        clearTimeout(id);
    };

    let clockOffset = 0;
    const chrome = {
        runtime: {
            id: 'ext-id',
            lastError: null,
            getURL: (p) => p,
            sendMessage(message, callback) {
                if (!page.engineUp) { callback({ success: false, error: 'Failed to fetch' }); return; }
                if (message.type === 'GET_SPEAKERS') {
                    callback({ success: true, speakers: [{ name: 'Valid', styles: [{ id: 1, name: 'Normal' }] }] });
                    return;
                }
                callback({ success: true });
            }
        },
        storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } }
    };

    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document, chrome, URL, Image: class {},
        navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        setTimeout: setTimeoutMock, clearTimeout: clearTimeoutMock,
        addEventListener(type, fn) { windowListeners[type] = fn; },
        Date: { now: () => Date.now() + clockOffset },
        Number, Math, Object, Array, String, Promise, parseInt, parseFloat, isNaN
    });
    vm.runInContext(constants, context, { filename: 'constants.js' });
    vm.runInContext(source, context, { filename: 'options.js' });
    domReady();

    Object.assign(page, {
        elements, document, documentListeners, windowListeners,
        pendingRetries: () => slowTimers.size,
        advanceClock: (ms) => { clockOffset += ms; },
        flushRetries() {
            const due = [...slowTimers.values()];
            slowTimers.clear();
            for (const fn of due) fn();
            return due.length;
        },
        status: () => elements['engine-status'],
        settle: () => new Promise((resolve) => setTimeout(resolve, 5))
    });
    return page;
}

async function main() {
    // 1. 起動途中にこの画面を開いた人。初回の取得が失敗しても、待つだけで緑になる。
    {
        const page = openOptionsPage();
        await page.settle();
        assert.ok(page.status().classList.values.has('ng'),
            'a stopped engine must be reported when the page opens');
        assert.ok(page.pendingRetries() > 0,
            'opening the page while the engine is starting must keep checking');

        page.engineUp = true;
        page.flushRetries();
        await page.settle();
        assert.ok(page.status().classList.values.has('ok'),
            'waiting on the freshly opened page must be enough to see success');
        assert.strictEqual(page.pendingRetries(), 0,
            'checking must stop once the engine is usable');
    }

    // 2. 別のタブを一瞬見て戻ってきた場合。間隔の抑制で今回の確認が省かれても、
    //    次の確認が控えていなければ、待っても表示が変わらない画面になる。
    {
        const page = openOptionsPage();
        await page.settle();
        assert.ok(page.pendingRetries() > 0, 'the initial failure must schedule a check');

        // 直前に1度確認しておく。ここを経ないと次の復帰が間隔の抑制に掛からず、
        // 「抑制されても次の確認が控えている」という肝心の条件を検査できない。
        page.advanceClock(10000);
        page.windowListeners.focus();
        await page.settle();

        page.document.hidden = true;
        page.documentListeners.visibilitychange();
        assert.strictEqual(page.pendingRetries(), 0,
            'a hidden page must not keep polling');

        // 抑制の効く3秒以内に戻ってくる。
        page.document.hidden = false;
        page.documentListeners.visibilitychange();
        page.windowListeners.focus();
        await page.settle();
        assert.ok(page.pendingRetries() > 0,
            'coming straight back must leave a check pending even when throttled');

        page.engineUp = true;
        page.flushRetries();
        await page.settle();
        assert.ok(page.status().classList.values.has('ok'),
            'the pending check must report success after a quick tab switch');
    }

    // 3. 上限まで確かめ終えた画面。別のアプリから戻ってきたら数え直す。
    {
        const page = openOptionsPage();
        await page.settle();
        for (let i = 0; i < 40 && page.pendingRetries() > 0; i++) {
            page.flushRetries();
            await page.settle();
        }
        assert.strictEqual(page.pendingRetries(), 0,
            'an abandoned page must stop polling at some point');

        page.advanceClock(10000);
        page.windowListeners.focus();
        await page.settle();
        assert.ok(page.pendingRetries() > 0,
            'returning to the window must resume checking after the limit was reached');
    }

    console.log('engine retry while starting: PASSED');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
