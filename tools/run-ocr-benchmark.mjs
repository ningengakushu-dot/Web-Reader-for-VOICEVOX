import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 実行者ごとに異なるローカルパスを埋め込まないため、Chromium の場所は環境変数で受け取る
// （例: Playwright 同梱の chrome.exe を OCR_CHROMIUM に設定する）。
const chromium = process.env.OCR_CHROMIUM;
if (!chromium) throw new Error("set OCR_CHROMIUM to a Chromium executable path");
const imagePath = process.argv[2];
if (!imagePath) throw new Error("usage: node tools/run-ocr-benchmark.mjs <image> [x y width height]");

const numbers = process.argv.slice(3, 7).map(Number);
const crop = numbers.length === 4 && numbers.every(Number.isFinite)
    ? { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }
    : undefined;
const options = process.argv.slice(crop ? 7 : 3);
const valueList = (prefix) => options.find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length).split(",").map(Number).filter(Number.isFinite);
const scales = valueList("--scales=");
const psmModes = valueList("--psm=") || [];
const padding = Number(options.find((arg) => arg.startsWith("--padding="))?.slice(10)) || 0;
const maskRed = options.includes("--mask-red");
const forceOrientation = options.find((arg) => arg.startsWith("--orientation="))?.slice(14);
const crossLanguages = options.find((arg) => arg.startsWith("--languages="))
    ?.slice(12).split(",").filter(Boolean) || [];
const verticalReflow = options.includes("--vertical-reflow");
const profile = await mkdtemp(resolve(tmpdir(), "vvreader-ocr-benchmark-"));
const port = 9337;
const browser = spawn(chromium, [
    "--headless=new",
    "--disable-gpu",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    `--remote-debugging-port=${port}`,
    "about:blank"
], { stdio: "ignore", windowsHide: true });

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function poll(fn, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await wait(100);
    }
    throw lastError || new Error("待機がタイムアウトしました。");
}

async function evaluate(webSocketDebuggerUrl, expression) {
    return new Promise((resolveEval, reject) => {
        const socket = new WebSocket(webSocketDebuggerUrl);
        const id = 1;
        socket.addEventListener("open", () => socket.send(JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true }
        })));
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            socket.close();
            if (message.error || message.result?.exceptionDetails) {
                reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
            } else {
                resolveEval(message.result.result.value);
            }
        });
        socket.addEventListener("error", reject);
    });
}

try {
    await poll(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
    const securePreferences = await poll(async () => {
        const path = resolve(profile, "Default", "Secure Preferences");
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return Object.entries(parsed.extensions?.settings || {})
            .find(([, value]) => resolve(value.path || "") === root)?.[0];
    });
    const pageUrl = `chrome-extension://${securePreferences}/tools/ocr-benchmark.html`;
    const target = await (await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`,
        { method: "PUT" }
    )).json();
    await poll(async () => evaluate(target.webSocketDebuggerUrl, "typeof runOcrBenchmark === 'function'"));
    const dataUrl = `data:image/png;base64,${(await readFile(resolve(imagePath))).toString("base64")}`;
    const result = await evaluate(target.webSocketDebuggerUrl,
        `runOcrBenchmark(${JSON.stringify({
            dataUrl,
            crop,
            ...(scales?.length ? { scales } : {}),
            psmModes,
            padding,
            maskRed,
            forceOrientation,
            crossLanguages,
            verticalReflow
        })})`);
    const compact = {
        ...result,
        passes: Object.fromEntries(Object.entries(result.passes).map(([name, pass]) => [name, {
            elapsedMs: pass.elapsedMs,
            confidence: pass.confidence,
            glyphSize: pass.glyphSize,
            text: pass.text,
            ...(pass.counts ? { counts: pass.counts, nominalPitch: pass.nominalPitch } : {}),
            lines: pass.lines.map((line) => ({
                text: line.text,
                confidence: line.confidence,
                bbox: line.bbox
            }))
        }]))
    };
    process.stdout.write(`${JSON.stringify(compact, null, 2)}\n`);
} finally {
    browser.kill();
    await Promise.race([
        new Promise((resolveExit) => browser.once("exit", resolveExit)),
        wait(2000)
    ]);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
