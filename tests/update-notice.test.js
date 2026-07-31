const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('=== Web Reader for VOICEVOX - お知らせ機能実ソース自動検証テスト ===\n');

const projectRoot = path.join(__dirname, '..');
const backgroundPath = path.join(projectRoot, 'background.js');
const contentPath = path.join(projectRoot, 'content.js');

// 1. ソースコードの存在確認
assert.strictEqual(fs.existsSync(backgroundPath), true, 'background.js が存在すること');
assert.strictEqual(fs.existsSync(contentPath), true, 'content.js が存在すること');

// --- モック Storage クラス ---
class MockStorage {
    constructor() {
        this.data = {};
        this.shouldFail = false;
    }
    get(keys, cb) {
        setImmediate(() => {
            if (this.shouldFail) {
                global.chromeMock.runtime.lastError = { message: 'Storage Failure' };
                cb({});
                global.chromeMock.runtime.lastError = null;
            } else {
                const res = {};
                keys.forEach(k => res[k] = this.data[k]);
                cb(res);
            }
        });
    }
    set(obj, cb) {
        setImmediate(() => {
            if (this.shouldFail) {
                global.chromeMock.runtime.lastError = { message: 'Storage Write Failure' };
                cb && cb();
                global.chromeMock.runtime.lastError = null;
            } else {
                Object.assign(this.data, obj);
                cb && cb();
            }
        });
    }
}

// ==========================================
// 2. background.js 実ソースコードの実行検証
// ==========================================
console.log('[Test 1] background.js 実ソースのロジック・非同期直列化検証...');

const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

const bgChromeMock = {
    runtime: {
        lastError: null,
        onInstalled: { addListener: (fn) => { bgContext.__onInstalledListener = fn; } },
        onMessage: { addListener: (fn) => { bgContext.__onMessageListener = fn; } },
        getURL: (p) => p
    },
    action: { onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    scripting: { executeScript: () => Promise.resolve() },
    tabs: {
        sendMessage: () => Promise.resolve(),
        query: () => Promise.resolve([]),
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} }
    },
    contextMenus: {
        removeAll: (cb) => cb && cb(),
        create: () => {},
        onClicked: { addListener: () => {} }
    },
    storage: { local: new MockStorage() }
};

global.chromeMock = bgChromeMock;

const bgContext = vm.createContext({
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setImmediate: setImmediate,
    Promise: Promise,
    importScripts: () => {},
    chrome: bgChromeMock,
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021',
    VOICEVOX_FETCH_TIMEOUT_MS: 5000,
    OCR_MENU_ID: 'ocr-menu'
});

// background.js を VM 上で実行
vm.runInContext(backgroundSource, bgContext);

assert.strictEqual(typeof bgContext.__onInstalledListener, 'function', 'onInstalled リスナーが登録されていること');
assert.strictEqual(typeof bgContext.__onMessageListener, 'function', 'onMessage リスナーが登録されていること');

// --- 2-1. install / update の条件判定テスト ---
bgChromeMock.storage.local.data = {};
bgContext.__onInstalledListener({ reason: "install" });

