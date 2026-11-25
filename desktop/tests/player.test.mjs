import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { createPlayer } from "../player.mjs";

function wav(seconds = 1) {
    const rate = 1000;
    const data = Buffer.alloc(44 + rate * seconds);
    data.write("RIFF");
    data.writeUInt32LE(data.length - 8, 4);
    data.write("WAVEfmt ", 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt32LE(rate, 28);
    data.write("data", 36);
    data.writeUInt32LE(data.length - 44, 40);
    return data;
}

function setup(t) {
    const requests = [], audio = [], states = [], timing = [];
    const player = createPlayer({
        synthesize(text, settings, signal) {
            const deferred = Promise.withResolvers();
            requests.push({text, settings, signal, ...deferred});
            return deferred.promise; // The transport can deliver even after cancellation.
        },
        createAudio(url) {
            const playing = Promise.withResolvers();
            const clip = {url, playing, paused: false, detached: false, loaded: false,
                play() { return playing.promise; },
                pause() { this.paused = true; },
                removeAttribute(name) { this.detached = name === "src"; },
                load() { this.loaded = true; }};
            audio.push(clip);
            return clip;
        },
        onState: event => states.push(event),
        onTiming: event => timing.push(event)
    });
    t.after(() => player.close());
    return {player, requests, audio, states, timing};
}

for (const outcome of ["resolve", "reject"]) {
    test(`a late synthesis ${outcome} from A cannot affect B after stop/start`, async t => {
        const {player, requests, audio, states} = setup(t);
        player.start(["古い文章"], {});
        player.stop();
        assert.equal(requests[0].signal.aborted, true);
        player.start(["新しい文章"], {});
        requests[1].resolve(wav());
        await tick();
        audio[0].onplaying();
        const snapshot = states.slice();
        requests[0][outcome](outcome === "resolve" ? wav() : new Error("offline"));
        await tick();
        assert.deepEqual(states, snapshot);
        assert.equal(audio.length, 1);
        audio[0].onended();
        assert.equal(states.at(-1).state, "finished");
    });
}

test("stop releases the media source and queued events from A cannot end B", async t => {
    const {player, requests, audio, states} = setup(t);
    const revoke = t.mock.method(URL, "revokeObjectURL");
    player.start(["一", "二"], {});
    requests[0].resolve(wav(10));
    await tick();
    const first = audio[0];
    first.onplaying();
    const callbacks = [first.onplaying, first.onended, first.onerror];
    player.stop();
    assert.ok(first.paused && first.detached && first.loaded);
    assert.equal(revoke.mock.calls[0].arguments[0], first.url);
    assert.ok(requests[1].signal.aborted);
    player.start(["別の本文"], {});
    requests[2].resolve(wav());
    await tick();
    audio[1].onplaying();
    const snapshot = states.slice();
    for (const fire of callbacks) fire();
    first.playing.reject(new Error("Interrupted"));
    requests[1].resolve(wav());
    await tick();
    assert.deepEqual(states, snapshot);
    assert.equal(audio.length, 2);
});

test("WAV prefetch is bounded by ready seconds and drains once in source order", async t => {
    const {player, requests, audio, states, timing} = setup(t);
    player.start(["一", "二", "三", "四", "五"], {});
    for (let i = 0; i < 4; i++) {
        requests[i].resolve(wav(15));
        await tick();
    }
    assert.equal(requests.length, 4); // one playing plus 45 seconds ready
    for (let i = 0; i < 5; i++) {
        audio[i].onplaying();
        audio[i].onended();
        if (i === 0) requests[4].resolve(wav(15));
        await tick();
    }
    assert.deepEqual(requests.map(r => r.text), ["一", "二", "三", "四", "五"]);
    assert.deepEqual(timing.filter(e => e.event === "playing").map(e => e.index), [0,1,2,3,4]);
    assert.deepEqual(timing.filter(e => e.event === "ended").map(e => e.index), [0,1,2,3,4]);
    assert.equal(states.at(-1).state, "finished");
});

test("close aborts pending work and releases playback without another callback", async t => {
    const {player, requests, audio, states} = setup(t);
    player.start(["現在", "次"], {});
    requests[0].resolve(wav());
    await tick();
    audio[0].onplaying();
    const length = states.length;
    player.close();
    requests[1].reject(new Error("offline"));
    player.start(["再開"], {});
    await tick();
    assert.ok(audio[0].paused && requests[1].signal.aborted);
    assert.equal(requests.length, 2);
    assert.equal(states.length, length);
});

test("synthesis and media failures are visible and a fresh request works", async t => {
    const {player, requests, audio, states} = setup(t);
    player.start(["失敗", "読まない"], {});
    requests[0].reject(new Error("offline"));
    await tick();
    assert.equal(states.at(-1).error.message, "offline");
    assert.equal(requests.length, 1);
    player.start(["音声エラー"], {});
    requests[1].resolve(wav());
    await tick();
    audio[0].onerror();
    assert.equal(states.at(-1).state, "error");
    player.start(["正常"], {});
    requests[2].resolve(wav());
    await tick();
    audio[1].onplaying();
    audio[1].onended();
    assert.equal(states.at(-1).state, "finished");
});
