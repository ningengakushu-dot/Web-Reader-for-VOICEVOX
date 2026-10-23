const assert = require('node:assert/strict');
const { createAudioPipeline } = require('./audio-pipeline-harness');

async function run(rows, options = {}) {
    const pipeline = createAudioPipeline({ rows, sourceRef: options.sourceRef });
    pipeline.enqueue(undefined, options.settings);
    await pipeline.advanceTo();
    const report = pipeline.report();
    assert.deepEqual(report.played, rows.map((row) => row.text), '順序と全文を保つ');
    assert.equal(report.ended, true, '最後まで再生する');
    assert.equal(pipeline.urls.size, 0, '再生済みBlobを解放する');
    return report;
}

(async () => {
    // ENQUEUE_TEXTS以降は分割記号を判断に使わない。同じ音声長と負荷なら同じ制御になる。
    for (const texts of [
        ['正しい。', '後続の長い文です。'],
        ['見出し', '改行後の本文'],
        ['項目A', '長い箇条書き'],
        ['sentence one', 'sentence two'],
        ['記号のない分割一', '記号のない分割二']
    ]) {
        const rows = texts.map((text, i) => ({ text, audioSec: i ? 20 : 1, synthMs: i ? 10000 : 500 }));
        const current = await run(rows);
        assert.ok(current.maxGap < 0.001, '分割記号に依存せず不足を抑える');
    }
    // 次の1件だけが短くても、その後の長い合成を見越して開始する。
    const lateLong = [1, 1, 30, 8].map((audioSec, i) => ({ text: `chunk${i}`, audioSec, synthMs: audioSec * 500 }));
    assert.ok((await run(lateLong)).maxGap < 0.001);
    assert.ok((await run(lateLong, { settings: { speedScale: 2 } })).maxGap < 0.001,
        '話速を含む実際の再生秒数で計画する');

    const longFirst = await run([20, 20].map((audioSec, i) => ({ text: `long${i}`, audioSec, synthMs: 2000 })));
    assert.ok(longFirst.startLatency < 2.1, '十分な長さの先頭音声は全文の合成を待たない');
    assert.equal((await run([{ text: '一文だけ', audioSec: 1, synthMs: 500 }])).startLatency, 0.5);

    // 実測した短文列。読みの長さはWAVのフレーム丸めで少しずれ、合成速度も変わる。
    // 再生中に次の音声が完成していれば、予測を更新しても間を追加してはいけない。
    const shortSamples = [
        [0.62, 0.632696, 3, 313], [0.8, 0.805353, 3, 603], [0.81, 0.829977, 4, 378],
        [0.87, 0.884143, 4, 393], [0.84, 0.850588, 3, 418], [0.84, 0.842081, 4, 398],
        [0.73, 0.727462, 3, 315], [0.89, 0.887147, 3, 338], [0.84, 0.844687, 3, 365],
        [0.74, 0.746463, 3, 335]
    ].map(([audioSec, querySec, queryMs, synthMs], i) => ({
        text: `short${i}`, audioSec, queryMs, synthMs,
        query: { accent_phrases: [{ moras: [{ vowel_length: querySec - 0.2 }] }] }
    }));
    assert.ok((await run(shortSamples)).maxGap < 0.001, '完成済み音声の連続再生を妨げない');

    // バッファ上限を超えるほど遅いエンジンでも、開始待ちと合成上限が相互に待ち合わない。
    const slow = Array.from({ length: 60 }, (_, i) => ({ text: `slow${i}`, audioSec: 0.5, synthMs: 1000 }));
    await run(slow);
    await run([
        { text: '同じ文', audioSec: 1, synthMs: 500 },
        { text: '同じ文', audioSec: 1, synthMs: 500 },
        { text: '続く長い文', audioSec: 20, synthMs: 10000 }
    ]);

    // 合成待ちタイマーがあるときに停止し、別の読み上げを開始する。
    const rows = [
        { text: 'old1', audioSec: 1, synthMs: 500 },
        { text: 'old2', audioSec: 20, synthMs: 10000 },
        { text: 'new', audioSec: 2, synthMs: 500 }
    ];
    const pipeline = createAudioPipeline({ rows });
    pipeline.enqueue(['old1', 'old2']);
    await pipeline.advanceTo(2000);
    assert.equal(pipeline.starts.length, 0, '合成待ちの状態を再現する');
    pipeline.stop();
    pipeline.enqueue(['new']);
    await pipeline.advanceTo();
    assert.deepEqual(pipeline.report().played, ['new'], '古いタイマーと合成完了は再生しない');
    assert.equal(pipeline.urls.size, 0);

    const preparation = createAudioPipeline({ rows: [
        { text: 'query-old', queryMs: 1000, audioSec: 1, synthMs: 500 },
        { text: 'query-new', audioSec: 1, synthMs: 500 }
    ] });
    preparation.enqueue(['query-old']);
    await preparation.advanceTo(100);
    preparation.stop();
    preparation.enqueue(['query-new']);
    await preparation.advanceTo();
    assert.deepEqual(preparation.report().played, ['query-new'], 'クエリ先読み中の停止も世代を守る');
    assert.ok(!preparation.requests.some((request) => request.type === 'synthesis' && request.text === 'query-old'));
    console.log('offscreen duration-aware buffering: PASSED');
})().catch((error) => { console.error(error); process.exitCode = 1; });
