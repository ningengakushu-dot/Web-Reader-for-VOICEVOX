const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-common.js'), 'utf8')
    + '\n;globalThis.orientationTestApi = {resolveOcrOrientation};';

function createContext() {
    return vm.createContext({
        console,
        Promise,
        Date,
        Map,
        Set,
        RegExp,
        Uint8Array,
        Int32Array,
        setTimeout,
        clearTimeout,
        Tesseract: { PSM: { SINGLE_BLOCK_VERT_TEXT: '5' } }
    });
}

(async () => {
    {
        const context = createContext();
        vm.runInContext(source, context);
        const calls = [];
        const workerProvider = async (lang) => ({
            recognize: async (image, options, output) => {
                calls.push({ lang, image, output });
                return { data: { confidence: lang === 'jpn_vert' ? 89 : 70, blocks: [] } };
            }
        });
        const canvas = { width: 186, height: 663 };
        const output = { text: true, blocks: true };
        const resolved = await context.orientationTestApi.resolveOcrOrientation(
            canvas, workerProvider, output, 'horizontal');
        assert.equal(resolved.orientation, 'vertical',
            '局所パッチの有無にかかわらず曖昧入力は全体比較で縦書きへ救済する');
        assert.equal(resolved.fullData.jpn_vert.confidence, 89);
        assert.equal(calls.length, 2, '縦横の全体認識を各1回だけ行う');
        assert.ok(calls.every((call) => call.image === canvas && call.output === output));
    }

    {
        const context = createContext();
        vm.runInContext(source, context);
        const workerProvider = async (lang) => ({
            recognize: async () => ({
                data: { confidence: lang === 'jpn_vert' ? 82 : 79, blocks: [] }
            })
        });
        const resolved = await context.orientationTestApi.resolveOcrOrientation(
            {}, workerProvider, { text: true, blocks: true }, 'horizontal');
        assert.equal(resolved.orientation, 'horizontal',
            '方向間confidenceが拮抗する場合は画素統計の暫定方向を維持する');
    }

    {
        const context = createContext();
        vm.runInContext(source, context);
        const patch = { width: 240, height: 240 };
        const workerProvider = async (lang) => ({
            recognize: async () => ({
                data: { confidence: lang === 'jpn_vert' ? 71 : 72, blocks: [] }
            })
        });
        const resolved = await context.orientationTestApi.resolveOcrOrientation(
            patch, workerProvider, { text: true, blocks: true }, 'vertical', 0, false);
        assert.equal(resolved.orientation, 'horizontal',
            '大画像用の小領域比較は従来どおり高confidence側を採る');
        assert.equal(resolved.fullData, null,
            '小領域結果を全画像本文として再利用しない');
    }

    console.log('OCR orientation full-input fallback: PASSED');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
