// 共通定数定義

// VOICEVOXエンジンのベースURL（ローカルサーバー）
const VOICEVOX_BASE_URL = "http://127.0.0.1:50021";

// 画面OCR読み上げ: キャプチャ画像を background → capture.html へ受け渡す
// storage.session の固定キー（書き手: background.js / 読み手: capture.js）。
// 固定キーへの上書き保存により、保持は常に最新の1件のみになる。
const CAPTURE_STORAGE_KEY = "vv_ocr_capture";

// 再生状態通知（PLAYBACK_*）の宛先タブIDを storage.session に退避するキー。
// Service Worker はメモリ上のグローバル変数を休止で失うため、宛先タブIDを
// session に控え、休止から復帰した SW でも再生終了通知を正しいタブへ転送できるようにする。
const PLAYBACK_TAB_STORAGE_KEY = "vv_playback_tab_id";

// 設定のデフォルト値
const SETTING_DEFAULTS = {
    speakerId: 1,
    speedScale: 1.0,
    pitchScale: 0.0,
    intonationScale: 1.0,
    volumeScale: 1.0,
    pauseLengthScale: 1.0,
    iconSize: 16
};

// OCRワーカーを使い終えてから破棄するまでの待ち時間。
// 学習データは言語ごとに約14MBあり、生成に数百ミリ秒かかる。連続した読み上げでは
// 作り直したくないが、放置したまま常駐させたくもないため中間の値を取る。
const OCR_WORKER_IDLE_RELEASE_MS = 5 * 60 * 1000;

// OCR関連の設定デフォルト値（音声合成設定とは別に管理）
const OCR_SETTING_DEFAULTS = {
    // OCR読み上げでルビ（ふりがな）を除去するか。既定はOFF（利用者が任意で有効化）。
    ocrRemoveRuby: false
};
