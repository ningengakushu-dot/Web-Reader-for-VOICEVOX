const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function target() {
    const listeners = new Map();
    return {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        emit(type, event = {}) {
            for (const fn of [...(listeners.get(type) || [])]) fn(event);
        },
        count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); }
    };
}

function harness() {
    const document = target();
    const surfaces = new Set();
    document.createElement = () => ({ remove() { surfaces.delete(this); } });
    const window = Object.assign(target(), { innerWidth: 800, innerHeight: 600 });
    const captures = new Set();
    const indicator = Object.assign(target(), {
        style: {}, offsetWidth: 32, offsetHeight: 32,
        setPointerCapture(id) { captures.add(id); },
        hasPointerCapture(id) { return captures.has(id); },
        releasePointerCapture(id) { captures.delete(id); },
        classList: { add() {}, remove() {} }
    });
    Object.defineProperties(indicator, {
        offsetLeft: { get() { return parseFloat(this.style.left ?? '100'); } },
        offsetTop: { get() { return parseFloat(this.style.top ?? '100'); } }
    });
    const saved = [];
    const content = { parts: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'content-indicator.js'), 'utf8'), {
        VVRadioContent: content, document, window,
        chrome: { runtime: { id: 'test' }, storage: { local: { set(value) { saved.push(value); } } } }
    });
    const reader = Object.assign({ indicator, active: true,
        shadowRoot: { appendChild(el) { surfaces.add(el); } }
    }, content.parts.indicator);
    const moved = reader.enableIndicatorDrag();
    const event = (overrides = {}) => ({
        pointerId: 1, button: 0, buttons: 1, isPrimary: true,
        clientX: 110, clientY: 110, preventDefault() {}, ...overrides
    });
    const down = (overrides) => indicator.emit('pointerdown', event(overrides));
    const move = (overrides) => document.emit('pointermove', event(overrides));
    const up = (overrides) => document.emit('pointerup', event({ buttons: 0, ...overrides }));
    return { reader, indicator, document, window, captures, surfaces, saved, moved, event, down, move, up };
}

{
    const h = harness();
    let prevented = false;
    h.down({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'クリック前の選択範囲とフレームフォーカスを維持する');
    assert.ok(h.captures.has(1), 'iframe上やアイコン外でも同じポインターを捕捉する');
    assert.equal(h.surfaces.size, 1, '捕捉直後のiframeへの高速移動も受け取る');
    h.move({ clientX: 710, clientY: 410 });
    assert.equal(h.indicator.style.left, '700px', '速い移動でも掴んだ位置を維持する');
    assert.equal(h.indicator.style.top, '400px');
    h.up({ clientX: 730, clientY: 430 });
    assert.equal(h.indicator.style.left, '720px', '最後のpointerup座標も反映する');
    assert.equal(h.indicator.style.top, '420px');
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].vvradio_icon_pos.left, 720);
    assert.equal(h.moved(), true, 'ドラッグ直後のクリックで読み上げを開始しない');
    assert.equal(h.captures.size, 0);
    assert.equal(h.surfaces.size, 0);
    assert.equal(h.document.count(), 0);
    assert.equal(h.window.count(), 0);
    h.move({ clientX: 200 });
    assert.equal(h.indicator.style.left, '720px', 'ボタン解放後は近づけても吸着しない');
    h.down({ clientX: 730, clientY: 430 });
    h.up({ clientX: 732, clientY: 432 });
    assert.equal(h.moved(), false, '3px以内の揺れなら通常クリックとして扱う');
    assert.equal(h.saved.length, 1);
}

{
    const h = harness();
    h.down({ button: 2 });
    assert.equal(h.captures.size, 0, '右クリックのOCR・設定動作に干渉しない');
    h.down();
    h.move({ pointerId: 2, clientX: 600 });
    assert.equal(h.moved(), false, '別の指やペンでは動かさない');
    h.up({ pointerId: 2 });
    assert.ok(h.captures.has(1));
    h.move({ clientX: 1000, clientY: -100 });
    assert.equal(h.indicator.style.left, '768px');
    assert.equal(h.indicator.style.top, '0px');
    h.move({ clientX: 500, buttons: 0 });
    assert.equal(h.captures.size, 0, 'mouseupを失ってもボタン解放で終了する');
    assert.equal(h.indicator.style.left, '768px');
}

for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'deactivate']) {
    const h = harness();
    h.down();
    h.move({ clientX: 210 });
    if (reason === 'blur') h.window.emit('blur');
    else if (reason === 'deactivate') { h.reader.active = false; h.reader.indicatorDragCleanup(); }
    else if (reason === 'lostpointercapture') h.indicator.emit(reason, h.event());
    else h.document.emit(reason, h.event());
    assert.equal(h.document.count(), 0, `${reason}: 文書リスナーを残さない`);
    assert.equal(h.window.count(), 0, `${reason}: windowリスナーを残さない`);
    assert.equal(h.captures.size, 0, `${reason}: キャプチャを残さない`);
    assert.equal(h.surfaces.size, 0, `${reason}: ページ操作を遮る面を残さない`);
    h.move({ clientX: 310 });
    assert.equal(h.indicator.style.left, '200px', `${reason}: 終了後に吸着しない`);
    assert.equal(h.saved.length, reason === 'deactivate' ? 0 : 1);
}

console.log('indicator drag capture, release, selection and cleanup: PASSED');
