const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const optionsHtml = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

assert.match(optionsHtml, /id="iconSize-slider"[^>]*min="16"[^>]*max="128"/,
    '設定画面でアイコンサイズを16pxから128pxまで選択できる');
assert.match(contentSource, /Math\.min\(128, Math\.max\(16, numeric\)\)/,
    '表示時のアイコンサイズを128pxまで許可する');
assert.match(contentSource, /Math\.min\(128, Math\.max\(16, rawSize\)\)/,
    '保存位置の復元時も128pxのサイズを考慮する');
assert.doesNotMatch(contentSource, /Math\.min\(64, Math\.max\(16, (?:numeric|rawSize)\)\)/,
    '旧64px上限を残さない');

console.log('icon size range 16-128px: PASSED');