setImmediate(() => {
    assert.strictEqual(bgChromeMock.storage.local.data.update_notice_pending, undefined, 'install では update_notice_pending が設定されないこと');
    console.log(' -> PASSED: install では表示対象にならない');

    bgContext.__onInstalledListener({ reason: "update", previousVersion: "1.2.1" });

    setImmediate(async () => {
        assert.strictEqual(bgChromeMock.storage.local.data.update_notice_pending, true, '旧版からの update では update_notice_pending が true になること');
        console.log(' -> PASSED: v1.2.1からのupdateでは表示対象になる');

        // 1.4.3以降の修正版では同じ案内を再登録しない
        bgChromeMock.storage.local.data.update_notice_pending = false;
        bgContext.__onInstalledListener({ reason: "update", previousVersion: "1.4.3" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(bgChromeMock.storage.local.data.update_notice_pending, false,
            '1.4.3以降からの更新では通知フラグを再設定しないこと');
        console.log(' -> PASSED: 修正版への更新では同じ案内を再表示しない');

        // claim テスト用に、旧版からの更新後と同じ状態へ戻す
        bgChromeMock.storage.local.data.update_notice_pending = true;

        // --- 2-2. CLAIM_UPDATE_NOTICE メッセージのトップフレーム検証 ---
        const callOnMessage = (request, sender) => {
            return new Promise((resolve) => {
                bgContext.__onMessageListener(request, sender, (res) => {
                    resolve(res);
                });
            });
        };

        // タブなし (sender.tab なし)
        const resNoTab = await callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, {});
        assert.strictEqual(resNoTab.shouldShow, false, 'sender.tab なしの場合は false を返すこと');

        // サブフレーム (sender.frameId = 1)
        const resIframe = await callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 1 }, frameId: 1 });
        assert.strictEqual(resIframe.shouldShow, false, 'sender.frameId = 1 の場合は false を返すこと');
        console.log(' -> PASSED: 非トップフレーム・不正要求は false を返す');

        // --- 2-3. 最初だけ true, 2回目以降は false ---
        const resTop1 = await callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 1 }, frameId: 0 });
        assert.strictEqual(resTop1.shouldShow, true, '最初のトップフレームからの要求だけが true を受け取ること');
        console.log(' -> PASSED: 最初だけ true');

        const resTop2 = await callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 1 }, frameId: 0 });
        assert.strictEqual(resTop2.shouldShow, false, '2回目以降の要求は false を受け取ること');
        console.log(' -> PASSED: 2回目以降は false');

        // --- 2-4. 同時 claim (複数タブ競合) での直列化検証 ---
        bgChromeMock.storage.local.data.update_notice_pending = true;
        const parallelResults = await Promise.all([
            callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 1 }, frameId: 0 }),
            callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 2 }, frameId: 0 }),
            callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 3 }, frameId: 0 }),
            callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 4 }, frameId: 0 })
        ]);
        const trueCount = parallelResults.filter(r => r?.shouldShow === true).length;
        assert.strictEqual(trueCount, 1, '複数タブからの同時要求でも true を受けるのは全体で1件のみ');
        console.log(' -> PASSED: 同時 claim でも true は 1件のみ');

        // --- 2-5. storage 失敗時の検証 ---
        bgChromeMock.storage.local.data.update_notice_pending = true;
        bgChromeMock.storage.local.shouldFail = true;
        const resFail = await callOnMessage({ type: "CLAIM_UPDATE_NOTICE" }, { tab: { id: 1 }, frameId: 0 });
        assert.strictEqual(resFail.shouldShow, false, 'storage 失敗時は false を返すこと');
        console.log(' -> PASSED: storage 失敗時は false\n');

        // ==========================================
        // 3. content.js 実ソースコードの実行検証
        // ==========================================
        console.log('[Test 2] content.js 実ソースの UI/deactivate 検証...');

        const contentSource = fs.readFileSync(contentPath, 'utf8');

        let lastSentMessage = null;
        let lastMessageCallback = null;

        const createDummyElement = () => ({
            style: {},
            classList: { add: () => {}, remove: () => {} },
            appendChild: () => {},
            setAttribute: () => {},
            removeAttribute: () => {},
            querySelector: () => createDummyElement(),
            attachShadow: () => createDummyElement(),
            addEventListener: () => {},
            removeEventListener: () => {},
            remove: function() { this.removed = true; }
        });

        const dummyElement = createDummyElement();

        const documentMock = {
            body: dummyElement,
            documentElement: dummyElement,
            createElement: () => createDummyElement(),
            addEventListener: () => {},
            removeEventListener: () => {},
            getElementById: (id) => elementsMock[id] || null
        };

        const elementsMock = {
            'vvradio-update-notice-host': { ...createDummyElement(), removed: false }
        };

        const windowMock = {
            self: 1,
            top: 1,
            addEventListener: () => {},
            removeEventListener: () => {}
        };
        windowMock.window = windowMock;

        const ctChromeMock = {
            runtime: {
                id: 'dummy-id',
                lastError: null,
                sendMessage: (msg, cb) => {
                    lastSentMessage = msg;
                    lastMessageCallback = cb;
                },
                onMessage: { addListener: () => {} }
            },
            storage: {
                local: { get: (k, cb) => cb({}), set: () => {} },
                onChanged: { addListener: () => {}, removeListener: () => {} }
            }
        };

        const ctContext = vm.createContext({
            console: console,
            window: windowMock,
            document: documentMock,
            chrome: ctChromeMock,
            setTimeout: setTimeout,
            clearTimeout: clearTimeout
        });

        // content.js を VM 上で実行してクラスおよびインスタンス生成
        vm.runInContext(contentSource, ctContext);

        const instance = ctContext.window.__vvRadioReaderInstance;
        assert.ok(instance, 'VVRadioReader インスタンスが生成されていること');

        // --- 3-1. deactivate 後の非同期応答遮断検証 ---
        let modalShown = false;
        instance.showUpdateNoticeModal = () => { modalShown = true; };

        // deactivate() 実行
        instance.deactivate();
        assert.strictEqual(instance.active, false, 'deactivate で active が false になること');

        // deactivate 後に遅れてバックグラウンドからの応答が返ってきた場合
        instance.checkUpdateNotice();
        if (lastMessageCallback) {
            lastMessageCallback({ shouldShow: true });
        }
        assert.strictEqual(modalShown, false, 'deactivate 後は shouldShow: true でもモーダルを表示しないこと');
        console.log(' -> PASSED: deactivate 後に応答しても通知を表示しない');

        // --- 3-2. deactivate での通知ホスト削除検証 ---
        assert.strictEqual(elementsMock['vvradio-update-notice-host'].removed, true, 'deactivate で通知ホストが削除されていること');
        console.log(' -> PASSED: deactivate で通知ホストを削除する\n');

        console.log('=== すべての実ソースコード検証テストが正常に合格しました！ ===');
    });
});
