// offscreen.js の先読み制御の検査:
// - 再生中に次の1件だけでなく、完成済み音声の合計が上限秒数（または件数）に達するまで
//   合成を進める（短い文の直後の長い文でも、その合成が再生の残り時間に収まるように）
// - 上限に達したら合成を止め、再生が進んで空きができたら再開する
// - 音声長は audio_query の結果から見積もる（話速を反映）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8')
    + '\n;globalThis.__test = { estimateQueryDurationSec, MAX_READY_AUDIO_QUEUE, MAX_READY_AUDIO_SECONDS };';
let listener;
const notifications = [];
const playing = [];   // 再生を開始した MockAudio。テストが明示的に終了させる
const synthesized = [];

class MockAudio {
    constructor(url) { this.url = url; }
    play() { playing.push(this); return Promise.resolve(); }
    end() { this.onended?.(); }
    pause() {}
    removeAttribute() {}
    load() {}
}

// 各テキストの音声長（秒）はテキスト先頭の数値で指定する（例: "10:長い文" → 10秒）
function durationOf(text) {
    const m = /^(\d+(?:\.\d+)?):/.exec(text);
    return m ? Number(m[1]) : 1;
}
let synthDelayMs = 0;
const chrome = {
    runtime: {
        id: 'ext-id',
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage(message) { notifications.push(message); return Promise.resolve(); }
    }
};
const context = vm.createContext({
    console, chrome, Audio: MockAudio, setTimeout, clearTimeout, setImmediate, Promise,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    VOICEVOX_BASE_URL: 'http://127.0.0.1:50021', VOICEVOX_FETCH_TIMEOUT_MS: 100,
    VOICEVOX_SYNTHESIS_TIMEOUT_MS: 100, OCR_WORKER_IDLE_RELEASE_MS: 1000,
    OCR_RECOGNIZE_TIMEOUT_MS: 1000,
    fetchWithTimeout: async (url) => {
        if (url.includes('audio_query')) {
            const text = decodeURIComponent(url.split('text=')[1]);
            return { ok: true, status: 200, text };
        }
        if (synthDelayMs) await new Promise((r) => setTimeout(r, synthDelayMs));
        return { ok: true, status: 200 };
    },
    // 音声長 d 秒 = モーラ1つ（vowel_length = d - pre/post 0.2）
    readJsonResponseWithLimit: async (res) => {
        const d = durationOf(res.text);
        synthesized.push(res.text);
        return { accent_phrases: [{ moras: [{ vowel_length: Math.max(0, d - 0.2), consonant_length: 0 }], pause_mora: null }],
            prePhonemeLength: 0.1, postPhonemeLength: 0.1 };
    },
    readBlobResponseWithLimit: async () => ({}),
    createOcrWorkerPool: () => ({ get: async () => ({}), terminate() {} }),
    createPrimaryOcrProgressTracker: () => ({ reset() {}, update: () => null }),
    recognizeWithOrientation: async () => ({ text: '', confidence: 0 }),
    withOcrTimeout: (p) => p, cleanForSpeech: (s) => s, normalizeOcrText: (s) => s,
    cropToOcrCanvas: () => ({}), createImageBitmap: async () => ({ close() {}, width: 1, height: 1 }),
    fetch: async () => ({ blob: async () => ({}) })
});
vm.runInContext(source, context, { filename: 'offscreen.js' });
assert.strictEqual(typeof listener, 'function');
const { estimateQueryDurationSec, MAX_READY_AUDIO_QUEUE, MAX_READY_AUDIO_SECONDS } = context.__test;

