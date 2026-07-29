import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineIndex = process.argv.indexOf("--baseline");
const baselineRef = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : null;

function findChrome() {
    const candidates = [
        process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        process.env["PROGRAMFILES(X86)"]
            && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
        process.env.LOCALAPPDATA
            && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ["--version"], { stdio: "ignore" });
            return candidate;
        } catch {
            // 次の候補を試す
        }
    }
    throw new Error("Google Chrome が見つかりません");
}

function escapeScript(source) {
    return source.replace(/<\/script/gi, "<\\/script");
}

function runDomCase(chrome, source, name) {
    const temp = mkdtempSync(join(tmpdir(), "vvreader-dom-perf-"));
    const htmlPath = join(temp, "case.html");
    const profilePath = join(temp, "profile");
    const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 16px sans-serif; }
  #selected { position: relative; z-index: 2; width: 520px; margin: 16px; background: white; }
  #load { margin-top: 300px; }
  p { margin: 2px 0; }
</style>
<div id="selected">
  <p>精度確認用の文章一。</p>
  <p aria-hidden="true">読み上げてはいけない隠し文章。</p>
  <p>精度確認用の文章二。</p>
</div>
<div id="load"></div>
<script type="module">
${escapeScript(source)}

  const load = document.getElementById("load");
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 12000; i++) {
    const p = document.createElement("p");
    p.textContent = "選択範囲外の負荷確認用文章 " + i;
    fragment.appendChild(p);
  }
  load.appendChild(fragment);

  // 初回レイアウトのコストはDOM抽出そのものではないため、計測開始前に確定させる。
  const box = document.getElementById("selected").getBoundingClientRect();
  let pulseCount = 0;
  let maxPulseGapMs = 0;
  let lastPulse = performance.now();
  const pulse = setInterval(() => {
    const now = performance.now();
    maxPulseGapMs = Math.max(maxPulseGapMs, now - lastPulse);
    lastPulse = now;
    pulseCount++;
  }, 1);

  const started = performance.now();
  const result = await Promise.resolve(VVRadioDomText.collectRegionText({
    x: box.left,
    y: box.top,
    width: box.width,
    height: box.height
  }));
  const elapsedMs = performance.now() - started;
  maxPulseGapMs = Math.max(maxPulseGapMs, performance.now() - lastPulse);
  clearInterval(pulse);

  const report = {
    ok: result.ok,
    text: result.text,
    chars: result.chars,
    elapsedMs,
    pulseCount,
    maxPulseGapMs
  };
  const pre = document.createElement("pre");
  pre.id = "result";
  pre.textContent = JSON.stringify(report);
  document.body.replaceChildren(pre);
