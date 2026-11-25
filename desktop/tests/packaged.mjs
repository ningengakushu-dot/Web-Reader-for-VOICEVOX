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

// Only the driver can redirect this process's engine socket. This exercises real
// ECONNREFUSED and startup without stopping an engine already owned by the user.
async function observeRequests(port) {
    await app.evaluate((_, port) => {
        const http = process.getBuiltinModule("http");
        const original = http.request;
        global.readerQA = { port, chunks: [], synthesisCount: 0 };
        http.request = function (options, cb) {
            if (options.hostname !== "127.0.0.1" || options.port !== 50021) return original(options, cb);
            const url = new URL(options.path, "http://localhost");
            if (url.pathname === "/audio_query") global.readerQA.chunks.push(url.searchParams.get("text"));
            if (url.pathname === "/synthesis") global.readerQA.synthesisCount++;
            return original({ ...options, port: global.readerQA.port }, cb);
        };
    }, port);
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
    await page.click("#reconnect");
    await connected();
}

async function checkReading(label, text) {
    const expected = Array.from(reference.splitText(text));
    assert.deepEqual(await page.evaluate(text => window.splitText(text), text), expected);
    await app.evaluate(() => { global.readerQA.chunks = []; });
    await page.fill("#text", text);
    await page.evaluate(() => {
        window.events = [];
        document.addEventListener("reader-timing", event => window.events.push(event.detail),
            { signal: (window.capture = new AbortController()).signal });
    });
    // Capture time on Enter, after the modifier key.
    await page.keyboard.down("Control");
    await page.evaluate(() => {
        document.addEventListener("keydown", () => { window.readAt = performance.now(); }, {capture: true, once: true});
    });
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await page.locator('#status[data-state="finished"]').waitFor({timeout: 180000});
    const observation = await page.evaluate(() => {
        window.capture.abort();
        return { events: window.events, readAt: window.readAt };
    });
    assert.deepEqual(await app.evaluate(() => global.readerQA.chunks), expected);
    const playing = observation.events.filter(item => item.event === "playing");
    const ended = observation.events.filter(item => item.event === "ended");
    for (const series of [playing, ended]) assert.deepEqual(series.map(e => e.index), expected.map((_, i) => i));
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
    await page.fill("#text", "接続を待って入力した文章です。");
    await state("error");
    assert.match(await page.textContent("#status"), /VOICEVOXを起動して再接続してください/);
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
        await page.click("#read");
        await state("playing");
        await page.keyboard.press("Escape");
        await state("stopped");
        await reconnect(50021);
        console.log("recovery and playback stop passed");
        console.log("engine", await (await fetch("http://127.0.0.1:50021/version")).json(),
            await page.locator("#speaker option:checked").textContent(),
            await page.locator("#style option:checked").textContent(), await page.inputValue("#style"),
            "speed", await page.inputValue("#speed"), "volume", await page.inputValue("#volume"));
        for (const [label, text] of cases) await checkReading(label, text);

        await page.fill("#text", longText);
        await app.evaluate(() => { global.readerQA.synthesisCount = 0; });
        await page.click("#read");
        const deadline = Date.now() + 15000;
        while (!(await app.evaluate(() => global.readerQA.synthesisCount))) {
            if (Date.now() >= deadline) throw new Error("Synthesis did not start");
            await delay(10);
        }
        assert.equal(await page.getAttribute("#status", "data-state"), "preparing");
        await page.keyboard.press("Escape");
        await state("stopped");
        await checkReading("replacement", "こちらは次の文章です。");
        await page.selectOption("#speaker", { index: 0 });
        const styleCount = await page.locator("#style option").count();
        await page.selectOption("#style", { index: Math.min(1, styleCount - 1) });
        await page.fill("#speed", "");
        const countBefore = await app.evaluate(() => global.readerQA.chunks.length);
        await page.keyboard.press("Control+Enter");
        assert.equal(await page.locator("#speed").evaluate(input => input.validity.valueMissing), true);
        assert.equal(await app.evaluate(() => global.readerQA.chunks.length), countBefore);
        await page.fill("#speed", "1.25");
        await page.fill("#volume", "65");
        const ids = ["speaker", "style", "speed", "volume"];
        const values = () => Promise.all(ids.map(id => page.inputValue("#" + id)));
        const selected = await values();
        await page.waitForFunction(async () => (await window.reader.getSettings()).volume === 0.65);
        await page.fill("#text", cases[2][1]);
        await page.click("#read");
        await state("playing");
        await Promise.all([app.waitForEvent("close"),
            app.evaluate(({BrowserWindow}) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 25); })]);
        app = null;
        await launch();
        await connected();
        assert.deepEqual(await values(), selected);
        assert.equal(await page.inputValue("#text"), "");
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, "settings.json"), "utf8")),
            {styleId: Number(selected[1]), speed: 1.25, volume: 0.65});
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
