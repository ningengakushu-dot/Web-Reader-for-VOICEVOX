// Runs the extracted EXE. The driver observes synthetic fixtures in memory only.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { _electron } from "playwright-core";

const desktop = path.dirname(import.meta.dirname);
const { version } = JSON.parse(await fs.readFile(path.join(desktop, "package.json")));
const folder = `VOICEVOX-Local-Reader-${version}-win-x64`;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "voicevox-reader-qa-"));
const profile = path.join(temp, "profile");
const archive = path.join(desktop, "dist", folder + ".zip");
const source = await fs.readFile(path.join(desktop, "..", "background-speech.js"), "utf8");
const reference = vm.createContext({});
vm.runInContext(source, reference);

const longText = "朝の川沿いの道を歩きながら鳥の声を聞きました".repeat(7);
const cases = [
    ["short", "こんにちは。"],
    ["heading", "朝の便り\n窓を開けました。\n公園の桜が咲いています。"],
    ["long", longText],
    ["heading-long", "概要\n" + longText]
];
let app, page, isolated;
const failures = [];
async function launch() {
    app = await _electron.launch({
        executablePath: path.join(temp, folder, "VOICEVOX-Local-Reader.exe"),
        args: ["--user-data-dir=" + profile], timeout: 60000
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => failures.push(error.name));
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), profile);
}
const state = value => page.locator(`#status[data-state="${value}"]`).waitFor();
const connected = () => page.locator('#connection[data-state="connected"]').waitFor();
async function focus(id) {
    assert.equal(await page.evaluate(() => document.activeElement?.id), id, `Expected keyboard focus on #${id}`);
}
const announcement = () => page.locator('#announcement[role="status"][aria-atomic="true"]').textContent();

async function tabTo(key, ids) {
    for (const id of ids) {
        await page.keyboard.press(key);
        await focus(id);
    }
}

// Only the driver can redirect this process's engine socket. This exercises real
// ECONNREFUSED and startup without stopping an engine already owned by the user.
async function observeRequests(port) {
    await app.evaluate((_, port) => {
        const http = process.getBuiltinModule("http");
        const original = http.request;
        global.readerQA = { port, chunks: [], holdSynthesis: false, held: null };
        http.request = function (options, cb) {
            if (options.hostname !== "127.0.0.1" || options.port !== 50021) return original(options, cb);
            const url = new URL(options.path, "http://localhost");
            if (url.pathname === "/audio_query") global.readerQA.chunks.push(url.searchParams.get("text"));
            if (url.pathname !== "/synthesis") return original({ ...options, port: global.readerQA.port }, cb);
            let request;
            if (global.readerQA.holdSynthesis) {
                global.readerQA.holdSynthesis = false;
                // Retain one real engine response before the app can read it so
                // the keyboard stop and the replacement run have a fixed order.
                request = original({ ...options, port: global.readerQA.port }, response => {
                    global.readerQA.held = { signal: options.signal, deliver: () => cb(response) };
                });
            } else {
                request = original({ ...options, port: global.readerQA.port }, cb);
            }
            const end = request.end;
            request.end = function (body, ...args) {
                const { speedScale, volumeScale, pitchScale, intonationScale, pauseLengthScale } = JSON.parse(body);
                global.readerQA.voiceSettings = { speedScale, volumeScale, pitchScale, intonationScale, pauseLengthScale };
                return end.call(this, body, ...args);
            };
            return request;
        };
    }, port);
}

async function waitForMain(predicate, message) {
    const end = Date.now() + 15000;
    while (!(await app.evaluate(predicate))) {
        if (Date.now() >= end) throw new Error(message);
        await delay(10);
    }
}
async function reservePort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function reconnect(port) {
    await app.evaluate((_, port) => { global.readerQA.port = port; }, port);
    await page.locator("#reconnect").press("Enter");
    await connected();
    await focus("reconnect");
    assert.equal(await announcement(), "VOICEVOXに接続しました。読み上げできます。");
}

