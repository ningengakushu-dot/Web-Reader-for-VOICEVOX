// 認識入力の余白付与（padOcrCanvas / estimateOcrBackgroundLuminance）、
// 余白付き座標系での局所再確認の端判定（collectVerticalGlyphRescanTargets の edgeInset）、
// 「全票が元寸以上」の漢字多数一致（fuseOcrSymbols）を、出荷ソースを vm で読み込んで検査する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

// ---- 最小限の canvas 実装（RGBA バッファ。fillRect / drawImage(整数オフセット) / getImageData） ----
class FakeContext {
    constructor(canvas) {
        this.canvas = canvas;
        this.fillStyle = '#000';
        this.imageSmoothingEnabled = false;
        this.imageSmoothingQuality = 'low';
    }
    fillRect(x, y, w, h) {
        const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(this.fillStyle).replace(/\s/g, ''));
        const [r, g, b] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) this.canvas.set(xx, yy, r, g, b, 255);
        }
    }
    drawImage(src, ...args) {
        // 対応: drawImage(src, dx, dy) と drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)（等倍）
        let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy;
        if (args.length === 2) [dx, dy] = args;
        else [sx, sy, sw, sh, dx, dy] = args;
        for (let yy = 0; yy < sh; yy++) {
            for (let xx = 0; xx < sw; xx++) {
                const p = src.get(sx + xx, sy + yy);
                this.canvas.set(dx + xx, dy + yy, p[0], p[1], p[2], p[3]);
            }
        }
    }
    getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const p = this.canvas.get(x + xx, y + yy);
                data.set(p, (yy * w + xx) * 4);
            }
        }
        return { data, width: w, height: h };
    }
    putImageData(imageData, x, y) {
        for (let yy = 0; yy < imageData.height; yy++) {
            for (let xx = 0; xx < imageData.width; xx++) {
                const i = (yy * imageData.width + xx) * 4;
                this.canvas.set(x + xx, y + yy, imageData.data[i], imageData.data[i + 1],
                    imageData.data[i + 2], imageData.data[i + 3]);
            }
        }
    }
}
class FakeCanvas {
    constructor() { this._width = 0; this._height = 0; this.buf = new Uint8ClampedArray(0); }
    get width() { return this._width; }
    set width(v) { this._width = v; this.buf = new Uint8ClampedArray(this._width * this._height * 4); }
    get height() { return this._height; }
    set height(v) { this._height = v; this.buf = new Uint8ClampedArray(this._width * this._height * 4); }
    get(x, y) { const i = (y * this._width + x) * 4; return [this.buf[i], this.buf[i + 1], this.buf[i + 2], this.buf[i + 3]]; }
    set(x, y, r, g, b, a) {
        if (x < 0 || y < 0 || x >= this._width || y >= this._height) return;
        const i = (y * this._width + x) * 4;
        this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = a;
    }
    getContext() { return new FakeContext(this); }
}
function makeCanvas(width, height, fill = 255, alpha = 255) {
    const c = new FakeCanvas();
    c.width = width; c.height = height;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) c.set(x, y, fill, fill, fill, alpha);
    return c;
}

const imageSource = fs.readFileSync(path.join(root, 'ocr-image.js'), 'utf8')
    + '\n;globalThis.imageTestApi = {padOcrCanvas, padOcrCanvasToMargin, measureOcrInkMargins, estimateOcrBackgroundLuminance, OCR_INPUT_PAD_PX};';
const imageContext = vm.createContext({
    console, Map, Set, Math, Number, Uint8Array, Uint8ClampedArray, Int32Array,
    document: { createElement: () => new FakeCanvas() }
});
vm.runInContext(imageSource, imageContext);
const image = imageContext.imageTestApi;

assert.equal(image.OCR_INPUT_PAD_PX, 10, '余白は 10px（実測で採用した値）');

{
    // 白背景に黒い文字が画像端に接している → 背景は白（255）
    const c = makeCanvas(40, 30, 255);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 6; x++) c.set(x, y, 0, 0, 0, 255);
    assert.equal(image.estimateOcrBackgroundLuminance(c), 255, '端に文字が接していても外周の最頻値は背景');
    // 暗背景（30）に白い文字 → 背景は 30
    const d = makeCanvas(40, 30, 30);
    for (let x = 0; x < 40; x++) d.set(x, 0, 255, 255, 255, 255);
    assert.equal(image.estimateOcrBackgroundLuminance(d), 30, '暗背景にも追従する');
    // 内部がグラデーションでも外周が一様なら外周の色
    const g = makeCanvas(40, 30, 200);
    for (let y = 3; y < 27; y++) for (let x = 3; x < 37; x++) g.set(x, y, x * 6, x * 6, x * 6, 255);
    assert.equal(image.estimateOcrBackgroundLuminance(g), 200, '外周の帯だけで推定する（内部の多数派に引きずられない）');
    // 透明画素は集計に入れない
    const t = makeCanvas(40, 30, 0, 0);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) if (x >= 20) t.set(x, y, 180, 180, 180, 255);
    assert.equal(image.estimateOcrBackgroundLuminance(t), 180, 'alpha<255 の画素は背景推定に使わない');
}

