import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { name, productName, version, main } = require("./package.json");
if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows x64 と x64 版 Node.js でビルドしてください。");
}
const source = import.meta.dirname;
const runtime = path.dirname(require("electron"));
const output = path.join(source, "dist");
await fs.mkdir(output, { recursive: true });
const stage = await fs.mkdtemp(path.join(output, "package-"));
const folder = `VOICEVOX-Local-Reader-${version}-win-x64`;
const bundle = path.join(stage, folder);
try {
    await fs.cp(runtime, bundle, { recursive: true, filter: file => path.basename(file) !== "default_app.asar" });
    await fs.rename(path.join(bundle, "electron.exe"), path.join(bundle, "VOICEVOX-Local-Reader.exe"));
    await fs.rename(path.join(bundle, "electron_wer.dll"), path.join(bundle, "VOICEVOX-Local-Reader_wer.dll"));
    const app = path.join(bundle, "resources", "app");
    await fs.mkdir(app);
    for (const file of ["main.cjs", "preload.cjs", "settings.cjs", "engine.cjs",
        "player.mjs", "renderer.mjs", "style.css", "index.html"]) {
        await fs.copyFile(path.join(source, file), path.join(app, file));
    }
    await fs.copyFile(path.join(source, "..", "background-speech.js"), path.join(app, "background-speech.js"));
    await fs.copyFile(path.join(source, "..", "LICENSE"), path.join(bundle, "LICENSE-reader.txt"));
    await fs.copyFile(path.join(source, "README.md"), path.join(bundle, "README.md"));
    await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ name, productName, version, main }));
    const archive = folder + ".zip";
    execFileSync("tar.exe", ["-a", "-cf", path.join(stage, archive), "-C", stage, folder], { windowsHide: true });
    await fs.rename(path.join(stage, archive), path.join(output, archive));
    console.log(path.join(output, archive));
} finally {
    await fs.rm(stage, { recursive: true, force: true });
}
