const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('    toggleReading() {');
const end = source.indexOf('\n    // TOGGLE_READING', start);
assert.ok(start >= 0 && end > start, 'toggleReading の実装が見つかる');

const body = source.slice(start, end);
assert.match(body, /this\.updateUIState\(['"]error['"]\)/,
  '未選択時のページ内エラー表示を維持する');
assert.doesNotMatch(body, /console\.(?:warn|error)\s*\(/,
  'テキスト未選択は想定内操作のため拡張機能エラーへ記録しない');

console.log('expected user actions: PASSED');
