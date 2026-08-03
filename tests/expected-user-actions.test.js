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

const reviewUrl = 'https://chromewebstore.google.com/detail/web-reader-for-voicevox/ilcfondcjhaalpcghnhcejioopcbhhla/reviews';
assert.ok(source.includes(reviewUrl), '公開済み拡張機能のレビューページを開く');
assert.ok(!source.includes('detail/web-reader-for-voicevox/${chrome.runtime.id}'),
  '開発者モードの一時的な拡張機能IDをストアURLに使用しない');
assert.ok(source.includes('率直なご感想や評価をお寄せください。今後の改善に活用します。'),
  '中立的なレビュー案内を表示する');
assert.ok(source.includes('評価する'), '中立的なボタン文言を表示する');
assert.doesNotMatch(source, /(?:星\s*5|5\s*つ星|★\s*5)/,
  '特定の高評価を促す文言を含めない');
console.log('expected user actions and store feedback link: PASSED');