async function checkWindowsControls() {
    await app.evaluate(({ BrowserWindow, Menu }) => {
        const popup = Menu.prototype.popup;
        Menu.prototype.popup = function (options) {
            global.readerQA.contextMenu = {
                menu: this,
                roles: this.items.map(item => item.role),
                target: options.window === BrowserWindow.getAllWindows()[0]
            };
            return popup.call(this, options);
        };
        global.readerQA.restorePopup = () => { Menu.prototype.popup = popup; };
    });
    try {
        await page.locator("#text").click({ button: "right" });
        await waitForMain(() => Boolean(global.readerQA.contextMenu), "No native context menu for the editor");
        await app.evaluate(({ BrowserWindow }) => {
            global.readerQA.contextMenu.menu.closePopup(BrowserWindow.getAllWindows()[0]);
        });
        const options = await app.evaluate(() => ({
            roles: global.readerQA.contextMenu.roles,
            target: global.readerQA.contextMenu.target
        }));
        assert.equal(options.target, true);
        assert.ok(options.roles.includes("paste"));
    } finally {
        await app.evaluate(() => { global.readerQA.restorePopup(); });
    }

    const applicationMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items
        .find(item => item.label.startsWith("表示"))?.submenu.items.map(item => item.role.toLowerCase()));
    for (const role of ["zoomin", "zoomout", "resetzoom"]) assert.ok(applicationMenu?.includes(role));

    const initialScale = await page.evaluate(() => window.devicePixelRatio);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    try {
        await page.waitForFunction(initialScale => window.devicePixelRatio >= initialScale * 1.99, initialScale);
        const { width, scrollWidth } = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth
        }));
        assert.ok(scrollWidth <= width, `200% zoom shows horizontal overflow (${scrollWidth} > ${width})`);
    } finally {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
        await page.waitForFunction(initialScale => window.devicePixelRatio === initialScale, initialScale);
    }
    console.log("Windows editor context menu and 200% layout passed");
}

async function composition(type) {
    await page.locator("#text").evaluate((editor, type) => {
        editor.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    }, type);
}

async function checkReading(label, text, onStart) {
    const expected = Array.from(reference.splitText(text));
    assert.deepEqual(await page.evaluate(text => window.splitText(text), text), expected);
    await app.evaluate(() => { global.readerQA.chunks = []; });
    await page.fill("#text", text);
    await page.evaluate(() => {
        window.events = [];
        window.announcements = [];
        document.addEventListener("reader-timing", event => window.events.push(event.detail),
            { signal: (window.capture = new AbortController()).signal });
        const live = document.getElementById("announcement");
        window.liveCapture = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) window.announcements.push(node.textContent);
            }
        });
        window.liveCapture.observe(live, { childList: true });
    });
    // Capture time on Enter, after the modifier key.
    await page.keyboard.down("Control");
    await page.evaluate(() => {
        document.addEventListener("keydown", () => { window.readAt = performance.now(); }, {capture: true, once: true});
    });
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await onStart?.();
    await page.locator('#status[data-state="finished"]').waitFor({timeout: 180000});
    const observation = await page.evaluate(() => {
        window.capture.abort();
        window.liveCapture.disconnect();
        return { events: window.events, readAt: window.readAt, announcements: window.announcements };
    });
    assert.deepEqual(await app.evaluate(() => global.readerQA.chunks), expected);
    assert.deepEqual(observation.announcements, ["読み上げを準備しています。", "読み上げを開始しました。", "読み上げ完了"]);
    const playing = observation.events.filter(item => item.event === "playing");
    const ended = observation.events.filter(item => item.event === "ended");
    const ready = observation.events.filter(item => item.event === "ready");
    for (const series of [ready, playing, ended]) assert.deepEqual(series.map(e => e.index), expected.map((_, i) => i));
    for (const [index, event] of ready.entries()) {
        assert.ok(observation.readAt <= event.at && event.at <= playing[index].at && playing[index].at <= ended[index].at);
    }
    const gap = playing.slice(1).map((e, i) => Math.round(e.at - ended[i].at));
    console.log(JSON.stringify({label, units: expected.length, firstMs: Math.round(playing[0].at - observation.readAt),
        waitMs: playing.slice(1).map(e => Math.round(e.synthesisWaitMs)), mediaGapMs: gap}));
}

