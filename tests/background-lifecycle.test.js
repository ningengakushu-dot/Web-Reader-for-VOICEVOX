// background.js の公開前監査で修正した挙動の回帰検査:
// - 読み上げ中のタブを閉じたら offscreen の再生を止める（存在しない offscreen は作らない）
// - 停止要求（STOP_ALL）は offscreen が無ければ生成しない
// - キャプチャ前後に対象タブが切り替わったら、別タブの画像をOCRしない
// - 古い範囲OCRの結果（選び直し・停止・別読み上げより前の要求）は読み上げない
// - Service Worker のメモリが消えても storage.session からOCR状態を復元する
// - 句点の無い長文は読点・空白で上限以内へ二次分割し、文字を落とさない
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8')
    + '\n;globalThis.__test = { splitText, resetOcrMemory: () => latestOcrRequestByTab.clear() };';

let onMessage;
let onRemoved;
let onUpdated;
let offscreenExists = false;
let createDocumentCalls = 0;
const offscreenMessages = [];
const tabMessages = [];
const sessionData = {};
const localData = {};
const local = {
    get(keys, callback) {
        const result = Array.isArray(keys)
            ? Object.fromEntries(keys.map((k) => [k, localData[k]]))
            : { ...keys, ...localData };
        if (callback) { callback(result); return; }
        return Promise.resolve(result);
    },
    set(value, callback) { Object.assign(localData, value); if (callback) callback(); return Promise.resolve(); },
    remove(_k, callback) { if (callback) callback(); return Promise.resolve(); }
};
const session = {
    get(key) { return Promise.resolve(key in sessionData ? { [key]: sessionData[key] } : {}); },
    set(value) { Object.assign(sessionData, value); return Promise.resolve(); },
    remove(key) { delete sessionData[key]; return Promise.resolve(); }
};
const chrome = {
    runtime: {
        id: 'ext-id', lastError: null, getURL: (p) => `chrome-extension://ext-id/${p}`,
        getContexts: () => Promise.resolve(offscreenExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
        sendMessage: (message) => {
            if (message.target === 'offscreen') {
                offscreenMessages.push(message);
                return Promise.resolve({ success: true });
            }
            return Promise.resolve({ success: true });
        },
        onInstalled: { addListener() {} }, onMessage: { addListener(fn) { onMessage = fn; } },
        openOptionsPage() {}
    },
    scripting: { executeScript: () => Promise.resolve() },
    storage: { local, session },
    contextMenus: { removeAll(cb) { cb(); }, create(_v, cb) { if (cb) cb(); }, onClicked: { addListener() {} } },
    action: { onClicked: { addListener() {} }, setBadgeBackgroundColor() {}, setBadgeText() {}, setTitle() {} },
    commands: { onCommand: { addListener() {} } },
    tabs: {
        sendMessage: (tabId, message) => { tabMessages.push({ tabId, message }); return Promise.resolve(); },
        query: () => Promise.resolve([]), create: () => Promise.resolve(),
        captureVisibleTab: () => Promise.resolve('data:image/png;base64,AA=='),
        onRemoved: { addListener(fn) { onRemoved = fn; } }, onUpdated: { addListener(fn) { onUpdated = fn; } }
    },
    offscreen: { createDocument: () => { createDocumentCalls++; offscreenExists = true; return Promise.resolve(); } }
};
const context = vm.createContext({
    console, chrome, importScripts() {}, setTimeout, clearTimeout, Promise, Date,
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 15000,
    SETTING_DEFAULTS: { speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, pauseLengthScale: 1 },
    CAPTURE_STORAGE_KEY: 'capture', CAPTURE_MAX_DATAURL_LENGTH: 8 * 1024 * 1024,
    PLAYBACK_TAB_STORAGE_KEY: 'playback', fetch: async () => { throw new Error('not used'); },
    OffscreenCanvas: function() {}, createImageBitmap: async () => ({}), btoa: () => ''
});
vm.runInContext(source, context, { filename: 'background.js' });
assert.equal(typeof onMessage, 'function');
assert.equal(typeof onRemoved, 'function');
assert.equal(typeof onUpdated, 'function');

const offscreenSender = { id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const send = (message, sender) => new Promise((resolve) => {
    const keepOpen = onMessage(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
});

(async () => {
    // --- STOP_ALL は offscreen が無ければ生成しない ---
    {
        const response = await send({ type: 'STOP_ALL' }, { tab: { id: 1 } });
        await settle();
        assert.equal(response.success, true);
        assert.equal(createDocumentCalls, 0, '停止のためだけに offscreen を生成しない');
        assert.equal(offscreenMessages.length, 0);
    }

    // --- 読み上げ中のタブを閉じると音声を止める ---
    {
        await send({ type: 'GENERATE_VOICE', text: 'こんにちは。' }, { tab: { id: 5 } });
        await settle();
        assert.equal(createDocumentCalls, 1);
        assert.ok(offscreenMessages.some((m) => m.type === 'ENQUEUE_TEXTS'));
        offscreenMessages.length = 0;

        await onRemoved(5);
        await settle();
        assert.deepEqual(offscreenMessages.map((m) => m.type), ['STOP_AUDIO'],
            '読み上げ中のタブを閉じたら STOP_AUDIO を送る');
        assert.equal(sessionData.playback, undefined, '再生宛先をクリアする');
        offscreenMessages.length = 0;

        // 再生していないタブが閉じても何も送らない
        await onRemoved(6);
        await settle();
        assert.equal(offscreenMessages.length, 0);

        // タブAが再生中にタブBが読み上げを開始し、その直後にタブAが遷移した場合、
        // Aの停止がBの ENQUEUE_TEXTS の後ろに回り込んで始まったばかりの読み上げを
        // 止めてはいけない（宛先の照合は直列キューの内側で行う）。
        await send({ type: 'GENERATE_VOICE', text: 'A。' }, { tab: { id: 21 } });
        await settle();
        offscreenMessages.length = 0;
        const bStarted = send({ type: 'GENERATE_VOICE', text: 'B。' }, { tab: { id: 22 } });
        const aNavigated = onUpdated(21, { status: 'loading' });
        await Promise.all([bStarted, aNavigated]);
        await settle();
        const types = offscreenMessages.map((m) => m.type);
        assert.equal(types[types.length - 1], 'ENQUEUE_TEXTS',
            `Bの読み上げ開始後に停止が割り込まない: ${types.join(' -> ')}`);
        assert.equal(sessionData.playback, 22, '再生宛先はタブBのまま');
        offscreenMessages.length = 0;
    }

    // --- 対象タブが切り替わった場合は別タブをキャプチャしない ---
    {
        const region = { rect: { x: 0, y: 0, width: 100, height: 50 }, viewportWidth: 1000 };
        const originalQuery = chrome.tabs.query;
        try {
            chrome.tabs.query = () => Promise.resolve([{ id: 10, windowId: 1 }]);
            const before = await send({ type: 'CAPTURE_OCR_REGION', ...region },
                { tab: { id: 9, windowId: 1 }, frameId: 0 });
            assert.equal(before.success, false);
            assert.match(before.error, /タブが切り替わりました/);
            assert.ok(!offscreenMessages.some((m) => m.type === 'OCR_RECOGNIZE'),
                'キャプチャ前に別タブへ切り替わったらOCR要求を送らない');

            let queryCount = 0;
            chrome.tabs.query = () => Promise.resolve([{
                id: queryCount++ === 0 ? 9 : 10,
                windowId: 1
            }]);
            const during = await send({ type: 'CAPTURE_OCR_REGION', ...region },
                { tab: { id: 9, windowId: 1 }, frameId: 0 });
            assert.equal(during.success, false);
            assert.match(during.error, /タブが切り替わりました/);
            assert.ok(!offscreenMessages.some((m) => m.type === 'OCR_RECOGNIZE'),
                'キャプチャ中に別タブへ切り替わったら取得画像をOCRへ渡さない');
        } finally {
            chrome.tabs.query = originalQuery;
            offscreenMessages.length = 0;
        }
    }

    // --- 古い範囲OCRの結果は読み上げない ---
    {
        const region = { rect: { x: 0, y: 0, width: 100, height: 50 }, viewportWidth: 1000 };
        // 要求1（タブ9）
        await send({ type: 'CAPTURE_OCR_REGION', ...region }, { tab: { id: 9, windowId: 1 }, frameId: 0 });
        const first = offscreenMessages.find((m) => m.type === 'OCR_RECOGNIZE');
        assert.ok(Number.isInteger(first.requestId), 'OCR要求に通し番号を付ける');
        offscreenMessages.length = 0;
        // 要求2（同じタブで選び直し）
        await send({ type: 'CAPTURE_OCR_REGION', ...region }, { tab: { id: 9, windowId: 1 }, frameId: 0 });
        const second = offscreenMessages.find((m) => m.type === 'OCR_RECOGNIZE');
        assert.ok(second.requestId > first.requestId);
        offscreenMessages.length = 0;
        tabMessages.length = 0;

        // 古い要求1の完了 → 読み上げない・タブへの完了通知もしない
        await send({ type: 'OCR_COMPLETE', target: 'background', tabId: 9,
            requestId: first.requestId, text: '古い結果' }, offscreenSender);
        await settle();
        assert.ok(!offscreenMessages.some((m) => m.type === 'ENQUEUE_TEXTS'),
            '選び直す前のOCR結果を読み上げない');
        assert.equal(tabMessages.length, 0, '新しいOCRの進捗表示を消さない');

        // 最新の要求2の完了 → 読み上げる
        await send({ type: 'OCR_COMPLETE', target: 'background', tabId: 9,
            requestId: second.requestId, text: '新しい結果' }, offscreenSender);
        await settle();
        let enqueued = offscreenMessages.find((m) => m.type === 'ENQUEUE_TEXTS');
        assert.ok(enqueued && enqueued.texts.join('') === '新しい結果', '最新のOCR結果は読み上げる');
        offscreenMessages.length = 0;
        tabMessages.length = 0;

        // 要求3の後にService Workerのメモリだけが消えても、sessionに残った最新要求を復元する。
        await send({ type: 'CAPTURE_OCR_REGION', ...region }, { tab: { id: 9, windowId: 1 }, frameId: 0 });
        const third = offscreenMessages.find((m) => m.type === 'OCR_RECOGNIZE');
        assert.equal(sessionData.vv_ocr_request_state.tabs['9'], third.requestId,
            '最新OCR要求を storage.session に保存する');
        offscreenMessages.length = 0;
        context.__test.resetOcrMemory();
        await send({ type: 'OCR_COMPLETE', target: 'background', tabId: 9,
            requestId: third.requestId, text: 'SW復帰後の結果' }, offscreenSender);
        await settle();
        enqueued = offscreenMessages.find((m) => m.type === 'ENQUEUE_TEXTS');
        assert.ok(enqueued && enqueued.texts.join('') === 'SW復帰後の結果',
            'SW休止後もsessionから最新要求を復元して受け付ける');
        offscreenMessages.length = 0;
        tabMessages.length = 0;

        // 要求4の後に別読み上げで取消し、さらにSWメモリが消えても古い完了を復活させない。
        await send({ type: 'CAPTURE_OCR_REGION', ...region }, { tab: { id: 9, windowId: 1 }, frameId: 0 });
        const fourth = offscreenMessages.find((m) => m.type === 'OCR_RECOGNIZE');
        assert.ok(fourth.requestId > third.requestId, '要求番号も storage.session 上で単調増加する');
        offscreenMessages.length = 0;
        await send({ type: 'GENERATE_VOICE', text: '選択テキスト。' }, { tab: { id: 9 } });
        await settle();
        assert.equal(sessionData.vv_ocr_request_state.tabs['9'], null,
            '別読み上げ開始時のOCR取消状態を storage.session に保存する');
        offscreenMessages.length = 0;
        tabMessages.length = 0;
        context.__test.resetOcrMemory();
        await send({ type: 'OCR_COMPLETE', target: 'background', tabId: 9,
            requestId: fourth.requestId, text: '遅れて届いた結果' }, offscreenSender);
        await settle();
        assert.ok(!offscreenMessages.some((m) => m.type === 'STOP_AUDIO' || m.type === 'ENQUEUE_TEXTS'),
            'SW休止後でも取消済みOCR結果で読み上げを中断しない');
        assert.ok(tabMessages.some((m) => m.tabId === 9 && m.message.type === 'OCR_STATUS'
            && m.message.status === 'done'), '取り残された「文字認識中」表示は片付ける');

        // 通し番号の無い完了は、更新直後に旧offscreenが残る場合の互換として受け付ける。
        offscreenMessages.length = 0;
        await send({ type: 'OCR_COMPLETE', target: 'background', tabId: 9, text: '番号なし' }, offscreenSender);
        await settle();
        assert.ok(offscreenMessages.some((m) => m.type === 'ENQUEUE_TEXTS'));
    }

    // --- 長文の二次分割（詳細は tests/speech-text.test.js） ---
    {
        // vm 内の配列は別 realm のため、値で比較する
        const splitText = (text) => Array.from(context.__test.splitText(text));
        assert.deepEqual(splitText('短い文。次の文！'), ['短い文。', '次の文！'],
            '通常の文は文末記号でのみ分割する');
        // 120字以内の文はそのまま（読点では分割しない）
        const medium = 'これは、読点を含む、しかし長すぎない、普通の一文です。';
        assert.deepEqual(splitText(medium), [medium], '120字以内の文は読点で分割しない');
        // 長い文は読点の直後で上限以内に分ける（先読み合成が再生に追いつくため）
        const clause = 'あいうえおかきくけこ、';
        const long = clause.repeat(120); // 1,320文字・句点なし
        const chunks = splitText(long);
        assert.ok(chunks.length > 1, '長い1文は分割される');
        assert.ok(chunks.every((c) => c.length <= 132), `各チャンクは上限以内: ${chunks.map((c) => c.length)}`);
        assert.ok(chunks.every((c) => c.endsWith('、')), '読点の直後で区切る');
        assert.equal(chunks.join(''), long, '文字を落とさない');
        // 実機報告の再現: 句点の無い箇条書き（約390字）が1件にならない
        const mail = '思っております。' + '-'.repeat(60) + '、◆フェンリル株式会社／【リモート可／大阪】UXコンサルタント◆'
            + '「Sleipnir」開発企業◆土日祝休・フレックス、URL省略、〜スマホに入っているそのアプリ、'
            + 'フェンリルがつくっているかもしれません〜、■世界シリーズ累計5,000万超ダウンロードのWebブラウザ'
            + '「Sleipnir」を自社プロダクトとして保有、■iPhone向けアプリケーション開発に関わり、600件以上の実績あり、'
            + '■所属するクリエイター／技術者の技術書出版、技術フォーラムにスピーカーとして登壇、'
            + 'フロアを利用した最新トレンドの勉強会の一般開放など、高い専門性を持つ社員多数、' + '-'.repeat(60);
        const mailChunks = splitText(mail);
        assert.ok(mailChunks.length >= 4 && mailChunks.every((c) => c.length <= 132),
            `箇条書きは読点単位の上限以内へ分かれる: ${mailChunks.map((c) => c.length)}`);
        // 区切り線（同じ記号の連続）は1個に畳まれる以外、文字を落とさない
        assert.equal(mailChunks.join(''), mail.replace(/-{60}/g, '-'));
    }

    console.log('background lifecycle and stale OCR handling: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
