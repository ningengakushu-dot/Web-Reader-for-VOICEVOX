const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readContentSource } = require('./content-source');

const source = readContentSource();
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

function listenerRegistry() {
    const byType = new Map();
    return {
        add(type, fn) {
            if (!byType.has(type)) byType.set(type, new Set());
            byType.get(type).add(fn);
        },
        remove(type, fn) { byType.get(type)?.delete(fn); },
        count(type) { return byType.get(type)?.size || 0; }
    };
}

function createScenario({ attachShadow = true, staleHost = false } = {}) {
    const documentListeners = listenerRegistry();
    const windowListeners = listenerRegistry();
    const runtimeListeners = new Set();
    const storageListeners = new Set();
    const byId = new Map();
    const htmlElements = [];
    const legacyCreateCalls = [];

    const makeElement = ({ namespaceURI = null, html = false, canAttachShadow = attachShadow } = {}) => {
        const element = {
            namespaceURI,
            id: '',
            textContent: '',
            className: '',
            innerHTML: '',
            hidden: false,
            disabled: false,
            isConnected: true,
            children: [],
            removed: false,
            classList: { add() {}, remove() {}, toggle() {} },
            appendChild(child) { this.children.push(child); return child; },
            remove() {
                this.removed = true;
                this.isConnected = false;
                if (this.id) byId.delete(this.id);
            },
            setAttribute() {},
            removeAttribute() {},
            addEventListener() {},
            removeEventListener() {},
            querySelector() { return makeElement({ namespaceURI: HTML_NS, html: true }); },
            focus() {},
            offsetWidth: 16,
            offsetHeight: 16,
            offsetLeft: 0,
            offsetTop: 0
        };
        if (html) {
            element.style = { cssText: '', visibility: '' };
            if (canAttachShadow) {
                element.attachShadow = () => makeElement({ namespaceURI: null, html: false, canAttachShadow: false });
            }
        }
        return element;
    };

    const documentElement = makeElement({ namespaceURI: SVG_NS, html: false, canAttachShadow: false });
    documentElement.appendChild = (child) => {
        documentElement.children.push(child);
        if (child.id) byId.set(child.id, child);
        return child;
    };

    let stale = null;
    if (staleHost) {
        stale = makeElement({ namespaceURI: SVG_NS, html: false, canAttachShadow: false });
        stale.id = 'vvradio-host';
        byId.set(stale.id, stale);
    }

    const documentMock = {
        body: null,
        documentElement,
        activeElement: null,
        createElement(tagName) {
            legacyCreateCalls.push(tagName);
            // XML/SVG document の createElement() が返す通常 Element を再現する。
            // HTMLElement ではないため style / attachShadow は持たせない。
            return makeElement({ namespaceURI: null, html: false, canAttachShadow: false });
        },
        createElementNS(namespaceURI, tagName) {
            assert.equal(namespaceURI, HTML_NS);
            const element = makeElement({ namespaceURI, html: true });
            element.localName = tagName;
            htmlElements.push(element);
            return element;
        },
        getElementById(id) { return byId.get(id) || null; },
        addEventListener(type, fn) { documentListeners.add(type, fn); },
        removeEventListener(type, fn) { documentListeners.remove(type, fn); },
        hasFocus() { return true; }
    };

    const windowMock = {
        innerWidth: 1280,
        innerHeight: 720,
        addEventListener(type, fn) { windowListeners.add(type, fn); },
        removeEventListener(type, fn) { windowListeners.remove(type, fn); },
        getSelection() { return { toString: () => '' }; },
        open() { return null; }
    };
    windowMock.self = windowMock;
    windowMock.top = windowMock;
    windowMock.window = windowMock;

    const chromeMock = {
        runtime: {
            id: 'abcdefghijklmnopabcdefghijklmnop',
            lastError: null,
            getURL: (path) => path,
            sendMessage(_message, callback) { callback?.({ success: true, shouldShow: false }); },
            onMessage: {
                addListener(fn) { runtimeListeners.add(fn); },
                removeListener(fn) { runtimeListeners.delete(fn); }
            }
        },
        storage: {
            local: {
                get(_keys, callback) { callback({}); },
                set(_value, callback) { callback?.(); },
                remove(_key, callback) { callback?.(); }
            },
            onChanged: {
                addListener(fn) { storageListeners.add(fn); },
                removeListener(fn) { storageListeners.delete(fn); }
            }
        }
    };

    const context = vm.createContext({
        console,
        window: windowMock,
        document: documentMock,
        chrome: chromeMock,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (fn) => fn()
    });

    return {
        context,
        stale,
        byId,
        htmlElements,
        legacyCreateCalls,
        documentListeners,
        windowListeners,
        runtimeListeners,
        storageListeners,
        documentElement
    };
}

// SVG/XML系文書では document.createElement('div') が HTMLElement にならない状況を再現する。
// Content Script 一式は例外なく初期化され、拡張UIはHTML名前空間で生成されること。
{
    const scenario = createScenario({ staleHost: true });
    assert.doesNotThrow(() => vm.runInContext(source, scenario.context, { filename: 'content-modules.xml.js' }));

    const reader = scenario.context.window.__vvRadioReaderInstance;
    assert.ok(reader);
    assert.ok(reader.indicator, 'SVG/XML document でも indicator の初期化を継続できること');
    assert.equal(scenario.stale.removed, true, '再注入時の stale host を除去すること');

    const indicatorHost = scenario.byId.get('vvradio-host');
    assert.ok(indicatorHost);
    assert.equal(indicatorHost.namespaceURI, HTML_NS);
    assert.match(indicatorHost.style.cssText, /all:\s*initial/);
    assert.equal(typeof indicatorHost.attachShadow, 'function');

    assert.doesNotThrow(() => reader.showUpdateNoticeModal());
    const noticeHost = scenario.byId.get('vvradio-update-notice-host');
    assert.ok(noticeHost);
    assert.equal(noticeHost.namespaceURI, HTML_NS);

    assert.doesNotThrow(() => reader.startOcrSelection());
    const ocrHost = scenario.byId.get('vvradio-ocr-host');
    assert.ok(ocrHost);
    assert.equal(ocrHost.namespaceURI, HTML_NS);
    assert.ok(reader.ocrOverlay, 'OCR overlay が生成されること');

    assert.ok(scenario.htmlElements.length > 3);
    assert.equal(scenario.legacyCreateCalls.length, 0,
        '拡張機能所有UIは XML/SVG document の createElement() に依存しないこと');

    reader.deactivate();
}

// Shadow DOM 自体を利用できない環境では、ホストをページへ追加せずUIだけを安全に無効化する。
{
    const scenario = createScenario({ attachShadow: false });
    assert.doesNotThrow(() => vm.runInContext(source, scenario.context, { filename: 'content-modules.no-shadow.js' }));
    const reader = scenario.context.window.__vvRadioReaderInstance;
    assert.ok(reader);
    assert.equal(reader.indicator, null);
    assert.equal(scenario.documentElement.children.length, 0);
    assert.doesNotThrow(() => reader.showUpdateNoticeModal());
    assert.doesNotThrow(() => reader.startOcrSelection());
    assert.equal(scenario.documentElement.children.length, 0);
    assert.equal(scenario.runtimeListeners.size, 1, 'UIを無効化してもメッセージリスナーは維持すること');
    reader.deactivate();
}

console.log('content UI namespace contract: PASSED');
