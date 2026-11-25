"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { load, save } = require("../settings.cjs");

test("earlier settings survive an upgrade and only voice controls are persisted", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reader-settings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "settings.json");
    const old = { styleId: 8, speed: 1.25, volume: 0.7 };
    fs.writeFileSync(file, JSON.stringify(old));
    assert.deepEqual(load(directory), { ...old, pitch: 0, intonation: 1, pause: 1 });

    const selected = { ...old, volume: 2, pitch: -0.15, intonation: 0, pause: 2 };
    assert.equal(save(directory, { ...selected, text: "本文" }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), selected);
    for (const invalid of [{ pitch: null }, { intonation: NaN }, { pause: 2.01 }, { volume: -1 }]) {
        assert.equal(save(directory, { ...selected, ...invalid }), false);
    }
    assert.deepEqual(load(directory), selected);
});
