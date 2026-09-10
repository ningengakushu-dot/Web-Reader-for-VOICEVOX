const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const constants = fs.readFileSync(path.join(root, 'constants.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'options.js'), 'utf8');

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
        this.textContent = '';
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.files = [];
        this.min = '';
        this.max = '';
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

const ids = [
    'speaker-select', 'save-btn', 'reset-btn', 'status-msg', 'loader',
    'iconRightClick-select', 'iconStyle-select', 'iconStyle-preview', 'iconStyle-hint-character',
    'customIcon-row', 'customIcon-file', 'customIcon-clear',
    'speed-slider', 'speed-value', 'pitch-slider', 'pitch-value', 'intonation-slider',
    'intonation-value', 'volume-slider', 'volume-value', 'pause-slider', 'pause-value',
    'iconSize-slider', 'iconSize-value',
    'engine-status', 'engine-recheck', 'engine-setup', 'engine-path',
    'engine-path-copy'
];
const elements = Object.fromEntries(ids.map((id) => [id, new MockElement(id)]));
Object.assign(elements['speed-slider'], { min: '0.5', max: '2.0', value: '1.0' });
Object.assign(elements['pitch-slider'], { min: '-0.15', max: '0.15', value: '0' });
Object.assign(elements['intonation-slider'], { min: '0', max: '2', value: '1' });
Object.assign(elements['volume-slider'], { min: '0', max: '2', value: '1' });
Object.assign(elements['pause-slider'], { min: '0', max: '2', value: '1' });
Object.assign(elements['iconSize-slider'], { min: '16', max: '64', value: '16' });
elements['iconStyle-select'].value = 'custom';
elements['iconRightClick-select'].value = 'capture';

let domReady;
const document = {
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') domReady = fn; },
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return new MockElement(tag); }
};
const stored = {
    speakerId: 999999,
    speedScale: 99,
    pitchScale: -99,
    intonationScale: 'not-a-number',
    volumeScale: Infinity,
    pauseLengthScale: 1.5,
    iconSize: 999,
    iconStyle: 'custom',
    vv_custom_icon: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
    vv_character_icon: { name: 'x'.repeat(500), dataUrl: 'javascript:alert(1)' }
};
const chrome = {
    runtime: {
        id: 'ext-id',
        lastError: null,
        getURL: (p) => `chrome-extension://ext-id/${p}`,
        sendMessage(message, callback) {
            if (message.type === 'GET_SPEAKERS') {
                callback({ success: true, speakers: [
                    { name: '', styles: [] },
                    { name: 'Valid', styles: [{ id: 1, name: 'Normal' }] }
                ] });
            } else callback({ success: false });
        }
    },
    storage: {
        local: {
            async get() { return stored; },
            async set() {},
            async remove() {}
        }
    }
};

// 省メモリ案内は Windows でのみ出す。非 Windows を装うと、その分岐が壊れても
// 気付けないため、既定の検査は Windows として走らせる。
const navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const context = vm.createContext({
    console, document, chrome, navigator, setTimeout, clearTimeout, URL, Image: class {},
    Number, Math, Object, Array, String, Promise, parseInt, parseFloat, isNaN
});
vm.runInContext(constants, context, { filename: 'constants.js' });
vm.runInContext(source, context, { filename: 'options.js' });
assert.strictEqual(typeof domReady, 'function');
domReady();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// 接続確認は初期化と「再確認」の両方から走る。応答が前後しても、
// 最後に始めた確認の結果だけが残ることを、応答の順番を握って確かめる。
async function checkStaleResponseIsIgnored() {
    const pending = [];
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => { pending.push(callback); };
    try {
        const onClick = elements['engine-recheck'].listeners.click;
        const first = onClick();
        const second = onClick();
        await tick();
        pending[1]({ success: true });
        await second;
        assert.ok(elements['engine-status'].classList.values.has('ok'),
            'the latest connection check must be reflected');
        pending[0]({ success: false });
        await first;
        assert.ok(elements['engine-status'].classList.values.has('ok'),
            'a stale connection check must not overwrite a newer result');
        assert.strictEqual(elements['engine-recheck'].disabled, false,
            'the recheck button must be usable again after the latest check settles');
    } finally {
        chrome.runtime.sendMessage = original;
    }
}

setTimeout(async () => {
    try {
        assert.strictEqual(String(elements['speed-slider'].value), '2');
        assert.strictEqual(String(elements['pitch-slider'].value), '-0.15');
        assert.strictEqual(String(elements['intonation-slider'].value), '1');
        assert.strictEqual(String(elements['volume-slider'].value), '1');
        assert.strictEqual(String(elements['iconSize-slider'].value), '64');
        assert.strictEqual(elements['iconStyle-preview'].style.backgroundImage, '',
            'unsafe stored image URLs must not reach CSS');
        assert.strictEqual(elements['speaker-select'].children.length, 1);
        assert.strictEqual(elements['speaker-select'].value, '1',
            'invalid stored speaker IDs must not clear the valid default option');
        const launchLine = elements['engine-path'].value;
        assert.ok(launchLine.includes('vv-engine\\run.exe'),
            'engine setup must point at the already installed VOICEVOX engine');
        assert.ok(!/https?:/i.test(launchLine),
            'engine setup must never hand the user a download URL');
        // 表示なし(第2引数 0)で起動させる。1 や省略に戻ると黒いコンソール画面が残り、
        // 利用者がそれを閉じて読み上げが止まる。
        assert.ok(/\.Run\s+".*",\s*0,\s*False\s*$/.test(launchLine),
            'the engine must be launched without a console window');
        assert.ok(elements['engine-status'].classList.values.has('ok'),
            'a reachable engine must be reported as connected');
        assert.notStrictEqual(elements['engine-setup'].open, true,
            'setup steps must never open themselves on the options page');
        assert.strictEqual(elements['engine-setup'].hidden, false,
            'the setup steps must be reachable on Windows');

        // コピーできない環境でも、次にすべきことがボタンに出ること。
        await elements['engine-path-copy'].listeners.click();
        assert.strictEqual(elements['engine-path-copy'].textContent, 'Ctrl+C でコピー',
            'a failed clipboard write must tell the user how to copy manually');

        // 接続できなくなったら赤く出ること。モックは CHECK_CONNECTION に失敗を返す。
        await elements['engine-recheck'].listeners.click();
        assert.ok(elements['engine-status'].classList.values.has('ng'),
            'a failed connection check must be reported');
        assert.notStrictEqual(elements['engine-setup'].open, true,
            'a failed connection must not push the advanced setup at the user');

        await checkStaleResponseIsIgnored();
        console.log('options storage and preview safety: PASSED');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}, 20);