</script>`;
    writeFileSync(htmlPath, html, "utf8");

    try {
        const run = spawnSync(chrome, [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            `--user-data-dir=${profilePath}`,
            "--virtual-time-budget=30000",
            "--dump-dom",
            pathToFileURL(htmlPath).href
        ], {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            timeout: 60000
        });
        if (run.error) throw run.error;
        if (run.status !== 0) throw new Error(`Chrome終了コード ${run.status}: ${run.stderr}`);
        const match = /<pre id="result">([^<]+)<\/pre>/.exec(run.stdout);
        if (!match) {
            throw new Error(`${name}: DOM抽出テストが完了しませんでした\n`
                + `stdout: ${run.stdout.slice(-2000)}\nstderr: ${run.stderr.slice(-2000)}`);
        }
        return JSON.parse(match[1]
            .replaceAll("&quot;", "\"")
            .replaceAll("&amp;", "&")
            .replaceAll("&lt;", "<")
            .replaceAll("&gt;", ">"));
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

async function testAudioBackpressure() {
    const source = readFileSync(join(root, "offscreen.js"), "utf8");
    let listener = null;
    let synthesisRequests = 0;
    let createdUrls = 0;
    let revokedUrls = 0;
    const audioInstances = [];

    class MockAudio {
        constructor(url) {
            this.url = url;
            this.onended = null;
            this.onerror = null;
            audioInstances.push(this);
        }
        play() { return Promise.resolve(); }
        pause() {}
        removeAttribute() {}
        load() {}
    }

    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        Audio: MockAudio,
        URL: {
            createObjectURL() {
                createdUrls++;
                return `blob:test-${createdUrls}`;
            },
            revokeObjectURL() {
                revokedUrls++;
            }
        },
        chrome: {
            runtime: {
                id: "test-extension",
                onMessage: {
                    addListener(fn) { listener = fn; }
                },
                sendMessage() { return Promise.resolve(); }
            }
        },
        createOcrWorkerPool() {
            return {
                get() { return Promise.resolve(); },
                terminate() {}
            };
        },
        cropToOcrCanvas() {},
        recognizeWithOrientation() {},
        withOcrTimeout() {},
        cleanForSpeech(value) { return value; },
        normalizeOcrText(value) { return value; },
        OCR_RECOGNIZE_TIMEOUT_MS: 60000,
        OCR_WORKER_IDLE_RELEASE_MS: 300000,
        VOICEVOX_BASE_URL: "http://127.0.0.1:50021",
        VOICEVOX_FETCH_TIMEOUT_MS: 15000,
        VOICEVOX_SYNTHESIS_TIMEOUT_MS: 60000,
        async fetchWithTimeout(url) {
            if (url.includes("/audio_query")) {
                return {
                    ok: true,
                    async json() { return {}; }
                };
            }
            synthesisRequests++;
            return {
                ok: true,
                async blob() { return {}; }
            };
        }
    });
    vm.runInContext(source, context, { filename: "offscreen.js" });
    assert.equal(typeof listener, "function", "offscreen のメッセージリスナーが登録される");

    listener({
        target: "offscreen",
        type: "ENQUEUE_TEXTS",
        texts: Array.from({ length: 10 }, (_, i) => `文章${i}`),
        settings: {
            speakerId: 1,
            speedScale: 1,
            pitchScale: 0,
            intonationScale: 1,
            volumeScale: 1,
            pauseLengthScale: 1
        }
    }, { id: "test-extension" }, () => {});

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(synthesisRequests, 2, "再生中1件と先読み1件を超えて合成しない");
    assert.equal(audioInstances.length, 1, "先頭の音声だけを再生する");

    audioInstances[0].onended();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(synthesisRequests, 3, "再生待ちに空きができたら次の1件を合成する");
    assert.equal(audioInstances.length, 2, "次の音声へ途切れず進む");

    listener({ target: "offscreen", type: "STOP_AUDIO" },
        { id: "test-extension" }, () => {});
    assert.ok(revokedUrls >= 3, "停止時に再生中・待機中のBlob URLを解放する");
}

const chrome = findChrome();
const currentSource = readFileSync(join(root, "dom-text.js"), "utf8");
const current = runDomCase(chrome, currentSource, "current");
assert.equal(current.ok, true);
assert.equal(current.text, "精度確認用の文章一。\n精度確認用の文章二。");
assert.ok(current.pulseCount > 0, "長いDOM抽出中もブラウザへ処理を返す");
assert.ok(current.maxPulseGapMs < 250,
    `メインスレッドの連続占有が長すぎます: ${current.maxPulseGapMs.toFixed(1)}ms`);

if (baselineRef) {
    const baselineSource = execFileSync(
        "git", ["show", `${baselineRef}:dom-text.js`],
        { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
    );
    const baseline = runDomCase(chrome, baselineSource, "baseline");
    assert.equal(current.text, baseline.text, "変更前後で抽出テキストが一致する");
    assert.equal(current.chars, baseline.chars, "変更前後で抽出文字数が一致する");
    console.log(JSON.stringify({ baseline, current }, null, 2));
} else {
    console.log(JSON.stringify({ current }, null, 2));
}

await testAudioBackpressure();
console.log("reading performance tests: OK");
