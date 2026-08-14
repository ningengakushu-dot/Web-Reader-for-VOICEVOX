const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-common.js'), 'utf8')
    + '\n;globalThis.localRescanTestApi = {'
    + 'refineVerticalGlyphsWithHorizontalWorker, '
    + 'applyVerticalGlyphRescanReplacements, createOcrWorkerPool};';

function createContext({ fail = false, failRestore = false } = {}) {
    const settings = [];
    const calls = [];
    const invalidated = [];
    const symbol = { text: '杵', confidence: 93 };
    const word = { text: '杵', symbols: [symbol] };
    const worker = {
        setParameters: async (parameters) => {
            settings.push(parameters.tessedit_pageseg_mode);
            if (failRestore && parameters.tessedit_pageseg_mode === '6') {
                throw new Error('restore failed');
            }
        },
        recognize: async (image) => {
            calls.push(image.kind);
            if (fail) throw new Error('recognition failed');
            const confidence = image.kind === 'binary' ? 96 : 94;
            return { data: { blocks: { text: '桁', confidence } } };
        }
    };
    const context = vm.createContext({
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
        Tesseract: { PSM: { SINGLE_CHAR: '10', SINGLE_BLOCK: '6' } },
        collectVerticalGlyphRescanTargets: () => [{
            word, symbol, x: 1, y: 2, width: 20, height: 24
        }],
        cropOcrCanvas: () => ({ kind: 'raw' }),
        prepareOcrCanvas: () => ({ kind: 'binary' }),
        upscaleOcrCanvas: (image, scale) => ({ kind: `gray-${scale}` }),
        extractSingleHanEvidence: (blocks) => ({
            text: blocks.text,
            confidence: blocks.confidence
        }),
        selectVerticalGlyphRescanReplacement: (base, gray, binary) => (
            gray?.text === '桁' && binary?.text === '桁' ? '桁' : null),
        rebuildOcrWordTexts: (words) => {
            for (const item of words) item.text = item.symbols.map((entry) => entry.text).join('');
        }
    });
    vm.runInContext(source, context);
    const provider = async () => worker;
    provider.invalidate = (lang, expected) => {
        invalidated.push({ lang, expected });
        return true;
    };
    return { context, provider, settings, calls, invalidated, worker, symbol, word };
}

(async () => {
    {
        const test = createContext();
        const replacements = await test.context.localRescanTestApi
            .refineVerticalGlyphsWithHorizontalWorker(
                { width: 100, height: 100 }, {}, 1, test.provider);
        assert.equal(replacements.length, 1,
            JSON.stringify({ calls: test.calls, settings: test.settings }));
        assert.equal(test.symbol.text, '杵', '並行処理中は共有blocksを変更しない');
        assert.equal(test.context.localRescanTestApi
            .applyVerticalGlyphRescanReplacements(replacements), 1);
        assert.equal(test.symbol.text, '桁');
        assert.equal(test.word.text, '桁');
        assert.deepEqual(test.calls, ['gray-2.5', 'binary', 'gray-3']);
        assert.deepEqual(test.settings, ['10', '6'],
            '処理後に横書きworkerのPSMをTesseract既定のSINGLE_BLOCKへ復元する');
    }

    {
        const test = createContext({ failRestore: true });
        const replacements = await test.context.localRescanTestApi
            .refineVerticalGlyphsWithHorizontalWorker(
                { width: 100, height: 100 }, {}, 1, test.provider);
        assert.equal(replacements.length, 1);
        assert.equal(test.invalidated.length, 1, 'PSM復元失敗時はworkerをプールから破棄する');
        assert.equal(test.invalidated[0].lang, 'jpn');
        assert.equal(test.invalidated[0].expected, test.worker);
    }

    {
        const test = createContext({ fail: true });
        const replacements = await test.context.localRescanTestApi
            .refineVerticalGlyphsWithHorizontalWorker(
                { width: 100, height: 100 }, {}, 1, test.provider);
        assert.equal(replacements.length, 0);
        assert.equal(test.symbol.text, '杵');
        assert.deepEqual(test.settings, ['10', '6'], '例外時にもPSMを復元する');
    }

    {
        const test = createContext();
        const failing = async () => { throw new Error('load failed'); };
        const replacements = await test.context.localRescanTestApi
            .refineVerticalGlyphsWithHorizontalWorker(
                { width: 100, height: 100 }, {}, 1, failing);
        assert.equal(replacements.length, 0, 'workerロード失敗時は局所補正なしで続行する');
    }

    {
        const finishCreates = [];
        let oldTerminated = 0;
        let newTerminated = 0;
        const oldWorker = { terminate: async () => { oldTerminated++; } };
        const newWorker = { terminate: async () => { newTerminated++; } };
        const context = vm.createContext({
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
            chrome: { runtime: { getURL: (value) => value } },
            Tesseract: {
                PSM: { SINGLE_BLOCK_VERT_TEXT: '5' },
                createWorker: () => new Promise((resolve) => { finishCreates.push(resolve); })
            }
        });
        vm.runInContext(source, context);
        const pool = context.localRescanTestApi.createOcrWorkerPool();
        const oldPending = pool.get('jpn');
        assert.equal(pool.get.peek('jpn'), null,
            '初期化中Promiseをロード済みworkerとして局所精錬へ渡さない');
        pool.terminate();
        const newPending = pool.get('jpn');
        finishCreates[0](oldWorker);
        assert.equal(await oldPending, oldWorker);
        await Promise.resolve();
        assert.equal(pool.get.peek('jpn'), null,
            '破棄済み世代の遅い初期化完了で新世代のready状態を汚染しない');
        finishCreates[1](newWorker);
        assert.equal(await newPending, newWorker);
        assert.equal(pool.get.peek('jpn'), newWorker);
        assert.equal(pool.get.invalidate('jpn', newWorker), true);
        assert.equal(pool.get.peek('jpn'), null);
        await Promise.resolve();
        assert.equal(oldTerminated, 1, '旧世代workerを破棄する');
        assert.equal(newTerminated, 1, '無効化した現世代workerを破棄する');
    }

    console.log('OCR local vertical-glyph rescan: PASSED');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
