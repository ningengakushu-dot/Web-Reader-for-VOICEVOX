// 出荷するentry/audioを仮想時計で動かす。予測式を別実装したシミュレーターにはしない。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

function createAudioPipeline({ rows, sourceRef = null }) {
    let now = 0;
    let nextId = 1;
    let listener;
    const timers = new Map();
    const urls = new Map();
    const requests = [];
    const starts = [];
    const notifications = [];
    const revoked = [];
    const queryCounts = new Map();
    const schedule = (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + Math.max(0.001, Number(ms) || 0), fn });
        return id;
    };
    const cancel = (id) => timers.delete(id);
    const delay = (ms) => ms > 0 ? new Promise((resolve) => schedule(resolve, ms)) : Promise.resolve();
    class Audio {
        constructor(url) { this.blob = urls.get(url); }
        play() {
            starts.push({ text: this.blob.row.text, at: now / 1000, durationSec: this.blob.durationSec });
            this.timer = schedule(() => this.onended?.(), this.blob.durationSec * 1000);
            return Promise.resolve();
        }
        pause() { cancel(this.timer); }
        removeAttribute() {}
        load() { cancel(this.timer); }
    }
    const context = vm.createContext({
        console: { ...console, error() {} }, Audio,
        setTimeout: schedule, clearTimeout: cancel, performance: { now: () => now },
        URL: {
            createObjectURL(blob) { const url = `blob:${nextId++}`; urls.set(url, blob); return url; },
            revokeObjectURL(url) { revoked.push(url); urls.delete(url); }
        },
        chrome: { runtime: {
            id: 'test', onMessage: { addListener(fn) { listener = fn; } },
            sendMessage(message) { notifications.push({ ...message, at: now / 1000 }); return Promise.resolve(); }
        } },
        VOICEVOX_BASE_URL: 'http://127.0.0.1:50021',
        VOICEVOX_FETCH_TIMEOUT_MS: 15000, VOICEVOX_SYNTHESIS_TIMEOUT_MS: 60000,
        async fetchWithTimeout(url, options) {
            if (url.includes('/audio_query')) {
                const text = new URL(url).searchParams.get('text');
                const candidates = rows.map((row, index) => ({ row, index })).filter((entry) => entry.row.text === text);
                const occurrence = queryCounts.get(text) || 0;
                queryCounts.set(text, occurrence + 1);
                const planned = candidates[Math.min(occurrence, candidates.length - 1)];
                const row = planned?.row;
                if (!row) throw new Error(`Unknown text: ${text}`);
                requests.push({ type: 'query', text, at: now / 1000 });
                await delay(row.queryMs || 0);
                if (row.queryError) throw new TypeError('Failed to fetch');
                return { ok: true, row, index: planned.index };
            }
            const query = JSON.parse(options.body);
            const row = rows[query.__pipelineIndex];
            requests.push({ type: 'synthesis', text: row.text, at: now / 1000 });
            await delay(row.synthMs);
            return { ok: true, row, query };
        },
        async readJsonResponseWithLimit(response) {
            const row = response.row;
            const query = row.query ? JSON.parse(JSON.stringify(row.query)) : {
                accent_phrases: [{ moras: [{ vowel_length: row.audioSec - 0.2 }] }],
                prePhonemeLength: 0.1, postPhonemeLength: 0.1
            };
            query.__pipelineIndex = response.index;
            return query;
        },
        async readBlobResponseWithLimit(response) {
            const { row, query } = response;
            const durationSec = row.query ? row.audioSec : 0.2 + (row.audioSec - 0.2) / query.speedScale;
            return { row, durationSec };
        }
    });
    for (const file of ['offscreen-entry.js', 'offscreen-audio.js']) {
        const source = sourceRef
            ? execFileSync('git', ['show', `${sourceRef}:${file}`], { cwd: root, encoding: 'utf8' })
            : fs.readFileSync(path.join(root, file), 'utf8');
        vm.runInContext(source, context, { filename: file });
    }
    const send = (message) => listener({ target: 'offscreen', ...message }, { id: 'test' }, () => {});
    async function advanceTo(until = Infinity) {
        for (let steps = 0; steps < 100000; steps++) {
            // Promiseの連鎖を、次の外部イベントより先に完了させる。
            await new Promise((resolve) => setImmediate(resolve));
            let next;
            for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
            if (!next || next[1].at > until) {
                if (Number.isFinite(until)) now = until;
                return;
            }
            timers.delete(next[0]);
            now = next[1].at;
            next[1].fn();
        }
        throw new Error('Audio pipeline did not settle');
    }
    return {
        context, starts, notifications, requests, urls, revoked, advanceTo,
        enqueue(texts = rows.map((row) => row.text), settings = {}) {
            send({ type: 'ENQUEUE_TEXTS', texts, settings: {
                speakerId: 3, speedScale: 1, pitchScale: 0, intonationScale: 1,
                volumeScale: 1, pauseLengthScale: 1, ...settings
            } });
        },
        stop() { send({ type: 'STOP_AUDIO' }); },
        report() {
            const gaps = starts.slice(1).map((start, i) => Math.max(0,
                start.at - starts[i].at - starts[i].durationSec));
            return { startLatency: starts[0]?.at ?? null, maxGap: Math.max(0, ...gaps),
                totalGap: gaps.reduce((sum, gap) => sum + gap, 0), gaps,
                played: starts.map((start) => start.text),
                ended: notifications.some((notice) => notice.type === 'PLAYBACK_ENDED') };
        }
    };
}
module.exports = { createAudioPipeline };
