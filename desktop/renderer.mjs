import { createPlayer } from "./player.mjs";

const byId = (id) => document.getElementById(id);
const text = byId("text");
const speaker = byId("speaker");
const style = byId("style");
const speed = byId("speed");
const volume = byId("volume");
const read = byId("read");
const stop = byId("stop");
const reconnect = byId("reconnect");
const connection = byId("connection");
const status = byId("status");
const settingsNotice = byId("settings-notice");
const offlineMessage = "VOICEVOXを起動して再接続してください";
const maxInputLength = 100_000;

let speakers = [];
let preferredStyleId = 3;
let connecting = false;
let closed = false;
let active = false;
let saveRevision = 0;

function refreshControls() {
    const connected = speakers.length > 0;
    read.disabled = !connected || connecting || active;
    stop.disabled = !active;
    reconnect.disabled = connecting || active;
    for (const input of [speaker, style, speed, volume]) {
        input.disabled = !connected || connecting || active;
    }
}

function showState(state, message) {
    status.dataset.state = state;
    status.textContent = message;
    active = state === "preparing" || state === "playing";
    refreshControls();
}

function showDisconnected() {
    speakers = [];
    speaker.replaceChildren();
    style.replaceChildren();
    connection.dataset.state = "offline";
    connection.textContent = "VOICEVOX 未接続";
}

function onState({ state, index, total, error }) {
    if (closed) return;
    const position = `（${index + 1} / ${total}）`;
    switch (state) {
        case "preparing": showState(state, "準備中" + position); break;
        case "playing": showState(state, "再生中" + position); break;
        case "stopped": showState(state, "停止"); break;
        case "finished": showState(state, "読み上げ完了"); break;
        case "error":
            if (error?.message === "offline") {
                showDisconnected();
                showState(state, offlineMessage);
            } else {
                showState(state, "エラー" + position + "　音声を読み上げられませんでした。再度お試しください。");
            }
            break;
    }
}

// A run can have several pending units sharing one signal. Send cancellation
// once while the old run still owns the outstanding requests.
const cancelledSignals = new WeakSet();
async function synthesize(chunk, settings, signal) {
    signal.throwIfAborted();
    const cancel = () => {
        if (cancelledSignals.has(signal)) return;
        cancelledSignals.add(signal);
        window.reader.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        const result = await window.reader.synthesize(chunk, settings);
        signal.throwIfAborted();
        if (!result.ok) throw new Error(result.error);
        return result.value;
    } finally {
        signal.removeEventListener("abort", cancel);
    }
}

const player = createPlayer({
    synthesize,
    onState,
    onTiming: (detail) => document.dispatchEvent(new CustomEvent("reader-timing", { detail, bubbles: true }))
});

function selectedSettings() {
    return { styleId: Number(style.value), speed: speed.valueAsNumber, volume: volume.valueAsNumber / 100 };
}

function readFromStart() {
    if (read.disabled) return;
    if (!speed.reportValidity() || !volume.reportValidity()) return;
    if (text.value.length > maxInputLength) {
        showState("error", "本文が長すぎます。10万文字以内に分けてください。");
        return;
    }
    const chunks = window.splitText(text.value);
    if (!chunks.length) {
        showState("error", "読み上げる文字を本文に入力してください。");
        text.focus();
        return;
    }
    // At the cap the shared splitter replaces the last chunk with a spoken
    // truncation notice. Keep the whole input editable and ask for a shorter part.
    if (chunks.length >= SPEECH_MAX_CHUNKS) {
        showState("error", "読み上げ単位が多すぎます。本文を分けてください。");
        return;
    }
    player.start(chunks, selectedSettings());
}

function setStyles(selected, styleId) {
    style.replaceChildren(...selected.styles.map(({ name, id }) => new Option(name, String(id))));
    if (selected.styles.some(({ id }) => id === styleId)) style.value = String(styleId);
}

async function connect() {
    if (active || connecting || closed) return;
    connecting = true;
    connection.dataset.state = "connecting";
    connection.textContent = "接続を確認中…";
    refreshControls();
    try {
        const result = await window.reader.speakers();
        if (closed) return;
        if (!result.ok || !result.value.length) throw new Error(result.error || "empty");
        speakers = result.value;
        const selected = speakers.find(({ styles }) => styles.some(({ id }) => id === preferredStyleId)) ?? speakers[0];
        speaker.replaceChildren(...speakers.map(({ name }) => new Option(name, name)));
        speaker.selectedIndex = speakers.indexOf(selected);
        setStyles(selected, preferredStyleId);
        connection.dataset.state = "connected";
        connection.textContent = "VOICEVOX 接続済み";
        showState("stopped", "停止");
    } catch (error) {
        if (closed) return;
        showDisconnected();
        showState("error", error.message === "offline" ? offlineMessage : "話者を取得できませんでした。VOICEVOXを確認して再接続してください。");
    } finally {
        connecting = false;
        if (!closed) refreshControls();
    }
}

async function saveSettings() {
    if (!speed.checkValidity() || !volume.checkValidity() || !style.value) return;
    const settings = selectedSettings();
    preferredStyleId = settings.styleId;
    const revision = ++saveRevision;
    let saved = false;
    try { saved = await window.reader.saveSettings(settings); } catch { /* Show the same local error. */ }
    if (!closed && revision === saveRevision) {
        settingsNotice.textContent = saved ? "" : "設定を保存できませんでした。";
    }
}

read.addEventListener("click", readFromStart);
stop.addEventListener("click", () => player.stop());
reconnect.addEventListener("click", connect);
speaker.addEventListener("change", () => {
    setStyles(speakers[speaker.selectedIndex], null);
    saveSettings();
});
for (const input of [style, speed, volume]) input.addEventListener("change", saveSettings);
document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229 || event.repeat) return;
    if (event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        readFromStart();
    } else if (event.key === "Escape" && active) {
        event.preventDefault();
        player.stop();
    }
});
window.addEventListener("pagehide", () => {
    closed = true;
    player.close();
}, { once: true });

try {
    const settings = await window.reader.getSettings();
    if (settings) {
        preferredStyleId = settings.styleId ?? preferredStyleId;
        speed.value = String(settings.speed ?? 1);
        volume.value = String(Math.round((settings.volume ?? 1) * 100));
    }
} catch {
    settingsNotice.textContent = "保存済みの設定を読み込めませんでした。";
}
await connect();
