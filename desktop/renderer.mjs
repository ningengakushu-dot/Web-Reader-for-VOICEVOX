import { createPlayer } from "./player.mjs";

const byId = (id) => document.getElementById(id);
const text = byId("text");
const speaker = byId("speaker");
const style = byId("style");
const speed = byId("speed");
const volume = byId("volume");
const pitch = byId("pitch");
const intonation = byId("intonation");
const pause = byId("pause");
const voiceDetails = byId("voice-details");
const numericSettings = [speed, volume, pitch, intonation, pause];
const settingsInputs = [speaker, style, ...numericSettings];
const read = byId("read");
const stop = byId("stop");
const reconnect = byId("reconnect");
const connection = byId("connection");
const status = byId("status");
const announcement = byId("announcement");
const settingsNotice = byId("settings-notice");
const offlineMessage = "VOICEVOXを起動して再接続してください。";
const maxInputLength = 100_000;

let speakers = [];
let preferredStyleId = 3;
let connecting = false;
let closed = false;
let active = false;
let playbackStarted = false;
let saveRevision = 0;
let composing = false;

function refreshControls() {
    const connected = speakers.length > 0;
    const busy = connecting || active;
    // Action buttons remain focusable when their availability changes.
    read.setAttribute("aria-disabled", String(!connected || busy));
    stop.setAttribute("aria-disabled", String(!active));
    reconnect.setAttribute("aria-disabled", String(busy));
    const settingsUnavailable = !connected || busy;
    // Ctrl+Enter also works from settings. Move focus before disabling its field.
    if (settingsUnavailable && settingsInputs.includes(document.activeElement)) (active ? stop : text).focus();
    for (const input of settingsInputs) input.disabled = settingsUnavailable;
}

function showState(state, message, notification = message) {
    text.removeAttribute("aria-invalid");
    status.dataset.state = state;
    status.textContent = message;
    if (notification !== null) announcement.textContent = notification;
    active = state === "preparing" || state === "playing";
    if (!active) playbackStarted = false;
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
        // Keep the current position available without speaking over every clip.
        case "preparing":
            showState(state, "準備中" + position, active ? null : "読み上げを準備しています。");
            break;
        case "playing":
            showState(state, "再生中" + position, playbackStarted ? null : "読み上げを開始しました。");
            playbackStarted = true;
            break;
        case "stopped": showState(state, "停止"); break;
        case "finished": showState(state, "読み上げ完了"); break;
        case "error":
            if (error?.message === "offline") {
                showDisconnected();
                showState(state, `読み上げを中断しました${position}。${offlineMessage}`);
            } else if (error?.message === "playback") {
                showState(state, `音声を再生できませんでした${position}。Windowsの音声出力先を確認して、もう一度読み上げてください。`);
            } else {
                showState(state, `音声を合成できませんでした${position}。もう一度読み上げてください。`);
            }
            break;
    }
}

// The producer has one outstanding engine call. Cancel it before a new run starts.
async function synthesize(chunk, settings, signal) {
    signal.throwIfAborted();
    const cancel = () => window.reader.cancel();
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
    readingCost: window.speechCost,
    onTiming: (detail) => document.dispatchEvent(new CustomEvent("reader-timing", { detail, bubbles: true }))
});

function selectedSettings() {
    return {
        styleId: Number(style.value),
        speed: speed.valueAsNumber,
        volume: volume.valueAsNumber / 100,
        pitch: pitch.valueAsNumber,
        intonation: intonation.valueAsNumber,
        pause: pause.valueAsNumber
    };
}

function showInputError(message) {
    showState("error", message);
    text.setAttribute("aria-invalid", "true");
    text.focus();
}

function readFromStart() {
    if (closed || !speakers.length || connecting || active) return;
    const invalidSetting = numericSettings.find((input) => !input.validity.valid);
    if (invalidSetting) {
        if (voiceDetails.contains(invalidSetting)) voiceDetails.open = true;
        invalidSetting.reportValidity();
        return;
    }
    if (text.value.length > maxInputLength) {
        showInputError("本文が長すぎます。10万文字以内に分けてください。");
        return;
    }
    const chunks = window.splitText(text.value);
    if (!chunks.length) {
        showInputError("読み上げる文字を本文に入力してください。");
        return;
    }
    // At the cap the shared splitter replaces the last chunk with a spoken
    // truncation notice. Keep the whole input editable and ask for a shorter part.
    if (chunks.length >= SPEECH_MAX_CHUNKS) {
        showInputError("読み上げ単位が多すぎます。本文を分けてください。");
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
    announcement.textContent = "VOICEVOXへの接続を確認しています。";
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
        showState("stopped", "停止", "VOICEVOXに接続しました。読み上げできます。");
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
    if (!style.value || numericSettings.some((input) => !input.validity.valid)) return;
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
stop.addEventListener("click", () => { if (active) player.stop(); });
reconnect.addEventListener("click", connect);
text.addEventListener("input", () => {
    if (text.hasAttribute("aria-invalid")) showState("stopped", "停止", "");
});
speaker.addEventListener("change", () => {
    setStyles(speakers[speaker.selectedIndex], null);
    saveSettings();
});
style.addEventListener("change", saveSettings);
for (const input of numericSettings) input.addEventListener("input", saveSettings);
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => { composing = false; });
document.addEventListener("focusout", () => { composing = false; });
document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229 || event.repeat) return;
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

if (document.activeElement === document.body) text.focus();
try {
    const settings = await window.reader.getSettings();
    if (settings) {
        preferredStyleId = settings.styleId ?? preferredStyleId;
        speed.value = String(settings.speed ?? 1);
        volume.value = String(Math.round((settings.volume ?? 1) * 100));
        pitch.value = String(settings.pitch ?? 0);
        intonation.value = String(settings.intonation ?? 1);
        pause.value = String(settings.pause ?? 1);
    }
} catch {
    settingsNotice.textContent = "保存済みの設定を読み込めませんでした。";
}
await connect();
