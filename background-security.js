// Background message boundary validation.
// Runs before background.js and wraps its onMessage listener without changing normal requests.
(() => {
    const MAX_TEXT_CHARS = 200000;
    const MAX_OCR_DATA_URL_CHARS = 64 * 1024 * 1024;

    const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
    const isTabSender = (sender) => Number.isInteger(sender?.tab?.id);
    const isExtensionPage = (sender, page) => {
        const expected = chrome.runtime.getURL(page);
        return sender?.url === expected
            || sender?.url?.startsWith(`${expected}?`)
            || sender?.url?.startsWith(`${expected}#`);
    };
    const isInternalSender = (sender) => sender?.id === chrome.runtime.id;

    function invalidResponse(type, message) {
        if (type === "CLAIM_UPDATE_NOTICE") return { shouldShow: false };
        return { success: false, error: message };
    }

    function validateRect(request) {
        const rect = request?.rect;
        if (!rect || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y)
            || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)
            || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
            || rect.width > 100000 || rect.height > 100000
            || rect.width * rect.height > 100000000
            || !isFiniteNumber(request.viewportWidth) || request.viewportWidth < 1
            || request.viewportWidth > 100000) {
            return false;
        }
        return true;
    }

    function validateRequest(request, sender) {
        if (!request || typeof request !== "object" || typeof request.type !== "string") {
            return { ok: false, error: "不正なメッセージです" };
        }
        if (!isInternalSender(sender)) {
            return { ok: false, error: "許可されていない送信元です" };
        }

        if (request.target === "background") {
            if (sender.url !== chrome.runtime.getURL("offscreen.html")) {
                return { ok: false, error: "許可されていない通知元です" };
            }
            const offscreenTypes = new Set([
                "OCR_PROGRESS", "OCR_COMPLETE", "PLAYBACK_STARTED", "PLAYBACK_ENDED",
                "PLAYBACK_ERROR", "PLAYBACK_STOPPED"
            ]);
            if (!offscreenTypes.has(request.type)) {
                return { ok: false, error: "不明な通知です" };
            }
            if (request.tabId != null && (!Number.isInteger(request.tabId) || request.tabId < 0)) {
                return { ok: false, error: "tabId が不正です" };
            }
            if (request.type === "OCR_PROGRESS"
                && (!isFiniteNumber(request.progress) || request.progress < 0 || request.progress > 1)) {
                return { ok: false, error: "進捗値が不正です" };
            }
            if (["OCR_PROGRESS", "OCR_COMPLETE"].includes(request.type)
                && (!Number.isInteger(request.tabId) || request.tabId < 0)) {
                return { ok: false, error: "tabId が不正です" };
            }
            if (request.type === "OCR_COMPLETE") {
                if (request.text != null && typeof request.text !== "string") {
                    return { ok: false, error: "認識結果が不正です" };
                }
                if (request.error != null && typeof request.error !== "string") {
                    return { ok: false, error: "エラー情報が不正です" };
                }
                if (!request.error && !request.text) {
                    return { ok: false, error: "認識結果が不正です" };
                }
                if (typeof request.text === "string" && request.text.length > MAX_TEXT_CHARS) {
                    return { ok: false, error: "認識結果が大きすぎます" };
                }
                if (typeof request.error === "string" && request.error.length > 2000) {
                    return { ok: false, error: "エラー情報が大きすぎます" };
                }
            }
            if (request.type === "PLAYBACK_ERROR"
                && (typeof request.error !== "string" || request.error.length > 2000)) {
                return { ok: false, error: "再生エラー情報が不正です" };
            }
            return { ok: true, request };
        }

        const allowed = new Set([
            "CLAIM_UPDATE_NOTICE", "SHORTCUT_PRESSED", "OPEN_OPTIONS", "CHECK_CONNECTION",
            "GET_SPEAKERS", "GET_SPEAKER_ICON", "GENERATE_VOICE", "STOP_ALL",
            "CAPTURE_OCR_REGION"
        ]);
        if (!allowed.has(request.type)) return { ok: false, error: "不明な要求です" };

        if (["CLAIM_UPDATE_NOTICE", "SHORTCUT_PRESSED", "CAPTURE_OCR_REGION"].includes(request.type)
            && !isTabSender(sender)) {
            return { ok: false, error: "要求元タブを確認できません" };
        }
        if (["GET_SPEAKERS", "GET_SPEAKER_ICON"].includes(request.type)
            && !isExtensionPage(sender, "options.html")) {
            return { ok: false, error: "設定画面以外からは実行できません" };
        }
        if (["GENERATE_VOICE", "STOP_ALL"].includes(request.type)
            && !isTabSender(sender) && !isExtensionPage(sender, "capture.html")) {
            return { ok: false, error: "許可されていない画面からの要求です" };
        }
        if (request.type === "GENERATE_VOICE") {
            if (typeof request.text !== "string" || !request.text.trim()) {
                return { ok: false, error: "読み上げテキストがありません" };
            }
            if (request.text.length > MAX_TEXT_CHARS) {
                return { ok: false, error: "読み上げテキストが長すぎます" };
            }
        }
        if (request.type === "GET_SPEAKER_ICON"
            && (!Number.isInteger(Number(request.speakerId)) || Number(request.speakerId) < 0
                || Number(request.speakerId) > 1000000)) {
            return { ok: false, error: "speakerId が不正です" };
        }
        if (request.type === "CAPTURE_OCR_REGION") {
            if (sender.frameId !== undefined && sender.frameId !== 0) {
                return { ok: false, error: "トップフレーム以外からは実行できません" };
            }
            if (!validateRect(request)) return { ok: false, error: "選択範囲が不正です" };
        }
        if (typeof request.dataUrl === "string" && request.dataUrl.length > MAX_OCR_DATA_URL_CHARS) {
            return { ok: false, error: "画像データが大きすぎます" };
        }
        return { ok: true, request };
    }

    globalThis.VVRadioBackgroundSecurity = Object.freeze({
        validateRequest,
        invalidResponse
    });
})();
