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
        this._text = '';
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.files = [];
        this.min = '';
        this.max = '';
        this.selectedOptions = [];
    }
    // 実DOMと同じく、textContent の代入は子要素を捨てる。
    // ここを単なる文字列にしていると、renderSpeakers が一覧を空にする瞬間を
    // 再現できず、一覧が消えたまま残る不具合を検出できない。
    get textContent() { return this._text; }
    set textContent(value) {
        this._text = String(value);
        // 子を持っていた要素だけが「空になる」。option のように明示した value を
        // 持つ要素は、テキストを入れても value を失わない（実DOMと同じ）。
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
// 画面へ戻ったときの自動再確認を検査できるよう、DOMContentLoaded 以外の
// リスナーも保持する。捨てていると、自動再確認を削除しても気付けない。
const documentListeners = {};
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

// 5秒後の再試行を待たずに検査するため、長い待ちだけ手動で進められるようにする。
const pendingTimers = new Map();
let nextTimerId = 1;
const SLOW_TIMER_MS = 1000;
function mockSetTimeout(fn, ms) {
    if (typeof ms === 'number' && ms >= SLOW_TIMER_MS) {
        const id = { slow: nextTimerId++ };
        pendingTimers.set(id, fn);
        return id;
    }
    return setTimeout(fn, ms);
}
function mockClearTimeout(id) {
    if (id && id.slow) { pendingTimers.delete(id); return; }
    clearTimeout(id);
}
// 「短い間隔での重複を抑える」判定を待たずに検査するため、時計を進められるようにする。
let clockOffsetMs = 0;
const mockDate = { now: () => Date.now() + clockOffsetMs };
function advanceClock(ms) { clockOffsetMs += ms; }

function flushSlowTimers() {
    const due = [...pendingTimers.entries()];
    pendingTimers.clear();
    for (const [, fn] of due) fn();
    return due.length;
}
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
    console, document, chrome, navigator, URL, Image: class {},
    setTimeout: mockSetTimeout, clearTimeout: mockClearTimeout,
    addEventListener(type, fn) { windowListeners[type] = fn; },
    Number, Math, Object, Array, String, Promise, parseInt, parseFloat, isNaN, Date: mockDate
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

// エンジン停止中に開いた画面は一覧が空のまま。接続が戻ったときに取り直さないと、
// ヘッダーは緑でもキャラクターを選べず、設定も保存できない。
async function checkSpeakersRecoverOnReconnect() {
    const original = chrome.runtime.sendMessage;
    let speakerRequests = 0;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'GET_SPEAKERS') {
            speakerRequests += 1;
            callback({ success: true, speakers: [{ name: 'Valid', styles: [{ id: 1, name: 'Normal' }] }] });
            return;
        }
        callback({ success: true });
    };
    try {
        // エンジン停止中に開いた画面の実際の中身。空ではなく、値を持たない
        // 「キャラクターを取得中...」の選択肢が1つだけ残っている。
        const placeholder = new MockElement('option');
        placeholder.value = '';
        placeholder.textContent = 'キャラクターを取得中...';
        elements['speaker-select'].textContent = '';
        elements['speaker-select'].appendChild(placeholder);
        elements['speaker-select'].value = '';

        await elements['engine-recheck'].listeners.click();
        assert.strictEqual(speakerRequests, 1,
            'a placeholder-only list must count as unusable and be refetched');
        assert.strictEqual(elements['speaker-select'].children.length, 1,
            'the character list must be usable again after reconnecting');
        assert.strictEqual(elements['speaker-select'].value, '1',
            'the refetched list must be selectable');
        assert.ok(elements['engine-status'].classList.values.has('ok'),
            'a recovered connection must be reported');
    } finally {
        chrome.runtime.sendMessage = original;
    }
}

