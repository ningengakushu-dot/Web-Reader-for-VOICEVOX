const { app, BrowserWindow, ipcMain, protocol, session, Menu } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const engine = require("./engine.cjs");
const settings = require("./settings.cjs");

const origin = "reader://app/";
const page = origin + "index.html";
const assets = {
    "index.html": "text/html; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "background-speech.js": "text/javascript",
    "renderer.mjs": "text/javascript",
    "player.mjs": "text/javascript"
};
protocol.registerSchemesAsPrivileged([{ scheme: "reader", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
app.setAppUserModelId("jp.voicevox-reader.local");

app.whenReady().then(async () => {
    // A non-persistent session keeps Chromium cache/form data out of the user profile.
    const local = session.fromPartition("reader-ui", { cache: false });
    local.setPermissionCheckHandler(() => false);
    local.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    local.protocol.handle("reader", async (request) => {
        const asset = request.url.slice(origin.length);
        if (request.method !== "GET" || !request.url.startsWith(origin) || !Object.hasOwn(assets, asset)) {
            return new Response(null, { status: 404 });
        }
        const dir = !app.isPackaged && asset === "background-speech.js" ? path.dirname(__dirname) : __dirname;
        return new Response(await fs.readFile(path.join(dir, asset)), {
            headers: { "Content-Type": assets[asset], "Cache-Control": "no-store" }
        });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{
        label: "表示(&V)",
        submenu: [
            { role: "zoomIn", label: "拡大" },
            { role: "zoomOut", label: "縮小" },
            { role: "resetZoom", label: "実際のサイズ" }
        ]
    }]));
    const win = new BrowserWindow({
        title: "VOICEVOX Local Reader", width: 900, height: 740, minWidth: 580, minHeight: 540,
        webPreferences: { session: local, preload: path.join(__dirname, "preload.cjs"),
            sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
    });
    const wc = win.webContents;
    wc.on("context-menu", (_event, { isEditable, editFlags }) => {
        if (!isEditable) return;
        // Native roles act on the focused editor. The app never reads clipboard contents.
        const menu = Menu.buildFromTemplate([
            { role: "undo", label: "元に戻す", enabled: editFlags.canUndo },
            { role: "redo", label: "やり直し", enabled: editFlags.canRedo },
            { type: "separator" },
            { role: "cut", label: "切り取り", enabled: editFlags.canCut },
            { role: "copy", label: "コピー", enabled: editFlags.canCopy },
            { role: "paste", label: "貼り付け", enabled: editFlags.canPaste },
            { type: "separator" },
            { role: "selectAll", label: "すべて選択", enabled: editFlags.canSelectAll }
        ]);
        menu.popup({ window: win });
    });
    const directory = app.getPath("userData");
    let audio, connection;
    const trusted = (event) => !wc.isDestroyed() && event.sender === wc &&
        event.senderFrame === wc.mainFrame && event.senderFrame.url === page;
    function cancelAll() {
        audio?.abort();
        connection?.abort();
    }
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("render-process-gone", cancelAll);
    wc.on("destroyed", cancelAll);
    win.on("closed", cancelAll);
    ipcMain.on("cancel", (event) => { if (trusted(event)) audio?.abort(); });
    ipcMain.handle("settings:get", (event) => trusted(event) ? settings.load(directory) : null);
    ipcMain.handle("settings:save", (event, value) => trusted(event) && settings.save(directory, value));
    async function result(fn) {
        try {
            return { ok: true, value: await fn() };
        } catch (error) {
            return { ok: false, error: ["offline", "invalid", "retryable"].includes(error.message) ? error.message : "synthesis" };
        }
    }
    ipcMain.handle("speakers", (event) => {
        if (!trusted(event)) return { ok: false, error: "invalid" };
        connection?.abort();
        connection = new AbortController();
        return result(() => engine.speakers(connection.signal));
    });
    ipcMain.handle("synthesize", (event, text, value) => {
        if (!trusted(event)) return { ok: false, error: "invalid" };
        audio?.abort();
        audio = new AbortController();
        return result(() => engine.synthesize(text, value, audio.signal));
    });
    await win.loadURL(page);
});
app.on("window-all-closed", () => app.quit());
