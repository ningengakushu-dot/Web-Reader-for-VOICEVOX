const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("reader", {
    speakers: () => ipcRenderer.invoke("speakers"),
    synthesize: (text, settings) => ipcRenderer.invoke("synthesize", text, settings),
    cancel: () => ipcRenderer.send("cancel"),
    getSettings: () => ipcRenderer.invoke("settings:get"),
    saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings)
});
