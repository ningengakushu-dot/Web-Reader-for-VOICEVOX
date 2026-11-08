// 拡張機能ページから background へ送るメッセージの共通アダプター。
// Chrome の callback API と Promise を混在させず、更新直後の無効コンテキストも同じ形で扱う。
(() => {
    function isRuntimeAvailable() {
        try {
            return Boolean(chrome.runtime?.id);
        } catch (error) {
            return false;
        }
    }

    function send(message, callback) {
        if (!isRuntimeAvailable()) return false;
        try {
            chrome.runtime.sendMessage(message, callback);
            return true;
        } catch (error) {
            return false;
        }
    }

    function request(message) {
        return new Promise((resolve, reject) => {
            const sent = send(message, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    reject(new Error(lastError.message));
                    return;
                }
                resolve(response);
            });
            if (!sent) reject(new Error("拡張機能のコンテキストが無効です"));
        });
    }

    function requestOrNull(message) {
        return request(message).catch(() => null);
    }

    globalThis.VVRadioRuntimeMessaging = Object.freeze({
        isRuntimeAvailable,
        send,
        request,
        requestOrNull
    });
})();
