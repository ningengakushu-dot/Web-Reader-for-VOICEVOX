const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const unsupported = [
    'segsearch_max_char_wh_ratio',
    'language_model_ngram_space_delimited_language',
    'language_model_ngram_scale_factor',
    'language_model_use_sigmoidal_certainty',
    'language_model_ngram_nonmatch_score',
    'classify_integer_matcher_multiplier',
    'assume_fixed_pitch_char_segment',
    'chop_enable',
    'allow_blob_division'
];

for (const name of ['jpn.traineddata', 'jpn_vert.traineddata']) {
    const data = fs.readFileSync(path.join(root, 'vendor', 'tesseract', 'lang', name));
    const componentCount = data.readInt32LE(0);
    const configStart = 4 + componentCount * 8;
    const configEnd = Number(data.readBigInt64LE(4 + 17 * 8));
    const config = data.subarray(configStart, configEnd).toString('utf8');
    for (const parameter of unsupported) {
        assert.doesNotMatch(config, new RegExp(`^${parameter}(?=\\s)`, 'm'),
            `${name}: LSTM専用コアにない設定を有効にしない`);
        assert.match(config, new RegExp(`^#${parameter.slice(1)}(?=\\s)`, 'm'),
            `${name}: 上流との差分を同じ長さのコメントとして保持する`);
    }
}

// Browser版Tesseract.jsはtraineddataをIndexedDBへ保存するため、拡張更新後も
// 旧モデルが残る。世代付きcachePathで、現在同梱している修正版traineddataへ
// 一度だけ切り替え、その後は通常どおりキャッシュを再利用することを固定する。
const cacheConfigSource = fs.readFileSync(path.join(root, 'tesseract-cache-config.js'), 'utf8');
let createWorkerArgs = null;
const tesseract = {
    createWorker(...args) {
        createWorkerArgs = args;
        return 'worker-result';
    }
};
vm.runInNewContext(cacheConfigSource, { Tesseract: tesseract });
const initConfig = { load_system_dawg: '0' };
const workerResult = tesseract.createWorker('jpn', 1, { gzip: false }, initConfig);
assert.equal(workerResult, 'worker-result');
assert.equal(createWorkerArgs[0], 'jpn');
assert.equal(createWorkerArgs[1], 1);
assert.equal(createWorkerArgs[2].gzip, false);
assert.match(createWorkerArgs[2].cachePath,
    /^web-reader-for-voicevox\/tessdata-config-v\d+$/,
    '旧IndexedDBキャッシュと衝突しない世代付きcachePathを使う');
assert.equal(createWorkerArgs[2].cacheMethod, undefined,
    'キャッシュを無効化せず、世代切替後は既定のwrite方式で再利用する');
assert.equal(createWorkerArgs[3], initConfig, 'createWorkerのinit configをそのまま渡す');

for (const page of ['offscreen.html', 'capture.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const tesseractIndex = html.indexOf('vendor/tesseract/tesseract.min.js');
    const cacheConfigIndex = html.indexOf('tesseract-cache-config.js');
    const ocrCommonIndex = html.indexOf('ocr-common.js');
    assert.ok(tesseractIndex >= 0 && cacheConfigIndex > tesseractIndex && ocrCommonIndex > cacheConfigIndex,
        `${page}: Tesseract本体の後、OCR共通処理の前にキャッシュ設定を読み込む`);
}

const packScript = fs.readFileSync(path.join(root, 'tools', 'pack.ps1'), 'utf8');
assert.match(packScript, /'tesseract-cache-config\.js'/,
    '配布ZIPにTesseractキャッシュ設定を含める');

console.log('tessdata LSTM-only compatibility and cache generation: PASSED');
