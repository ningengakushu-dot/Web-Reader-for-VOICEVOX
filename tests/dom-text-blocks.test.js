// dom-text.js（範囲ドラッグ読み上げのページ内テキスト抽出）の段落境界の回帰検査。
//
// 2026-08-18 の監査で見つかった2件を固定する:
//  - display:flex で横に並べた SPAN/A のナビが1つの塊になり、素のテキスト選択より
//    劣化していた（タグ名の一覧だけで段落境界を決めていたため）
//  - <pre> の整形済みテキスト（表・ログ）で改行と桁揃えの空白が潰れ、行も列も融合していた
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'dom-text.js'), 'utf8')
    .replace('globalThis.VVRadioDomText = { collectRegionText, DOM_TEXT_MIN_CHARS };',
        'globalThis.VVRadioDomText = { collectRegionText, DOM_TEXT_MIN_CHARS,'
        + ' blockAncestorOf, joinTextUnits, createWorkContext };');

const context = vm.createContext({
    globalThis: null, console, setTimeout, clearTimeout, Map, Set, RegExp, Math, Date,
    performance: { now: () => 0 }
});
context.globalThis = context;
vm.runInContext(source, context);
const api = context.VVRadioDomText;

// --- 最小限の偽DOM。getComputedStyle は要素に持たせた display / whiteSpace を返す ---
function makeTree(spec) {
    const view = { getComputedStyle: (el) => el.__style };
    const document = { defaultView: view };
    const build = (node, parent) => {
        const el = {
            tagName: node.tag,
            parentElement: parent,
            ownerDocument: document,
            __style: { display: node.display || 'block', whiteSpace: node.whiteSpace || 'normal' }
        };
        el.children = (node.children || []).map((child) => build(child, el));
        // テキストノードは parentElement だけを持てばよい
        el.textNode = { parentElement: el };
        return el;
    };
    return build(spec, null);
}

// --- display:flex の子（CSS が表示値を block へ変える）は段落の切れ目になる ---
{
    const nav = makeTree({
        tag: 'NAV', display: 'flex',
        children: [
            { tag: 'SPAN', display: 'block' },
            { tag: 'SPAN', display: 'block' },
            { tag: 'A', display: 'block' }
        ]
    });
    const ctx = api.createWorkContext();
    const blocks = nav.children.map((child) => api.blockAncestorOf(child.textNode, ctx));
    assert.equal(blocks[0], nav.children[0], 'flexの子SPANはそれ自体が段落の箱');
    assert.notEqual(blocks[0], blocks[1], '項目ごとに別の箱になる');
    assert.notEqual(blocks[1], blocks[2], '項目ごとに別の箱になる');

    const units = nav.children.map((child, index) => ({
        text: ['会社概要', 'サービス一覧', 'お問い合わせ'][index], block: blocks[index] }));
    assert.equal(api.joinTextUnits(units), '会社概要\nサービス一覧\nお問い合わせ',
        '項目の間に区切りが入る（素のテキスト選択と同じ）');
}

// --- 文中の SPAN（display:inline）は文を割らない ---
{
    const para = makeTree({
        tag: 'P', display: 'block',
        children: [{ tag: 'SPAN', display: 'inline' }, { tag: 'EM', display: 'inline' }]
    });
    const ctx = api.createWorkContext();
    const blocks = para.children.map((child) => api.blockAncestorOf(child.textNode, ctx));
    assert.equal(blocks[0], para, 'インラインの祖先は段落そのもの');
    assert.equal(blocks[0], blocks[1], '同じ段落なら箱も同じ');
    assert.equal(
        api.joinTextUnits([{ text: 'これは', block: blocks[0] },
            { text: '強調', block: blocks[1] }, { text: 'です。', block: para }]),
        'これは強調です。', '文の途中で切らない');
}

// --- inline-block は文中のバッジにも使われるので、従来どおり文を割らない ---
{
    const para = makeTree({
        tag: 'P', display: 'block',
        children: [{ tag: 'SPAN', display: 'inline-block' }]
    });
    const ctx = api.createWorkContext();
    assert.equal(api.blockAncestorOf(para.children[0].textNode, ctx), para);
}

// --- <pre> の整形済みテキストは改行と桁揃えの空白を区切りとして残す ---
{
    const pre = makeTree({ tag: 'PRE', display: 'block', whiteSpace: 'pre' });
    const ctx = api.createWorkContext();
    const block = api.blockAncestorOf(pre.textNode, ctx);
    const text = '氏名   部署     内線\n佐藤   営業部   101\n鈴木   開発部   202';
    const joined = api.joinTextUnits([{ text, block, pre: true }]);
    assert.ok(!/氏名部署/.test(joined), '列が融合しない');
    assert.ok(!/101\s*鈴木/.test(joined) || /101\n鈴木/.test(joined), '行が融合しない');
    assert.equal(joined,
        '氏名\n部署\n内線\n佐藤\n営業部\n101\n鈴木\n開発部\n202');
}

// --- 通常の要素では従来どおり空白と改行を潰す（回帰防止） ---
{
    const para = makeTree({ tag: 'P', display: 'block' });
    const ctx = api.createWorkContext();
    const block = api.blockAncestorOf(para.textNode, ctx);
    assert.equal(
        api.joinTextUnits([{ text: '  この段落は\n  途中で折り返されている  ', block }]),
        'この段落は途中で折り返されている');
}

// --- 表示値が取れない環境ではタグ名で判定する（従来動作の保持） ---
{
    const view = null;
    const document = { defaultView: view };
    const div = { tagName: 'DIV', parentElement: null, ownerDocument: document };
    const span = { tagName: 'SPAN', parentElement: div, ownerDocument: document };
    const node = { parentElement: span };
    const ctx = api.createWorkContext();
    assert.equal(api.blockAncestorOf(node, ctx), div, 'SPANは飛ばしてDIVを段落とみなす');
}

console.log('dom-text-blocks: ok');
