const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-image.js'), 'utf8')
    + '\n;globalThis.readbackTestApi = {readOcrCanvasPixels, cropToOcrCanvas, padOcrCanvasToMargin, toGrayscale, prepareOcrCanvas, upscaleOcrCanvas};';

class FakeContext {
    constructor(canvas) {
        this.canvas = canvas;
        this.fillStyle = '#000';
        this.imageSmoothingEnabled = false;
        this.imageSmoothingQuality = 'low';
    }
    drawImage(src, ...args) {
        const dx = args.length === 2 ? args[0] : (args[4] ?? 0);
        const dy = args.length === 2 ? args[1] : (args[5] ?? 0);
        const dw = args.length >= 8 ? args[6] : src.width;
        const dh = args.length >= 8 ? args[7] : src.height;
        for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
                const sx = Math.min(src.width - 1, Math.floor(x * src.width / Math.max(1, dw)));
                const sy = Math.min(src.height - 1, Math.floor(y * src.height / Math.max(1, dh)));
                const p = src.get(sx, sy);
                this.canvas.set(dx + x, dy + y, p[0], p[1], p[2], p[3]);
            }
        }
    }
    fillRect(x, y, w, h) {
        const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(this.fillStyle).replace(/\s/g, ''));
        const [r, g, b] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
            this.canvas.set(xx, yy, r, g, b, 255);
        }
    }
    getImageData(x, y, w, h) {
        this.canvas.readbacks++;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
            data.set(this.canvas.get(x + xx, y + yy), (yy * w + xx) * 4);
        }
        return { data, width: w, height: h };
    }
    putImageData(imageData, x, y) {
        for (let yy = 0; yy < imageData.height; yy++) for (let xx = 0; xx < imageData.width; xx++) {
            const i = (yy * imageData.width + xx) * 4;
            this.canvas.set(x + xx, y + yy,
                imageData.data[i], imageData.data[i + 1], imageData.data[i + 2], imageData.data[i + 3]);
        }
    }
}

class FakeCanvas {
    constructor() {
        this._width = 0;
        this._height = 0;
        this.buf = new Uint8ClampedArray(0);
        this.context = null;
        this.firstContextOptions = undefined;
        this.readbacks = 0;
    }
    get width() { return this._width; }
    set width(value) { this._width = value; this._reset(); }
    get height() { return this._height; }
    set height(value) { this._height = value; this._reset(); }
    _reset() { this.buf = new Uint8ClampedArray(this._width * this._height * 4); }
    getContext(type, options) {
        assert.equal(type, '2d');
        if (!this.context) {
            this.firstContextOptions = options;
            this.context = new FakeContext(this);
        }
        return this.context;
    }
    get(x, y) {
        const i = (y * this._width + x) * 4;
        return [this.buf[i], this.buf[i + 1], this.buf[i + 2], this.buf[i + 3]];
    }
    set(x, y, r, g, b, a) {
        if (x < 0 || y < 0 || x >= this._width || y >= this._height) return;
        const i = (y * this._width + x) * 4;
        this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = a;
    }
}

const created = [];
const context = vm.createContext({
    console, Math, Number, Map, Set, Uint8Array, Uint8ClampedArray, Int32Array, Float64Array,
    document: { createElement: () => { const canvas = new FakeCanvas(); created.push(canvas); return canvas; } }
});
vm.runInContext(source, context);
const api = context.readbackTestApi;

function makeCanvas(width, height, fill = 255) {
    const canvas = new FakeCanvas();
    canvas.width = width;
    canvas.height = height;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        canvas.set(x, y, fill, fill, fill, 255);
    }
    return canvas;
}

{
    created.length = 0;
    const sourceCanvas = makeCanvas(12, 10, 255);
    const output = api.cropToOcrCanvas(sourceCanvas, 1, 1, 8, 6);
    assert.equal(output.firstContextOptions?.willReadFrequently, true,
        'OCR切り出しCanvasは後段で画素を読むため、最初のcontext生成時からreadback向けにする');
}

{
    const sourceCanvas = makeCanvas(30, 20, 255);
    sourceCanvas.set(0, 5, 0, 0, 0, 255);
    const result = api.padOcrCanvasToMargin(sourceCanvas, 10);
    assert.equal(sourceCanvas.readbacks, 1,
        '背景推定とインク余白測定は同じ画素スナップショットを共有して全画面readbackを1回にする');
    assert.deepEqual({ ...result.insets }, { left: 10, top: 5, right: 0, bottom: 0 });
    assert.equal(sourceCanvas.firstContextOptions?.willReadFrequently, true,
        '画素読み出し用コンテキストではwillReadFrequentlyを最初から要求する');
}

{
    created.length = 0;
    const sourceCanvas = makeCanvas(8, 8, 255);
    sourceCanvas.set(2, 2, 0, 0, 0, 255);
    api.toGrayscale(sourceCanvas);
    const output = created.at(-1);
    assert.equal(output.firstContextOptions?.willReadFrequently, true,
        'グレースケール出力は直後と後段で画素を読むためreadback向けにする');
}

{
    created.length = 0;
    const sourceCanvas = makeCanvas(10, 10, 255);
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) sourceCanvas.set(x, y, 0, 0, 0, 255);
    api.prepareOcrCanvas(sourceCanvas);
    const output = created.at(-1);
    assert.equal(output.firstContextOptions?.willReadFrequently, true,
        '二値化用CanvasはgetImageDataを行うためreadback向けにする');
}

{
    created.length = 0;
    const sourceCanvas = makeCanvas(5, 5, 255);
    api.upscaleOcrCanvas(sourceCanvas, 2);
    const output = created.at(-1);
    assert.notEqual(output.firstContextOptions?.willReadFrequently, true,
        '読み出しを行わない拡大Canvasまで一律にCPU readback向けへ変更しない');
}

console.log('OCR canvas readback hint / single snapshot: PASSED');