// 画面へ戻ったとき、押さなくても確かめ直すこと。窓が出ない方式では
// この表示だけが成功の合図なので、自動再確認が無くなると設定できたか分からない。
async function checkAutoRecheckOnReturn() {
    const original = chrome.runtime.sendMessage;
    let checks = 0;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'CHECK_CONNECTION') { checks += 1; callback({ success: true }); return; }
        original(message, callback);
    };
    try {
        assert.strictEqual(typeof documentListeners.visibilitychange, 'function',
            'the page must re-check when the user comes back to it');
        // 直前の確認からの間隔が短いと抑制されるため、時計を進めて素通りさせる。
        advanceClock(10000);
        documentListeners.visibilitychange();
        await tick();
        assert.strictEqual(checks, 1, 'returning to the page must re-check the engine');

        // 立て続けの復帰イベントで問い合わせを重ねない。
        documentListeners.visibilitychange();
        await tick();
        assert.strictEqual(checks, 1, 'repeated visibility changes must not pile up requests');
    } finally {
        chrome.runtime.sendMessage = original;
    }
}

// エンジンは起動指示から応答まで1分ほどかかる。起動途中に戻ってきた人のために、
// 接続できるまで確かめ続けること。1回きりだと失敗のまま止まる。
async function checkRetryWhileEngineStarts() {
    const original = chrome.runtime.sendMessage;
    let connected = false;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'CHECK_CONNECTION') { callback({ success: connected }); return; }
        original(message, callback);
    };
    try {
        pendingTimers.clear();
        await elements['engine-recheck'].listeners.click();
        assert.ok(elements['engine-status'].classList.values.has('ng'),
            'an engine that is still starting must be reported as unreachable');
        assert.ok(pendingTimers.size > 0,
            'the page must keep checking while the engine is starting');

        connected = true;
        flushSlowTimers();
        await tick();
        await tick();
        assert.ok(elements['engine-status'].classList.values.has('ok'),
            'the retry must report the engine once it finishes starting');
    } finally {
        chrome.runtime.sendMessage = original;
    }
}

// /version は通っても /speakers が失敗することはある。その画面はキャラクターを
// 選べず保存もできないので、「接続できています」と出してはいけない。
async function checkListFailureIsNotReportedAsConnected() {
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'GET_SPEAKERS') { callback({ success: false, error: 'Failed to fetch' }); return; }
        callback({ success: true });
    };
    try {
        elements['speaker-select'].textContent = '';
        await elements['engine-recheck'].listeners.click();
        assert.ok(!elements['engine-status'].classList.values.has('ok'),
            'a page without a character list must not claim to be connected');
        assert.ok(elements['engine-status'].textContent.includes('キャラクター一覧'),
            'the user must be told which part failed');
    } finally {
        chrome.runtime.sendMessage = original;
    }
}

// 初期化と「再確認」の一覧取得が並走したとき、古い応答が新しい一覧を壊さないこと。
async function checkStaleSpeakerListIsIgnored() {
    const original = chrome.runtime.sendMessage;
    const speakerCallbacks = [];
    chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'GET_SPEAKERS') { speakerCallbacks.push(callback); return; }
        callback({ success: true });
    };
    try {
        elements['speaker-select'].textContent = '';
        const stale = elements['engine-recheck'].listeners.click();
        await tick();
        assert.strictEqual(speakerCallbacks.length, 1, 'the first check must ask for the list');

        // 応答が返る前に、新しい確認が始まって一覧を取り直す。
        const fresh = elements['engine-recheck'].listeners.click();
        await tick();
        assert.strictEqual(speakerCallbacks.length, 2, 'the newer check must ask again');
        speakerCallbacks[1]({ success: true, speakers: [{ name: 'Fresh', styles: [{ id: 7, name: 'Normal' }] }] });
        await fresh;

        speakerCallbacks[0]({ success: true, speakers: [{ name: 'Stale', styles: [{ id: 1, name: 'Normal' }] }] });
        await stale;
        assert.strictEqual(elements['speaker-select'].value, '7',
            'a stale character list must not replace the newer one');
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
        await checkSpeakersRecoverOnReconnect();
        await checkAutoRecheckOnReturn();
        await checkRetryWhileEngineStarts();
        await checkListFailureIsNotReportedAsConnected();
        await checkStaleSpeakerListIsIgnored();
        assert.strictEqual(elements['engine-recheck'].disabled, false,
            'the recheck button must never stay locked once every check has settled');
        console.log('options storage and preview safety: PASSED');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}, 20);
