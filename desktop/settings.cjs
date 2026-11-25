const fs = require("node:fs");
const path = require("node:path");

const defaults = { styleId: 3, speed: 1, volume: 1 };

function preferences(value) {
    if (!value || !Number.isSafeInteger(value.styleId) || value.styleId < 0 || value.styleId > 1000000 ||
        !Number.isFinite(value.speed) || value.speed < 0.5 || value.speed > 2 ||
        !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) return null;
    return { styleId: value.styleId, speed: value.speed, volume: value.volume };
}

function load(directory) {
    try {
        return preferences(JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"))) ?? defaults;
    } catch {
        return defaults;
    }
}

function save(directory, value) {
    const selected = preferences(value);
    if (!selected) return false;
    // Each instance replaces the whole settings file atomically.
    const temporary = path.join(directory, `settings.${process.pid}.tmp`);
    try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify(selected), "utf8");
        fs.renameSync(temporary, path.join(directory, "settings.json"));
        return true;
    } catch {
        return false;
    } finally {
        try { fs.rmSync(temporary, { force: true }); } catch { /* directory may be read-only */ }
    }
}

module.exports = { load, save };