function enqueue(texts, settings = {}) {
    return new Promise((resolve) => {
        listener({ type: 'ENQUEUE_TEXTS', target: 'offscreen', texts, settings: {
            speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, pauseLengthScale: 1, ...settings
        } }, { id: 'ext-id' }, resolve);
    });
}
function stop() {
    return new Promise((resolve) => listener({ type: 'STOP_AUDIO', target: 'offscreen' }, { id: 'ext-id' }, resolve));
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

(async () => {
    // --- 見積もり: モーラ・休止の合計を話速で割る ---
    {
        const query = { prePhonemeLength: 0.1, postPhonemeLength: 0.1, accent_phrases: [
            { moras: [{ consonant_length: 0.05, vowel_length: 0.1 }, { vowel_length: 0.15 }], pause_mora: { vowel_length: 0.3 } },
            { moras: [{ consonant_length: null, vowel_length: 0.2 }] }
        ] };
        assert.ok(Math.abs(estimateQueryDurationSec(query, 1) - 1.0) < 1e-9);
        assert.ok(Math.abs(estimateQueryDurationSec(query, 2) - 0.5) < 1e-9);
        assert.equal(estimateQueryDurationSec({}, 0), 0);
        assert.equal(estimateQueryDurationSec({ accent_phrases: 'bad' }, 1), 0);
    }

    // --- 短い文の直後に長い文: 再生中に上限秒数まで先読みする ---
    {
        // 1秒の見出しに続いて 5秒の文が並ぶ。旧実装（次の1件だけ）なら再生中に完成するのは1件。
        const texts = ['1:見出し'].concat(Array.from({ length: 30 }, (_, i) => `5:本文${i}`));
        await enqueue(texts);
        await settle();
        assert.equal(playing.length, 1, '先頭は即座に再生を始める');
        // 再生中（先頭を終わらせない）に、完成済みが MAX_READY_AUDIO_SECONDS 相当まで積まれる
        const readyCount = synthesized.length - 1; // 再生中の1件を除く
        const readySeconds = readyCount * 5;
        assert.ok(readySeconds >= MAX_READY_AUDIO_SECONDS && readySeconds < MAX_READY_AUDIO_SECONDS + 5,
            `再生中に上限秒数まで先読みする: ${readyCount}件=${readySeconds}秒`);
        assert.ok(readyCount <= MAX_READY_AUDIO_QUEUE);
        const before = synthesized.length;
        await settle();
        assert.equal(synthesized.length, before, '上限に達したら合成を止める');
        // 再生が進むと、空いた分だけ合成が再開する
        playing[0].end();
        await settle();
        assert.equal(playing.length, 2, '次の音声の再生が始まる');
        assert.ok(synthesized.length > before, '再生で空きができたら先読みを再開する');
        await stop();
        await settle();
        playing.length = 0;
        synthesized.length = 0;
        notifications.length = 0;
    }

    // --- 件数の上限: ごく短い文が多数でも件数で頭打ちになる ---
    {
        const texts = Array.from({ length: 200 }, (_, i) => `0.5:短${i}`);
        await enqueue(texts);
        await settle();
        assert.equal(playing.length, 1);
        assert.equal(synthesized.length - 1, MAX_READY_AUDIO_QUEUE, `件数上限まで先読み: ${synthesized.length - 1}`);
        await stop();
        await settle();
        playing.length = 0;
        synthesized.length = 0;
        notifications.length = 0;
    }

    // --- 停止: 先読み済みをすべて捨て、その後の合成完了は反映しない ---
    {
        synthDelayMs = 30;
        await enqueue(['5:一', '5:二', '5:三']);
        await new Promise((r) => setTimeout(r, 45)); // 1件目の合成が終わり再生開始、2件目が合成中
        assert.equal(playing.length, 1);
        await stop();
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(playing.length, 1, '停止後に先読み分の再生が始まらない');
        assert.ok(notifications.some((m) => m.type === 'PLAYBACK_STOPPED'));
        assert.ok(!notifications.some((m) => m.type === 'PLAYBACK_ENDED'));
        synthDelayMs = 0;
        playing.length = 0;
        synthesized.length = 0;
        notifications.length = 0;
    }

    // --- 話速: 速いほど見積もりが短くなり、より多く先読みする ---
    {
        const texts = Array.from({ length: 60 }, (_, i) => `5:本文${i}`);
        await enqueue(texts, { speedScale: 2 });
        await settle();
        const readyCount = synthesized.length - 1;
        assert.ok(readyCount * 2.5 >= MAX_READY_AUDIO_SECONDS && readyCount <= MAX_READY_AUDIO_QUEUE,
            `話速2倍では実時間ベースで先読みする: ${readyCount}件`);
        await stop();
        await settle();
    }

    console.log('offscreen prefetch buffering: PASSED');
})().catch((error) => { console.error(error); process.exit(1); });
