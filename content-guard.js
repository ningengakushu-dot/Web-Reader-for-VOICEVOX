// Protect content scripts that remain in a tab after an extension update/reload.
// Only "Extension context invalidated" is suppressed; unrelated failures remain visible.
(() => {
    const isContextInvalidatedError = (error) =>
        /Extension context invalidated/i.test(String(error?.message || error || ""));

    const wrapMethod = (target, name, fallbackFactory) => {
        if (!target || typeof target[name] !== "function") return;
        const original = target[name].bind(target);
        const wrapped = (...args) => {
            const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
            const fallback = () => fallbackFactory();
            try {
                const result = original(...args);
                if (result && typeof result.then === "function") {
                    return result.catch((error) => {
                        if (isContextInvalidatedError(error)) return fallback();
                        throw error;
                    });
                }
                return result;
            } catch (error) {
                if (!isContextInvalidatedError(error)) throw error;
                if (callback) {
                    // Stale handlers must stop here. Calling their callback could continue a user
                    // action with fabricated settings even though the extension context is gone.
                    return undefined;
                }
                return Promise.resolve(fallback());
            }
        };
        try { target[name] = wrapped; } catch (_) { /* non-writable API */ }
    };

    try {
        wrapMethod(chrome?.storage?.local, "get", () => ({}));
        wrapMethod(chrome?.storage?.local, "set", () => undefined);
        wrapMethod(chrome?.storage?.local, "remove", () => undefined);
        wrapMethod(chrome?.runtime, "sendMessage", () => undefined);
    } catch (_) {
        // chrome itself is unavailable in a fully invalidated context.
    }

})();
