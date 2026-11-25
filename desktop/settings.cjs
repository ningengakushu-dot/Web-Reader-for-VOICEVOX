const fs = require("node:fs");
const path = require("node:path");

const defaults = { styleId: 3, speed: 1, volume: 1, pitch: 0, intonation: 1, pause: 1 };

function inRange(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max;
}

function preferences(value) {
    if (!value) return null;
    // Earlier desktop profiles contain just styleId, speed and volume.
    const { styleId, speed, volume, pitch = defaults.pitch, intonation = defaults.intonation, pause = defaults.pause } = value;
    if (!Number.isSafeInteger(styleId) || !inRange(styleId, 0, 1000000) ||
        !inRange(speed, 0.5, 2) || !inRange(volume, 0, 2) ||
        !inRange(pitch, -0.15, 0.15) || !inRange(intonation, 0, 2) || !inRange(pause, 0, 2)) return null;
    return { styleId, speed, volume, pitch, intonation, pause };
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

module.exports = { load, save, preferences };
