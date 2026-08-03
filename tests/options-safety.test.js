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
    'iconSize-slider', 'iconSize-value'
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

const context = vm.createContext({
    console, document, chrome, setTimeout, clearTimeout, URL, Image: class {},
    Number, Math, Object, Array, String, Promise, parseInt, parseFloat, isNaN
});
vm.runInContext(constants, context, { filename: 'constants.js' });
vm.runInContext(source, context, { filename: 'options.js' });
assert.strictEqual(typeof domReady, 'function');
domReady();

setTimeout(() => {
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
        console.log('options storage and preview safety: PASSED');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}, 20);
