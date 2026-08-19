import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// tessdata_best のCJK設定には、Legacy OCR向けでLSTM専用コアには存在しない変数が残る。
// Tesseractはこれらを無視するが、拡張機能のエラーページへ毎回警告を記録するため、
// 該当行だけをコメント化する。行長を変えず、後続コンポーネントのオフセットと
// LSTMモデル本体のバイト列を完全に維持する。
const unsupportedByLstmOnlyCore = [
    "segsearch_max_char_wh_ratio",
    "language_model_ngram_space_delimited_language",
    "language_model_ngram_scale_factor",
    "language_model_use_sigmoidal_certainty",
    "language_model_ngram_nonmatch_score",
    "classify_integer_matcher_multiplier",
    "assume_fixed_pitch_char_segment",
    "chop_enable",
    "allow_blob_division"
];

const files = [
    resolve("vendor/tesseract/lang/jpn.traineddata"),
    resolve("vendor/tesseract/lang/jpn_vert.traineddata")
];

for (const file of files) {
    const data = readFileSync(file);
    const componentCount = data.readInt32LE(0);
    if (componentCount <= 17 || componentCount > 100) {
        throw new Error(`${file}: traineddataヘッダーが不正です`);
    }
    const configStart = 4 + componentCount * 8;
    const configEnd = Number(data.readBigInt64LE(4 + 17 * 8));
    if (configEnd <= configStart || configEnd > data.length) {
        throw new Error(`${file}: configコンポーネント範囲が不正です`);
    }

    const config = data.subarray(configStart, configEnd).toString("utf8");
    let cleaned = config;
    let changed = 0;
    for (const name of unsupportedByLstmOnlyCore) {
        const line = new RegExp(`^${name}(?=\\s)`, "m");
        if (line.test(cleaned)) {
            cleaned = cleaned.replace(line, `#${name.slice(1)}`);
            changed++;
        } else if (!new RegExp(`^#${name.slice(1)}(?=\\s)`, "m").test(cleaned)) {
            throw new Error(`${file}: 対象パラメータが見つかりません: ${name}`);
        }
    }

    const cleanedBytes = Buffer.from(cleaned, "utf8");
    if (cleanedBytes.length !== configEnd - configStart) {
        throw new Error(`${file}: configのバイト長が変化しました`);
    }
    if (changed > 0) {
        cleanedBytes.copy(data, configStart);
        writeFileSync(file, data);
    }
    console.log(`${file}: ${changed} parameter lines commented`);
}
