(() => {
    "use strict";

    // Browser版Tesseract.jsではcachePathがIndexedDBのキャッシュキーになる。
    // 同梱traineddataを更新したときに旧キャッシュを再利用しないよう、このキーを
    // traineddataの互換性世代として固定する。モデルを差し替えた場合は世代を上げる。
    const TESSERACT_TRAINEDDATA_CACHE_PATH = "web-reader-for-voicevox/tessdata-config-v1";
    const originalCreateWorker = Tesseract.createWorker;

    Tesseract.createWorker = function createWorkerWithVersionedTessdataCache(langs, oem, options, config) {
        return originalCreateWorker.call(Tesseract, langs, oem, {
            ...(options || {}),
            cachePath: TESSERACT_TRAINEDDATA_CACHE_PATH
        }, config);
    };
})();