{
    // 辺ごとの余白付与
    const src = makeCanvas(20, 12, 240);
    src.set(0, 0, 10, 10, 10, 255);
    src.set(19, 11, 20, 20, 20, 255);
    const padded = image.padOcrCanvas(src, { left: 10, top: 10, right: 10, bottom: 10 });
    assert.equal(padded.width, 40);
    assert.equal(padded.height, 32);
    assert.deepEqual(padded.get(0, 0), [240, 240, 240, 255], '余白は背景色で塗る');
    assert.deepEqual(padded.get(39, 31), [240, 240, 240, 255]);
    assert.deepEqual(padded.get(10, 10), [10, 10, 10, 255], '元画像は (left, top) にそのまま置く');
    assert.deepEqual(padded.get(29, 21), [20, 20, 20, 255]);
    const uneven = image.padOcrCanvas(src, { left: 3, top: 0, right: 0, bottom: 7 }, 255);
    assert.equal(uneven.width, 23);
    assert.equal(uneven.height, 19);
    assert.deepEqual(uneven.get(3, 0), [10, 10, 10, 255], '足した辺だけずれる');
    assert.deepEqual(uneven.get(0, 18), [255, 255, 255, 255], '背景輝度を指定すればその色で塗る（二値化版は白）');
    assert.equal(image.padOcrCanvas(src, { left: 0, top: 0, right: 0, bottom: 0 }), src, '4辺とも 0 なら同じ canvas（無変更）');
    assert.equal(image.padOcrCanvas(src, null), src);
}

{
    // インクと画像端の距離
    const c = makeCanvas(60, 40, 255);
    for (let y = 5; y < 30; y++) for (let x = 0; x < 20; x++) c.set(x, y, 0, 0, 0, 255);   // 左端に接する黒
    for (let y = 8; y < 12; y++) for (let x = 40; x < 48; x++) c.set(x, y, 235, 235, 235, 255); // AA程度の薄い画素は数えない
    assert.deepEqual({ ...image.measureOcrInkMargins(c, 255) }, { left: 0, top: 5, right: 40, bottom: 10 });
    const blank = makeCanvas(30, 20, 255);
    assert.deepEqual({ ...image.measureOcrInkMargins(blank, 255) }, { left: 30, top: 20, right: 30, bottom: 20 },
        'インクが無ければ辺ごとに画像の幅/高さ');
}

{
    // 最低余白の確保: 足りない辺だけ足す。既に余白があれば無変更
    const tight = makeCanvas(50, 40, 250);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 15; x++) tight.set(x, y, 0, 0, 0, 255); // 左・上・下に接する
    const result = image.padOcrCanvasToMargin(tight, 10);
    assert.deepEqual({ ...result.insets }, { left: 10, top: 10, right: 0, bottom: 10 }, '右は 35px 空いているので足さない');
    assert.equal(result.canvas.width, 60);
    assert.equal(result.canvas.height, 60);
    assert.deepEqual(result.canvas.get(0, 0), [250, 250, 250, 255]);
    assert.deepEqual(result.canvas.get(10, 10), [0, 0, 0, 255]);

    const roomy = makeCanvas(60, 50, 255);
    for (let y = 12; y < 38; y++) for (let x = 12; x < 48; x++) roomy.set(x, y, 0, 0, 0, 255);
    const same = image.padOcrCanvasToMargin(roomy, 10);
    assert.equal(same.canvas, roomy, '4辺とも 10px 以上の余白がある画像はそのまま（出力不変）');
    assert.deepEqual({ ...same.insets }, { left: 0, top: 0, right: 0, bottom: 0 });

    const partial = makeCanvas(60, 50, 255);
    for (let y = 4; y < 46; y++) for (let x = 12; x < 48; x++) partial.set(x, y, 0, 0, 0, 255);
    const filled = image.padOcrCanvasToMargin(partial, 10);
    assert.deepEqual({ ...filled.insets }, { left: 0, top: 6, right: 0, bottom: 6 }, '不足分だけ足して 10px にそろえる');

    const dark = makeCanvas(50, 40, 20);
    for (let y = 0; y < 40; y++) for (let x = 35; x < 50; x++) dark.set(x, y, 255, 255, 255, 255); // 暗背景・右端に接する白文字
    const darkResult = image.padOcrCanvasToMargin(dark, 10);
    assert.deepEqual({ ...darkResult.insets }, { left: 0, top: 10, right: 10, bottom: 10 });
    assert.deepEqual(darkResult.canvas.get(59, 0), [20, 20, 20, 255], '暗背景には暗い余白を足す');
    assert.equal(image.padOcrCanvasToMargin(tight, 0).canvas, tight, '最低余白 0 なら無変更');
}

