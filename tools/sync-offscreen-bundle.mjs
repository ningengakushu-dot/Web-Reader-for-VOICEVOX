import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parts = ['offscreen-entry.js', 'offscreen-ocr.js', 'offscreen-audio.js'];
const expected = parts.map((file) => readFileSync(join(root, file), 'utf8')).join('');
const bundlePath = join(root, 'offscreen.js');
if (process.argv.includes('--check')) {
    if (readFileSync(bundlePath, 'utf8') !== expected) {
        console.error('offscreen.js が分割ソースと一致しません。node tools/sync-offscreen-bundle.mjs を実行してください。');
        process.exit(1);
    }
    console.log('offscreen compatibility bundle: OK');
} else {
    writeFileSync(bundlePath, expected, 'utf8');
    console.log('offscreen.js を分割ソースから再生成しました。');
}
