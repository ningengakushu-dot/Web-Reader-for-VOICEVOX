// OCR進捗表示の検査:
// 1回のOCR要求では、主経路（元寸・全文）に加えて方向判定の並行認識・精錬・
// 短い縦列の局所確認が走り、横書き(jpn)と縦書き(jpn_vert)のworkerが並行して
// 交互に 0→1 の進捗を報告する。表示は主経路の進捗だけを使い、
// - 単調増加でOCR_PRIMARY_PROGRESS_SHAREを超えない（開始直後の張り付きが無い）
// - loggerがどのworker由来（lang）かを正しく識別する
// - 進捗表示の配線はOCRの認識結果・認識回数に一切影響しない
// ことを確認する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ocr-common.js'), 'utf8')
    + '\n;globalThis.progressTestApi = {createOcrWorkerPool, '
    + 'createPrimaryOcrProgressTracker, recognizeWithOrientation, '
    + 'OCR_PRIMARY_PROGRESS_SHARE};';

// 進捗の報告刻み。langごとに刻みと歩調を変え、並行認識の交互報告を再現する
const PROGRESS_STEPS = {
    jpn: [0, 0.2, 0.4, 0.6, 0.8, 1],
    jpn_vert: [0, 0.5, 1]
};

// 旧方式の再現実装（進捗の後退から回の切り替わりを推定する単一ストリーム前提の変換）。
// 並行・多数の認識では表示が100%近くへ張り付くことを対比のために確認する。
function legacyOverallProgress(messages) {
    let base = 0;
    let prev = 0;
    const values = [];
    for (const m of messages) {
        const p = Math.min(1, Math.max(0, m.progress || 0));
        if (p < prev - 0.05) base += (1 - base) * 0.6;
        prev = p;
        values.push(base + (1 - base) * 0.6 * p);
    }
    return values;
}

function createScenario({ ambiguous, horizontalConfidence, withLogger }) {
    const recognizeCalls = [];
    const events = [];
    const displayValues = [];

    const dataFor = (lang, image) => {
        if (image.kind === 'gray') {
            return lang === 'jpn_vert'
                ? { confidence: 88, blocks: { tag: 'v-full' } }
                : { confidence: horizontalConfidence, blocks: { tag: 'h-full' } };
        }
        if (image.kind === 'preprocessed') return { confidence: 60, blocks: { tag: 'pre' } };
        return { confidence: 65, blocks: { tag: image.kind } };
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
        chrome: { runtime: { getURL: (value) => value } },
        Tesseract: {
            PSM: { SINGLE_BLOCK_VERT_TEXT: '5', SINGLE_BLOCK: '6', SINGLE_CHAR: '10' },
            createWorker: (lang, oem, options) => Promise.resolve({
                setParameters: async () => {},
                terminate: async () => {},
                recognize: async (image) => {
                    recognizeCalls.push({ lang, kind: image.kind || 'source' });
                    // await を挟んで進捗を報告し、並行recognizeの交互到着を再現する。
                    // jpn_vert は歩調を落とし、進捗値の食い違い（旧方式の誤後退検知）を作る。
                    for (const progress of PROGRESS_STEPS[lang]) {
                        await Promise.resolve();
                        if (lang === 'jpn_vert') await Promise.resolve();
                        options.logger({ status: 'recognizing text', progress, emittedBy: lang });
                    }
                    return { data: dataFor(lang, image) };
                }
            })
        },
        toGrayscale: (canvas) => ({ kind: 'gray', width: canvas.width, height: canvas.height }),
        detectTextOrientation: () => (
            ambiguous
                ? { orientation: 'horizontal', confident: false }
                : { orientation: 'horizontal', confident: true }),
        OCR_ORIENTATION_FULL_COMPARE_MAX_AREA: 1000000,
        OCR_ORIENTATION_PATCH_PX: 240,
        pickOcrTextPatch: () => null,
        estimateGlyphSizeFromBlocks: () => 30,
        hasLikelyOcrLineInsertions: () => false,
        upscaleOcrCanvas: (image, scale) => ({
            kind: `up-${scale}`,
            width: (image.width || 100) * scale,
            height: (image.height || 100) * scale
        }),
        prepareOcrCanvas: (image) => ({
            kind: image.kind === 'glyph-raw' ? 'glyph-binary' : 'preprocessed',
            width: image.width,
            height: image.height
        }),
        buildTextFromBlocks: (blocks) => `text:${blocks.tag}`,
        pruneOcrLineInsertions: () => 0,
        fuseOcrSymbols: () => 0,
        protectOcrSymbolsFromWholeSwap: () => 0,
        OCR_FUSION_TRIGGER_GLYPH_PX: 18,
        OCR_FUSION_SCALES: [2, 3],
        OCR_FUSION_MAX_AREA: 1e9,
        OCR_CONSENSUS_TARGET_GLYPH_PX: [24],
        collectVerticalGlyphRescanTargets: () => [
            { word: {}, symbol: { text: '一' }, x: 0, y: 0, width: 20, height: 24 },
            { word: {}, symbol: { text: '二' }, x: 0, y: 30, width: 20, height: 24 }
        ],
        cropOcrCanvas: () => ({ kind: 'glyph-raw', width: 20, height: 24 }),
        extractSingleHanEvidence: () => null,
        selectVerticalGlyphRescanReplacement: () => null,
        rebuildOcrWordTexts: () => {}
    });
    vm.runInContext(source, context);

    const tracker = context.progressTestApi.createPrimaryOcrProgressTracker();
    const pool = context.progressTestApi.createOcrWorkerPool(withLogger
        ? (m, sourceInfo) => {
            events.push({
                emittedBy: m.emittedBy,
                sourceLang: sourceInfo.lang,
                primaryPass: sourceInfo.primaryPass,
                progress: m.progress
            });
            const value = tracker.update(m, sourceInfo);
            if (value != null) displayValues.push(value);
        }
        : undefined);

    const run = context.progressTestApi.recognizeWithOrientation(
        { width: 200, height: 300 }, pool.get);
    return { run, recognizeCalls, events, displayValues, share: context.progressTestApi.OCR_PRIMARY_PROGRESS_SHARE };
}