// ---- 局所再確認の端判定（余白付き座標系） ----
const refineSource = fs.readFileSync(path.join(root, 'ocr-refine.js'), 'utf8')
    + '\n;globalThis.refineTestApi = {collectVerticalGlyphRescanTargets, fuseOcrSymbols, buildTextFromBlocks};';
const refineContext = vm.createContext({ console, Map, Set, Math, Number, Uint8Array, Int32Array, RegExp });
vm.runInContext(refineSource, refineContext);
const refine = refineContext.refineTestApi;

function blocksForLines(texts, spans, offset = 0) {
    return [{ paragraphs: [{ lines: texts.map((text, index) => {
        const word = { text, symbols: [...text].map((char) => ({ text: char, confidence: 95 })) };
        return {
            bbox: { x0: 100 - index * 30 + offset, y0: offset, x1: 120 - index * 30 + offset, y1: spans[index] + offset },
            words: [word]
        };
    }) }] }];
}
function rescanFixture(offset) {
    const blocks = blocksForLines([
        '冷房の効いたフロア内には、黙々と異様な雰囲気をまといなが',
        'ら机に並べられたモニターと向かい合う男たちがいる。彼らはこ',
        'こ、Kソフトワークスの社員たちだ。中堅どころの企業であるか',
        'らして普段から何かしら忙しく働く彼らであるが、今日はその度',
        '合いの杵が違っていた。'
    ], [596, 618, 618, 618, 216], offset);
    const lastLine = blocks[0].paragraphs[0].lines[4];
    lastLine.bbox = { x0: 10 + offset, y0: 16 + offset, x1: 40 + offset, y1: 232 + offset };
    lastLine.confidence = 83;
    const symbols = lastLine.words[0].symbols;
    const pitch = 216 / symbols.length;
    symbols.forEach((symbol, index) => {
        symbol.bbox = { x0: 11 + offset, y0: 16 + offset + pitch * index, x1: 30 + offset, y1: 16 + offset + pitch * (index + 0.9) };
    });
    symbols[0].confidence = 99;
    symbols[3].confidence = 93;
    symbols[5].confidence = 98;
    return { blocks, lastLine };
}
{
    const plain = rescanFixture(0);
    const plainTargets = refine.collectVerticalGlyphRescanTargets(plain.blocks, 1, 186, 663);
    assert.deepEqual(Array.from(plainTargets, (t) => t.symbol.text), ['杵', '違']);
    // 同じ画像に 10px の余白を付けた座標系（bbox は +10、寸法は +20、edgeInset=10）でも同じ対象・同じ切り出し
    const padded = rescanFixture(10);
    const paddedTargets = refine.collectVerticalGlyphRescanTargets(padded.blocks, 1, 206, 683, { left: 10, top: 10, right: 10, bottom: 10 });
    assert.deepEqual(Array.from(paddedTargets, (t) => t.symbol.text), ['杵', '違'],
        '余白付きの座標系でも edgeInset を渡せば同じセルが対象になる');
    paddedTargets.forEach((t, i) => {
        assert.equal(Math.round(t.x - plainTargets[i].x), 10);
        assert.equal(Math.round(t.y - plainTargets[i].y), 10);
        assert.equal(t.width, plainTargets[i].width);
        assert.equal(t.height, plainTargets[i].height);
    });
    // 元の画像端に接する列（余白付き座標では x0 = 10）は、余白があっても除外される
    padded.lastLine.bbox.x0 = 10;
    padded.lastLine.bbox.x1 = 40;
    assert.equal(refine.collectVerticalGlyphRescanTargets(padded.blocks, 1, 206, 683, 10).length, 0,
        '元の画像端で欠けた可能性がある短列は、余白の内側の端を基準に除外する');
    assert.ok(refine.collectVerticalGlyphRescanTargets(padded.blocks, 1, 206, 683).length > 0,
        'edgeInset を渡さなければ従来どおり canvas の端だけを見る（後方互換）');
}

