// Content Script の責務別モジュールが共有する定数・UIホスト生成と、
// 生存中インスタンスへの再注入を早期終了させるための軽量ガード。
(() => {
    const existing = window.__vvRadioReaderInstance;
    let reuseExisting = false;
    if (existing) {
        try {
            reuseExisting = existing.isAlive();
        } catch (e) {
            // 拡張更新後など、古いコンテキストは stale として作り直す。
        }
    }

    const content = globalThis.VVRadioContent || (globalThis.VVRadioContent = {});
    content.reuseExisting = reuseExisting;
    if (reuseExisting) return;

    // stale インスタンスの時は、古い版の部品を混在させない。
    content.parts = Object.create(null);
    content.OCR_STALL_TIMEOUT_MS = 90000;
    content.INDICATOR_DEFAULT_TITLE = "Web Reader for VOICEVOX（左クリック: 読み上げ開始/停止、右クリック: 画面OCR読み上げ）";

    // 自前UI（インジケーター・OCRオーバーレイ・更新案内）の Shadow DOM ホストを作る。
    // ホスト要素を通常フローに参加させず、ページ側のレイアウトや継承スタイルへ影響させない。
    content.createVvRadioUiHost = (id) => {
        const host = document.createElement("div");
        host.id = id;
        host.style.cssText = "all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0;";
        return host;
    };
})();
