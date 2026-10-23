const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background-speech.js'), 'utf8')
    + ';globalThis.api = { splitText, speechCost, SPEECH_SOFT_COST };', context);
const split = (text) => Array.from(context.api.splitText(text));
const body = 'システム監査基準では、システム監査の実施に際し、'
    + 'システム監査に対するニーズを十分に把握した上で監査業務を行うことを求めています。';

for (const prefix of ['正しい。', 'はい。正しい。', '「正しい。」', 'そうです！本当？']) {
    const text = prefix + body;
    const chunks = split(text);
    assert.ok(chunks[0].startsWith(prefix), '短文と句点・閉じ括弧を残す');
    assert.ok(chunks[0].length > prefix.length, '短文だけを再生して直後の長文合成を待たない');
    assert.ok(context.api.speechCost(chunks[0]) <= 40, '先頭の合成を長文化させない');
    assert.equal(chunks.join(''), text, '全文を順番どおりに残す');
    assert.ok(chunks.every((chunk) => context.api.speechCost(chunk) <= context.api.SPEECH_SOFT_COST));
}
const paragraphs = split('正しい。\n' + body);
assert.equal(paragraphs[0], '正しい。', '段落境界は維持する');
assert.equal(paragraphs.slice(1).join(''), body);
assert.deepEqual(split('正しい。'), ['正しい。'], '最後の短文だけでも読める');
const repeated = 'はい。'.repeat(200);
const repeatedChunks = split(repeated);
assert.equal(repeatedChunks.join(''), repeated);
assert.ok(repeatedChunks.every((chunk) => context.api.speechCost(chunk) <= context.api.SPEECH_SOFT_COST),
    '短文が続いても無制限に結合しない');
console.log('speech sentence gap: PASSED');
