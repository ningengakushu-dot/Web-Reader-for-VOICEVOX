// 拡張機能の更新・再読み込み後もページ内に残る古い content script が、
// 無効化済みの chrome API を呼んで未処理例外を出すのを防ぐ。
// content.js より先に読み込み、ユーザー操作から呼ばれる API だけを安全化する。
(() => {
    const isContextInvalidatedError = (error) => {
        const message = String(error?.message || error || "");
        return /Extension context invalidated/i.test(message);
    };

    const wrapMethod = (target, name, fallbackValue) => {
        if (!target || typeof target[name] !== "function") return;
        const original = target[name].bind(target);
        const wrapped = (...args) => {
            try {
                const result = original(...args);
                if (result && typeof result.then === "function") {
                    return result.catch((error) => {
                        if (isContextInvalidatedError(error)) return fallbackValue;
                        throw error;
                    });
                }
                return result;
            } catch (error) {
                if (isContextInvalidatedError(error)) return fallbackValue;
                throw error;
            }
        };

        try {
            target[name] = wrapped;
        } catch (error) {
            // APIプロパティが書き換え不可の環境では、拡張機能本体の既存ガードに任せる。
        }
    };

    try {
        wrapMethod(chrome?.storage?.local, "get", Promise.resolve({}));
        wrapMethod(chrome?.storage?.local, "set", Promise.resolve());
        wrapMethod(chrome?.runtime, "sendMessage", Promise.resolve(undefined));
    } catch (error) {
        // chrome 自体へアクセスできないほどコンテキストが無効な場合は何もしない。
    }
})();
