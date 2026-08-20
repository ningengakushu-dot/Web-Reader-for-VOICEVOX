import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parts = [
    'background-bootstrap.js',
    'background-playback.js',
    'background-runtime.js',
    'background-speech.js'
];
const normalizedParts = parts.map((file) =>
    readFileSync(join(root, file), 'utf8').replace(/\n+$/, ''));
const expected = "importScripts('constants.js');\n\n"
    + normalizedParts.join('\n\n') + '\n';
const bundlePath = join(root, 'background.js');

if (process.argv.includes('--check')) {
    const actual = readFileSync(bundlePath, 'utf8');
    if (actual !== expected) {
        console.error('background.js が分割ソースと一致しません。node tools/sync-background-bundle.mjs を実行してください。');
        process.exit(1);
    }
    console.log('background compatibility bundle: OK');
} else {
    writeFileSync(bundlePath, expected, 'utf8');
    console.log('background.js を分割ソースから再生成しました。');
}
