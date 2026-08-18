// 罫線・枠線の除去（ocr-image.js の removeOcrRuleLines）の検査。
//
// 表の罫線やボタンの枠は横書きworkerの行分割を壊し、セルや枠内の語が丸ごと落ちる
// （実測は docs/OCR-ACCURACY.md 2026-08-18(6)）。一方で、この処理が文字の画を巻き込むと
// 見出しの横画が消えるといった別の壊れ方をするため、次の性質を固定する:
//   1. 長い直線が1本も無い画像は**1画素も変えない**（既存51入力で出力バイト一致の根拠）
//   2. 細く長い直線だけを消し、同じ長さでも太いものは残す
//   3. 明暗が反転した配色（ダークモード）でも同じように働く
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- 最小限の canvas（RGBAのフレームバッファ） ----
function createStubCanvas(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    const canvas = {
        width, height, __data: data,
        getContext: () => ({
            getImageData: (x, y, w, h) => {
                assert.equal(x, 0); assert.equal(y, 0);
                assert.equal(w, canvas.width); assert.equal(h, canvas.height);
                return { data: canvas.__data, width: w, height: h };
            },
            putImageData: (imageData) => { canvas.__data.set(imageData.data); },
            drawImage: (source) => { canvas.__data.set(source.__data); }
        })
    };
    return canvas;
}
function fill(canvas, level) {
    for (let i = 0; i < canvas.__data.length; i += 4) {
        canvas.__data[i] = level; canvas.__data[i + 1] = level;
        canvas.__data[i + 2] = level; canvas.__data[i + 3] = 255;
    }
}
function rect(canvas, x0, y0, w, h, level) {
    for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
            const i = (y * canvas.width + x) * 4;
            canvas.__data[i] = level; canvas.__data[i + 1] = level;
            canvas.__data[i + 2] = level; canvas.__data[i + 3] = 255;
        }
    }
}
// 「本文らしい短い画」: 10px の縦棒を等間隔に並べる
function drawStrokes(canvas, level) {
    for (let n = 0; n < 10; n++) rect(canvas, 5 + n * 9, 5, 1, 10, level);
}
function luminanceAt(canvas, x, y) {
    return canvas.__data[(y * canvas.width + x) * 4];
}

const source = fs.readFileSync(path.join(__dirname, '..', 'ocr-image.js'), 'utf8')
    + '\n;globalThis.__test = { removeOcrRuleLines };';
const context = vm.createContext({
    console, Math, Number, Infinity, Int32Array, Uint8Array, Uint8ClampedArray,
    document: { createElement: () => createStubCanvas(1, 1) }
});
vm.runInContext(source, context, { filename: 'ocr-image.js' });
const { removeOcrRuleLines } = context.__test;

// createOcrCanvas は document.createElement 経由で width/height を後から設定する。
// stub の canvas は width/height を書き換えても __data の長さが変わらないので、
// 設定に追従して張り直す。
context.document.createElement = () => {
    const canvas = createStubCanvas(1, 1);
    let width = 1;
    let height = 1;
    Object.defineProperty(canvas, 'width', {
        get: () => width,
        set: (value) => { width = value; canvas.__data = new Uint8ClampedArray(width * height * 4); }
    });
    Object.defineProperty(canvas, 'height', {
        get: () => height,
        set: (value) => { height = value; canvas.__data = new Uint8ClampedArray(width * height * 4); }
    });
    return canvas;
};

// --- 1. 長い直線が無ければ元の canvas をそのまま返す（無変更） ---
{
    const canvas = createStubCanvas(100, 40);
    fill(canvas, 255);
    drawStrokes(canvas, 0);
    assert.equal(removeOcrRuleLines(canvas), canvas,
        '本文だけの画像は同じ canvas を返す（画素を1つも触らない）');
}

// --- 2. 細く長い直線（罫線）だけを消す。本文の画は残す ---
{
    const canvas = createStubCanvas(100, 40);
    fill(canvas, 255);
    drawStrokes(canvas, 0);
    rect(canvas, 5, 30, 90, 1, 0);
    const cleaned = removeOcrRuleLines(canvas);
    assert.notEqual(cleaned, canvas, '罫線があれば別の canvas を返す');
    assert.equal(luminanceAt(cleaned, 50, 30), 255, '罫線は背景色で塗られる');
    assert.equal(luminanceAt(cleaned, 5, 8), 0, '本文の画は残る');
    assert.equal(luminanceAt(canvas, 50, 30), 0, '元の canvas は書き換えない');
}

// --- 3. 同じ長さでも太いもの（帯・塗り）は罫線とみなさない ---
{
    const canvas = createStubCanvas(100, 40);
    fill(canvas, 255);
    drawStrokes(canvas, 0);
    rect(canvas, 5, 28, 90, 6, 0);
    assert.equal(removeOcrRuleLines(canvas), canvas, '太さ6pxの帯は消さない');
}

// --- 4. 明暗が反転した配色（ダークモード）でも同じように働く ---
{
    const canvas = createStubCanvas(100, 40);
    fill(canvas, 20);
    drawStrokes(canvas, 235);
    rect(canvas, 5, 30, 90, 1, 235);
    const cleaned = removeOcrRuleLines(canvas);
    assert.notEqual(cleaned, canvas);
    assert.equal(luminanceAt(cleaned, 50, 30), 0, '暗い背景色で塗り戻す');
    assert.equal(luminanceAt(cleaned, 5, 8), 235, '白抜きの本文は残る');
}

// --- 5. 交点のある枠（表の罫線）は、交点も含めて消える ---
// 中央1点だけで太さを測ると交点で「太い」と誤判定して消し残り、その断片が
// 縦棒 | として読み上げに混ざっていた。
{
    const canvas = createStubCanvas(100, 60);
    fill(canvas, 255);
    drawStrokes(canvas, 0);
    rect(canvas, 5, 45, 90, 1, 0);
    rect(canvas, 50, 20, 1, 35, 0);
    const cleaned = removeOcrRuleLines(canvas);
    assert.equal(luminanceAt(cleaned, 50, 45), 255, '交点も消える');
    assert.equal(luminanceAt(cleaned, 50, 30), 255, '縦の罫線も消える');
    assert.equal(luminanceAt(cleaned, 20, 45), 255, '横の罫線も消える');
}

console.log('ocr rule lines: PASSED');