function assertMonotonic(values) {
    for (let i = 1; i < values.length; i++) {
        assert.ok(values[i] > values[i - 1],
            `表示進捗は単調増加のみ通知する: ${values[i - 1]} → ${values[i]}`);
    }
}

(async () => {
    // --- 曖昧方向（縦書き採用）: 全体並行比較＋精錬＋局所確認が全て走る経路 ---
    {
        const test = createScenario({
            ambiguous: true, horizontalConfidence: 70, withLogger: true
        });
        const result = await test.run;
        assert.equal(result.text, 'text:v-full', '縦書き全文認識の結果を採用する');
        assert.equal(result.confidence, 88);

        // 並行比較2回＋二値化＋融合用倍率＋局所確認（2セル×gray/binary）が走っている
        // （＝単一ストリーム前提が成り立たない状況を再現できている）ことの前提確認
        assert.ok(test.recognizeCalls.length >= 8,
            `認識が並行・多数実行される前提: ${JSON.stringify(test.recognizeCalls)}`);
        assert.ok(test.recognizeCalls.filter((c) => c.kind === 'glyph-binary').length === 2,
            '局所漢字確認の小画像サイクルが走っている');

        // (1) loggerはどのworker由来かを正しく識別する
        for (const event of test.events) {
            assert.equal(event.sourceLang, event.emittedBy,
                'source.lang が実際に報告したworkerのlangと一致する');
        }

        // (2) 主経路の目印は、各workerの最初の全文認識（並行比較）だけに付く
        for (const lang of ['jpn', 'jpn_vert']) {
            const byLang = test.events.filter((e) => e.sourceLang === lang);
            const tagged = byLang.filter((e) => e.primaryPass);
            assert.equal(tagged.length, PROGRESS_STEPS[lang].length,
                `${lang} は全文並行比較の1認識だけが主経路になる`);
            const lastTagged = byLang.lastIndexOf(tagged[tagged.length - 1]);
            const firstUntagged = byLang.findIndex((e) => !e.primaryPass);
            assert.ok(firstUntagged === -1 || firstUntagged > lastTagged,
                `${lang} の主経路目印は先頭の認識に閉じる（精錬・局所確認に付かない）`);
        }

        // (3) 表示は単調増加で、主経路の持ち分を超えて張り付かない
        assert.ok(test.displayValues.length > 0, '主経路の進捗は表示に届く');
        assertMonotonic(test.displayValues);
        assert.ok(test.displayValues.every((v) => v <= test.share + 1e-9),
            `表示は主経路の持ち分(${test.share})を超えない`);
        assert.ok(Math.abs(test.displayValues[test.displayValues.length - 1] - test.share) < 1e-9,
            '主経路（両workerの並行比較）完了で持ち分いっぱいまで進む');

        // (4) 対比: 旧方式（後退検知の単一ストリーム変換）は同じメッセージ列で張り付く
        const legacy = legacyOverallProgress(
            test.events.map((e) => ({ progress: e.progress })));
        assert.ok(Math.max(...legacy) > 0.9,
            '旧方式は並行・多数認識の進捗列で90%超へ張り付く（修正対象の再現）');
    }

    // --- 確定方向（横書き・高確信度）: 主経路1回だけの経路 ---
    {
        const test = createScenario({
            ambiguous: false, horizontalConfidence: 95, withLogger: true
        });
        const result = await test.run;
        assert.equal(result.text, 'text:h-full');
        assert.deepEqual(test.recognizeCalls, [{ lang: 'jpn', kind: 'gray' }],
            '高確信度の確定方向では元寸全文の1認識だけが走る');
        assert.ok(test.events.every((e) => e.primaryPass && e.sourceLang === 'jpn'),
            '唯一の認識が主経路として目印される');
        assertMonotonic(test.displayValues);
        assert.ok(Math.abs(test.displayValues[test.displayValues.length - 1] - test.share) < 1e-9);
    }

    // --- 表示のみの変更であること: logger の有無で認識結果・認識回数が変わらない ---
    {
        const withLogger = createScenario({
            ambiguous: true, horizontalConfidence: 70, withLogger: true
        });
        const withoutLogger = createScenario({
            ambiguous: true, horizontalConfidence: 70, withLogger: false
        });
        const [resultWith, resultWithout] = await Promise.all([
            withLogger.run, withoutLogger.run
        ]);
        // 2つの実行は別のvmコンテキスト（別realm）のため、値で比較する
        assert.equal(resultWith.text, resultWithout.text,
            '進捗表示の配線はOCRの出力（text）に影響しない');
        assert.equal(resultWith.confidence, resultWithout.confidence,
            '進捗表示の配線はOCRの出力（confidence）に影響しない');
        assert.equal(JSON.stringify(withLogger.recognizeCalls),
            JSON.stringify(withoutLogger.recognizeCalls),
            '進捗表示の配線は認識の回数・順序・対象画像に影響しない');
    }

    console.log('OCR primary-pass progress display: PASSED');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
