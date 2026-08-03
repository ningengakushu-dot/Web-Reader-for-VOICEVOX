// Validate and normalize messages before offscreen.js handles expensive audio/OCR work.
(() => {
    const MAX_TEXT_CHARS = 200000;
    const MAX_TEXT_ITEMS = 5000;
    const MAX_IMAGE_DATA_URL_CHARS = 12 * 1024 * 1024;
    const defaults = {
        speakerId: 1, speedScale: 1, pitchScale: 0, intonationScale: 1,
        volumeScale: 1, pauseLengthScale: 1
    };
    const ranges = {
        speedScale: [0.5, 2], pitchScale: [-0.15, 0.15], intonationScale: [0, 2],
        volumeScale: [0, 2], pauseLengthScale: [0, 2]
    };
    const finite = (v) => typeof v === "number" && Number.isFinite(v);
    const clamp = (v, min, max, fallback) => finite(v) ? Math.min(max, Math.max(min, v)) : fallback;

    function sanitizeSettings(value) {
        const source = value && typeof value === "object" ? value : {};
        const speakerId = Number(source.speakerId);
        const result = {};
        result.speakerId = Number.isInteger(speakerId) && speakerId >= 0 && speakerId <= 1000000
            ? speakerId : defaults.speakerId;
        for (const [key, [min, max]] of Object.entries(ranges)) {
            result[key] = clamp(Number(source[key]), min, max, defaults[key]);
        }
        return result;
    }

    function validate(message) {
        if (!message || typeof message.type !== "string") {
            return { ok: false, error: "不正なメッセージです" };
        }
        if (message.type === "ENQUEUE_TEXTS") {
            if (!Array.isArray(message.texts) || message.texts.length === 0
                || message.texts.length > MAX_TEXT_ITEMS) {
                return { ok: false, error: "読み上げキューが不正です" };
            }
            const texts = message.texts.filter((v) => typeof v === "string" && v.trim());
            const total = texts.reduce((sum, v) => sum + v.length, 0);
            if (texts.length === 0 || total > MAX_TEXT_CHARS) {
                return { ok: false, error: "読み上げテキストが大きすぎます" };
            }
            return { ok: true, message: {
                type: "ENQUEUE_TEXTS",
                target: "offscreen",
                texts,
                settings: sanitizeSettings(message.settings)
            } };
        }
        if (message.type === "OCR_RECOGNIZE") {
            const r = message.rect;
            const imageOk = typeof message.dataUrl === "string"
                && /^data:image\/(?:png|jpeg);base64,/i.test(message.dataUrl)
                && message.dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS;
            const rectOk = r && [r.x, r.y, r.width, r.height].every(finite)
                && r.x >= 0 && r.y >= 0 && r.width >= 1 && r.height >= 1
                && r.width <= 100000 && r.height <= 100000
                && r.width * r.height <= 100000000;
            if (!imageOk || !rectOk || !finite(message.viewportWidth)
                || message.viewportWidth < 1 || message.viewportWidth > 100000
                || !Number.isInteger(message.tabId) || message.tabId < 0) {
                return { ok: false, error: "OCR要求が不正です" };
            }
            return { ok: true, message: {
                type: "OCR_RECOGNIZE",
                target: "offscreen",
                dataUrl: message.dataUrl,
                rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                viewportWidth: message.viewportWidth,
                tabId: message.tabId
            } };
        }
        if (message.type === "STOP_AUDIO" || message.type === "PREWARM_OCR") {
            return { ok: true, message };
        }
        return { ok: false, error: "不明な要求です" };
    }

    globalThis.VVRadioOffscreenSecurity = Object.freeze({ validate });
})();