try {
    execFileSync("tar.exe", ["-xf", archive, "-C", temp], {windowsHide: true});
    assert.equal(await fs.readFile(path.join(temp, folder, "resources/app/background-speech.js"), "utf8"), source);
    await launch();
    const port = await reservePort();
    await observeRequests(port);
    await page.reload();
    await state("error");
    // Autofocus runs when Chromium returns to the renderer after navigation.
    await page.waitForFunction(() => document.activeElement?.id === "text");
    await focus("text");
    await tabTo("Shift+Tab", ["reconnect"]);
    await tabTo("Tab", ["text"]);
    await page.fill("#text", "接続を待って入力した文章です。");
    assert.match(await page.textContent("#status"), /VOICEVOXを起動して再接続してください/);
    assert.match(await announcement(), /VOICEVOXを起動して再接続してください/);
    assert.equal(await page.inputValue("#text"), "接続を待って入力した文章です。");
    console.log("packaged offline UI passed");
    if (!process.argv.includes("--offline-only")) {
        if (process.env.READER_QA_ENGINE) {
            const exe = process.env.READER_QA_ENGINE;
            isolated = spawn(exe, ["--host", "127.0.0.1", "--port", String(port), "--cpu_num_threads", "2"],
                {cwd: path.dirname(exe), windowsHide: true, stdio: "ignore"});
            const end = Date.now() + 90000;
            while (true) {
                if (isolated.exitCode !== null) throw new Error("Isolated engine exited before startup");
                try { if ((await fetch(`http://127.0.0.1:${port}/version`)).ok) break; } catch { /* starting */ }
                if (Date.now() >= end) throw new Error("Isolated engine startup timed out");
                await delay(250);
            }
            await reconnect(port);
        } else {
            await reconnect(50021);
        }
        assert.equal(await page.inputValue("#text"), "接続を待って入力した文章です。");
        assert.equal(await page.locator("#voice-details").evaluate(details => details.open), false);
        assert.deepEqual(await Promise.all(["pitch", "intonation", "pause"].map(id => page.inputValue(`#${id}`))),
            ["0", "1", "1"]);
        await tabTo("Tab", ["text", "speaker", "style", "speed", "volume", "voice-details-summary", "read"]);
        await tabTo("Shift+Tab", ["voice-details-summary", "volume", "speed", "style", "speaker", "text", "reconnect"]);
        await page.locator("#read").press("Enter");
        await focus("read");
        await state("playing");
        await page.keyboard.press("Escape");
        await state("stopped");
        await focus("read");
        assert.equal(await announcement(), "停止");
        await reconnect(50021);
        console.log("recovery and playback stop passed");
        await checkWindowsControls();
        console.log("engine", await (await fetch("http://127.0.0.1:50021/version")).json(),
            await page.locator("#speaker option:checked").textContent(),
            await page.locator("#style option:checked").textContent(), await page.inputValue("#style"),
            "speed", await page.inputValue("#speed"), "volume", await page.inputValue("#volume"));
        for (const [label, text] of cases) await checkReading(label, text);

        // A synthetic composition lifecycle exercises the app's shortcut guard.
        // Key presses, playback and synthesis still use the packaged EXE.
        await page.fill("#text", "日本語を入力しています。");
        await app.evaluate(() => { global.readerQA.chunks = []; });
        await composition("compositionstart");
        await page.keyboard.press("Control+Enter");
        assert.equal(await page.getAttribute("#status", "data-state"), "finished");
        assert.deepEqual(await app.evaluate(() => global.readerQA.chunks), []);
        await composition("compositionend");

        await page.fill("#text", longText);
        await app.evaluate(() => { global.readerQA.holdSynthesis = true; });
        await page.locator("#read").press("Enter");
        await waitForMain(() => Boolean(global.readerQA.held), "No real synthesis response to hold");
        assert.equal(await page.getAttribute("#status", "data-state"), "preparing");
        await focus("read");
        await composition("compositionstart");
        await page.keyboard.press("Escape");
        assert.equal(await page.getAttribute("#status", "data-state"), "preparing");
        await composition("compositionend");
        await tabTo("Tab", ["stop"]);
        await page.keyboard.press("Enter");
        await state("stopped");
        await focus("stop");
        await waitForMain(() => global.readerQA.held.signal.aborted, "Stop did not abort synthesis");
        await checkReading("replacement", "こちらは次の文章です。", async () => {
            await waitForMain(() => global.readerQA.chunks.length > 0, "Replacement did not reach the engine");
            await app.evaluate(() => {
                global.readerQA.held.deliver();
                global.readerQA.held = null;
            });
        });
        console.log("Tab navigation, shortcut focus, composition guard and preparation cancellation passed");
        await page.selectOption("#speaker", { index: 0 });
        const styleCount = await page.locator("#style option").count();
        await page.selectOption("#style", { index: Math.min(1, styleCount - 1) });
        await page.fill("#speed", "");
        const countBefore = await app.evaluate(() => global.readerQA.chunks.length);
        await page.keyboard.press("Control+Enter");
        assert.equal(await page.locator("#speed").evaluate(input => input.validity.valueMissing), true);
        assert.equal(await app.evaluate(() => global.readerQA.chunks.length), countBefore);
        await page.fill("#speed", "1.25");
        assert.equal(await page.getAttribute("#volume", "max"), "200");
        await page.fill("#volume", "125");
        await page.locator("#voice-details-summary").press("Enter");
        await tabTo("Tab", ["pitch", "intonation", "pause"]);
        await page.fill("#pitch", "");
        await page.locator("#voice-details-summary").press("Enter");
        assert.equal(await page.locator("#voice-details").evaluate(details => details.open), false);
        await page.keyboard.press("Control+Enter");
        await focus("pitch");
        assert.equal(await page.locator("#voice-details").evaluate(details => details.open), true);
        assert.equal(await app.evaluate(() => global.readerQA.chunks.length), countBefore);
        await page.fill("#pitch", "0.05");
        await page.fill("#intonation", "0.8");
        await page.fill("#pause", "1.3");
        const ids = ["speaker", "style", "speed", "volume", "pitch", "intonation", "pause"];
        const values = () => Promise.all(ids.map(id => page.inputValue("#" + id)));
        const selected = await values();
        await page.waitForFunction(async () => (await window.reader.getSettings()).pause === 1.3);
        await page.fill("#text", cases[2][1]);
        await page.click("#read");
        await state("playing");
        assert.deepEqual(await app.evaluate(() => global.readerQA.voiceSettings), {
            speedScale: 1.25, volumeScale: 1.25, pitchScale: 0.05, intonationScale: 0.8, pauseLengthScale: 1.3
        });
        await Promise.all([app.waitForEvent("close"),
            app.evaluate(({BrowserWindow}) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 25); })]);
        app = null;
        await launch();
        await connected();
        assert.deepEqual(await values(), selected);
        assert.equal(await page.inputValue("#text"), "");
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, "settings.json"), "utf8")),
            {styleId: Number(selected[1]), speed: 1.25, volume: 1.25, pitch: 0.05, intonation: 0.8, pause: 1.3});
        console.log("window close during playback, restored preferences and empty editor passed");
    }
    assert.deepEqual(failures, []);
} finally {
    if (app) await app.close();
    if (isolated && isolated.exitCode === null) {
        const exited = once(isolated, "exit");
        isolated.kill();
        await exited;
    }
    await fs.rm(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 300});
}