// ---- 「全票が元寸以上」の漢字多数一致 ----
function blocksFor(text, confidences = []) {
    const word = { text, symbols: [...text].map((char, index) => ({ text: char, confidence: confidences[index] ?? 98 })) };
    return [{ paragraphs: [{ lines: [{ words: [word] }] }] }];
}
function fuse(baseText, baseConfs, variants, options = { consensusClasses: ['kanji'] }) {
    const base = blocksFor(baseText, baseConfs);
    const replaced = refine.fuseOcrSymbols(base, variants.map(([t, c]) => blocksFor(t, c)), options);
    return { replaced, text: refine.buildTextFromBlocks(base) };
}
{
    // 元寸「除」98 に対し、候補3件のうち2件が「際」98/98、1件が「除」。
    // 平均のマージン（98 ≥ 98+3）では届かないが、全票が元寸以上かつ 95 以上なので採る。
    const r = fuse('王を除かね', [98, 98, 98, 98, 98], [
        ['王を際かね', [98, 98, 98, 98, 98]],
        ['王を際かね', [98, 98, 98, 98, 98]],
        ['王を除かね', [98, 98, 98, 98, 98]]
    ]);
    assert.equal(r.replaced, 1);
    assert.equal(r.text, '王を際かね', '全票が元寸以上・95以上の漢字多数一致で置換する');
}
{
    // 票の1つが 94 → 発火しない（下限 95）
    const r = fuse('王を除かね', [98, 98, 98, 98, 98], [
        ['王を際かね', [98, 98, 98, 98, 98]],
        ['王を際かね', [98, 98, 94, 98, 98]],
        ['王を除かね', [98, 98, 98, 98, 98]]
    ]);
    assert.equal(r.replaced, 0, '票の最小値が 95 未満なら発火しない');
}
{
    // 票 96/96 だが元寸 97 → 発火しない（元寸以上が条件）
    const r = fuse('王を除かね', [98, 98, 97, 98, 98], [
        ['王を際かね', [98, 98, 96, 98, 98]],
        ['王を際かね', [98, 98, 96, 98, 98]],
        ['王を除かね', [98, 98, 98, 98, 98]]
    ]);
    assert.equal(r.replaced, 0, '票が元寸の確信度を下回れば発火しない');
}
{
    // 仮名は対象外（漢字限定）
    const r = fuse('王をらかね', [98, 98, 98, 98, 98], [
        ['王をちかね', [98, 98, 98, 98, 98]],
        ['王をちかね', [98, 98, 98, 98, 98]],
        ['王をらかね', [98, 98, 98, 98, 98]]
    ]);
    assert.equal(r.replaced, 0, '仮名は全票一致でも置換しない');
}
{
    // 補充候補（unanimousVariantCount より後ろ）の票は数えない
    const r = fuse('王を除かね', [98, 98, 98, 98, 98], [
        ['王を除かね', [98, 98, 98, 98, 98]],
        ['王を際かね', [98, 98, 98, 98, 98]],
        ['王を際かね', [98, 98, 98, 98, 98]]
    ], { kanji: false, unanimousVariantCount: 1, consensusClasses: ['kanji'], consensusIncludesBase: true });
    assert.equal(r.replaced, 0, '2倍・二値化の補充票だけでは「全票が元寸以上」を成立させない');
}
{
    // 次点の平均が票の最小値を上回る → 発火しない
    const r = fuse('王を除かね', [98, 98, 95, 98, 98], [
        ['王を際かね', [98, 98, 95, 98, 98]],
        ['王を際かね', [98, 98, 95, 98, 98]],
        ['王を隙かね', [98, 98, 99, 98, 98]],
        ['王を除かね', [98, 98, 98, 98, 98]]
    ]);
    assert.equal(r.replaced, 0, '次点の平均が票の最小値を上回れば発火しない');
}
{
    // 従来のマージン経路は不変（平均が元寸・次点+3 以上なら 95 未満の票でも置換）
    const r = fuse('王を除かね', [98, 98, 88, 98, 98], [
        ['王を際かね', [98, 98, 92, 98, 98]],
        ['王を際かね', [98, 98, 92, 98, 98]],
        ['王を除かね', [98, 98, 85, 98, 98]]
    ]);
    assert.equal(r.replaced, 1, '従来の強い多数一致（平均マージン）はそのまま動く');
    assert.equal(r.text, '王を際かね');
}

console.log('OCR input padding / consensus-equal: PASSED');
