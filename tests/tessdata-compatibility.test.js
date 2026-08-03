const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

console.log('tessdata LSTM-only compatibility: PASSED');
