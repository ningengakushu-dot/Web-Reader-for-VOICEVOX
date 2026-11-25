"use strict";

const http = require("node:http");

const JSON_LIMIT = 4 * 1024 * 1024;
const WAV_LIMIT = 16 * 1024 * 1024;

function validStyleId(id) {
    return Number.isInteger(id) && id >= 0 && id <= 1000000;
}

// Never pass an engine URL or a response body to the renderer or an error log.
async function request(path, { method, body, limit, timeout, signal }) {
    const deadline = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: "127.0.0.1", port: 50021, path, method,
                agent: false, signal: combined,
                headers: body ? { "Content-Type": "application/json" } : undefined
            }, resolve);
            req.on("error", reject);
            req.end(body);
        });
        try {
            if (response.statusCode !== 200 || Number(response.headers["content-length"]) > limit) {
                throw new Error("synthesis");
            }
            const chunks = [];
            let length = 0;
            for await (const chunk of response) {
                length += chunk.length;
                if (length > limit) throw new Error("synthesis");
                chunks.push(chunk);
            }
            return Buffer.concat(chunks, length);
        } finally {
            response.destroy();
        }
    } catch (error) {
        if (!signal?.aborted && (deadline.aborted || ["ECONNREFUSED", "ECONNRESET", "EPIPE",
            "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(error.code))) {
            throw new Error("offline");
        }
        throw new Error("synthesis");
    }
}

function parseJson(bytes) {
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new Error("synthesis");
    }
}

function displayName(name) {
    return typeof name === "string" ? name.trim().slice(0, 100) : "";
}

async function speakers(signal) {
    const bytes = await request("/speakers", { method: "GET", limit: JSON_LIMIT, timeout: 15000, signal });
    const list = parseJson(bytes);
    if (!Array.isArray(list)) throw new Error("synthesis");
    const result = [];
    for (const item of list.slice(0, 1000)) {
        const name = displayName(item?.name);
        if (!name || !Array.isArray(item.styles)) continue;
        const styles = [];
        for (const style of item.styles.slice(0, 1000)) {
            const name = displayName(style?.name);
            // Engines predating style types return only talk styles from /speakers.
            if (name && validStyleId(style.id) && (style.type === undefined || style.type === "talk")) {
                styles.push({ name, id: style.id });
            }
        }
        if (styles.length) result.push({ name, styles });
    }
    if (!result.length) throw new Error("synthesis");
    return result;
}

async function synthesize(text, settings, signal) {
    const { styleId, speed, volume } = settings ?? {};
    if (typeof text !== "string" || text.length > 1200 || Array.from(text).length > 600 ||
        !/[\p{L}\p{N}]/u.test(text) || /[\p{Cc}\p{Cs}]/u.test(text) ||
        !validStyleId(styleId) || !Number.isFinite(speed) || speed < 0.5 || speed > 2 ||
        !Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw new Error("invalid");
    }
    const params = new URLSearchParams({ speaker: String(styleId), text });
    const query = parseJson(await request(`/audio_query?${params}`, {
        method: "POST", limit: JSON_LIMIT, timeout: 15000, signal
    }));
    if (!query || !Array.isArray(query.accent_phrases)) throw new Error("synthesis");
    query.speedScale = speed;
    query.volumeScale = volume;
    query.prePhonemeLength = query.postPhonemeLength = 0.1 * speed;
    let body;
    try {
        body = JSON.stringify(query);
    } catch {
        throw new Error("synthesis");
    }
    const wav = await request(`/synthesis?speaker=${styleId}`, {
        method: "POST", body, limit: WAV_LIMIT, timeout: 60000, signal
    });
    if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF" ||
        wav.toString("latin1", 8, 12) !== "WAVE") throw new Error("synthesis");
    return Uint8Array.from(wav);
}

module.exports = { speakers, synthesize };
