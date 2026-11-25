const MAX_READY_SECONDS = 45;
const MAX_READY_ITEMS = 256;
const MAX_LOOKAHEAD_ITEMS = 1024;
const MAX_READY_BYTES = 64 * 1024 * 1024;

// VOICEVOX returns PCM WAVE. Walk the RIFF chunks rather than assuming a
// 44-byte header (e.g. LIST may precede data).
function wavSeconds(bytes) {
    const view = ArrayBuffer.isView(bytes)
        ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new DataView(bytes);
    const invalid = () => new Error("VOICEVOXから取得した音声を再生できません。");
    if (view.byteLength < 12 || view.getUint32(0) !== 0x52494646
        || view.getUint32(8) !== 0x57415645) throw invalid();
    let bytesPerSecond = 0;
    for (let offset = 12; offset + 8 <= view.byteLength;) {
        const type = view.getUint32(offset);
        const length = view.getUint32(offset + 4, true);
        const payload = offset + 8;
        if (payload + length > view.byteLength) throw invalid();
        if (type === 0x666d7420 && length >= 16) bytesPerSecond = view.getUint32(payload + 8, true);
        if (type === 0x64617461 && length && bytesPerSecond) return length / bytesPerSecond;
        offset = payload + length + (length % 2);
    }
    throw invalid();
}

// Measure synthesis in this run. With an IPC operation returning a complete
// WAV, future mora lengths are unavailable until synthesis finishes. Estimate
// future clip lengths from the current voice's measured seconds per text unit.
function startupDeficit(run, now) {
    let synthesis = 0;
    let audio = 0;
    let deficit = 0;
    const rate = run.synthesisRate * 1.2;
    const horizon = MAX_READY_SECONDS / Math.max(0.1, 1 - rate);
    for (let i = run.next; i < run.chunks.length && i < run.next + MAX_LOOKAHEAD_ITEMS; i++) {
        const seconds = run.costs[i] * run.secondsPerUnit;
        synthesis += seconds * rate;
        deficit = Math.max(deficit, synthesis - audio);
        audio += seconds;
        if (audio >= horizon) break;
    }
    const elapsed = run.synthesisStarted == null ? 0 : (now - run.synthesisStarted) / 1000;
    return Math.max(0, deficit + 0.1 - elapsed - run.readySeconds);
}

export function createPlayer({
    synthesize, onState, onTiming = () => {}, createAudio = (url) => new Audio(url),
    readingCost = (text) => text.length
}) {
    let current = null;
    let closed = false;

    function report(run, state, index, error) {
        onState({state, index, total: run.chunks.length, error});
    }

    function releaseClip(run) {
        const clip = run.clip;
        if (!clip) return;
        run.clip = null;
        const audio = clip.audio;
        if (audio) {
            audio.onplaying = audio.onended = audio.onerror = null;
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
        }
        URL.revokeObjectURL(clip.url);
    }

    function release(run) {
        current = null;
        clearTimeout(run.timer);
        run.controller.abort();
        releaseClip(run);
        run.ready.length = 0;
    }

    function fail(run, index, error) {
        if (current !== run) return;
        release(run);
        report(run, "error", index, error);
    }

    function full(run) {
        return run.ready.length >= MAX_READY_ITEMS || run.readySeconds >= MAX_READY_SECONDS
            || run.readyBytes >= MAX_READY_BYTES;
    }

    function playNext(run, continuous = false) {
        if (current !== run || run.clip || !run.ready.length) return;
        clearTimeout(run.timer);
        if (!continuous && !full(run) && run.next < run.chunks.length) {
            const wait = startupDeficit(run, performance.now());
            if (wait > 0.001) {
                run.timer = setTimeout(() => playNext(run), Math.min(wait * 1000, 60000));
                return;
            }
        }
        const item = run.ready.shift();
        run.readySeconds -= item.seconds;
        run.readyBytes -= item.blob.size;
        const clip = {url: URL.createObjectURL(item.blob), audio: null, index: item.index};
        run.clip = clip;
        const live = () => current === run && run.clip === clip;
        const playbackError = () => {
            if (live()) fail(run, item.index, new Error("音声を再生できません。Windowsの出力デバイスを確認してください。"));
        };
        try {
            const audio = createAudio(clip.url);
            clip.audio = audio;
            let started = false;
            // Include intentional rebuffering before play(), exclude media-device latency.
            const synthesisWaitMs = run.lastEnd == null || continuous ? 0 : performance.now() - run.lastEnd;
            audio.onplaying = () => {
                if (!live() || started) return;
                started = true;
                onTiming({event: "playing", index: item.index, at: performance.now(), synthesisWaitMs});
                report(run, "playing", item.index);
            };
            audio.onended = () => {
                if (!live()) return;
                run.lastEnd = performance.now();
                onTiming({event: "ended", index: item.index, at: run.lastEnd});
                releaseClip(run);
                if (item.index + 1 === run.chunks.length) {
                    release(run);
                    report(run, "finished", item.index);
                } else if (run.ready.length) {
                    playNext(run, true);
                } else {
                    report(run, "preparing", item.index + 1);
                }
            };
            audio.onerror = playbackError;
            audio.play().catch(playbackError);
        } catch {
            playbackError();
        }
        void produce(run);
    }

    async function produce(run) {
        if (run.producing || current !== run) return;
        run.producing = true;
        try {
            while (current === run && run.next < run.chunks.length && !full(run)) {
                const index = run.next;
                run.synthesisStarted = performance.now();
                const bytes = await synthesize(run.chunks[index], run.settings, run.controller.signal);
                if (current !== run) return;
                const seconds = wavSeconds(bytes);
                const readyAt = performance.now();
                const blob = new Blob([bytes], {type: "audio/wav"});
                run.synthesisRate = (readyAt - run.synthesisStarted) / 1000 / seconds;
                run.secondsPerUnit = seconds / run.costs[index];
                run.ready.push({index, seconds, blob});
                run.readySeconds += seconds;
                run.readyBytes += blob.size;
                run.next++;
                run.synthesisStarted = null;
                onTiming({event: "ready", index, at: readyAt});
                playNext(run);
            }
        } catch (error) {
            fail(run, run.next, error);
        } finally {
            run.producing = false;
        }
    }

    function start(chunks, settings) {
        if (closed) return;
        if (current) release(current);
        const run = {
            chunks: chunks.slice(), settings: {...settings}, controller: new AbortController(),
            costs: chunks.map((text) => Math.max(1, readingCost(text))),
            ready: [], readySeconds: 0, readyBytes: 0, next: 0, clip: null, lastEnd: null,
            producing: false, synthesisStarted: null, timer: null
        };
        current = run;
        if (!run.chunks.length) {
            fail(run, 0, new Error("読み上げる文章を入力してください。"));
            return;
        }
        report(run, "preparing", 0);
        void produce(run);
    }

    function stop() {
        const run = current;
        if (!run) return;
        const index = run.clip?.index ?? run.ready[0]?.index ?? run.next;
        release(run);
        report(run, "stopped", Math.min(index, run.chunks.length - 1));
    }

    function close() {
        closed = true;
        if (current) release(current);
    }

    return {start, stop, close};
}
