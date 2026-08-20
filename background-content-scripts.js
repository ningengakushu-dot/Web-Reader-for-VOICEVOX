// manifest と動的再注入で同じ Content Script 一式を使う。
// background-bootstrap.js の配列をここで置き換えることで、既存の互換バンドルを
// 読み上げ/OCRの回帰テスト用途に残しつつ、実際の Service Worker は manifest を正本にできる。
(() => {
    const files = chrome.runtime.getManifest?.().content_scripts?.[0]?.js;
    if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || !file)) {
        return;
    }
    CONTENT_SCRIPT_FILES.splice(0, CONTENT_SCRIPT_FILES.length, ...files);
})();
