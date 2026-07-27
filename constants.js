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

// VOICEVOXエンジンへの通信を諦めるまでの時間。
// エンジンが起動直後で応答しない・処理中に固まった場合、待ち続けると
// 合成キューが永久に詰まり、以降どの操作にも反応しなくなる。
// 長文の合成は時間がかかるため、合成だけ長めに取る。
const VOICEVOX_FETCH_TIMEOUT_MS = 15000;
const VOICEVOX_SYNTHESIS_TIMEOUT_MS = 60000;

// 設定のデフォルト値
const SETTING_DEFAULTS = {
    speakerId: 1,
    speedScale: 1.0,
    pitchScale: 0.0,
    intonationScale: 1.0,
    volumeScale: 1.0,
    pauseLengthScale: 1.0,
    iconSize: 16,
    // ページ内アイコンの見た目。dot=従来の半透明の円 / app=本拡張のアイコン /
    // character=読み上げキャラクター / custom=利用者がアップロードした画像
    iconStyle: "dot"
};

// ページ内アイコンに使う画像のデータURLを保存する storage.local のキー。
// 書き手はいずれも options.js、読み手は content.js。
// 画像は保存前に必ず canvas で ICON_IMAGE_MAX_PX に再エンコードするため、
// 元ファイル由来のスクリプトやメタデータは保存値に残らない。
const CHARACTER_ICON_STORAGE_KEY = "vv_character_icon";
const CUSTOM_ICON_STORAGE_KEY = "vv_custom_icon";

// キャラクターアイコンを「画像」で表示してよいキャラクター。
//
// VOICEVOX本体の規約はソフトウェアの一部の無断再配布を禁じているため画像は同梱せず、
// 利用者自身のPCで動いている VOICEVOX エンジンから起動時に取得する。
// そのうえで、キャラクター画像の権利は本体とは別にキャラクターごとの権利者が持ち、
// アプリ内表示を横断的に許諾する規約は存在しない。
// 「東北ずん子・ずんだもんプロジェクト」系はガイドラインでアプリ・Webページでの
// 利用が明示的に許可されているため、この範囲に限って画像を表示する。
// 一覧にないキャラクターは、権利上の確認が取れないためキャラクター名の文字表示に
// フォールバックする（機能は同じで、どのキャラかは判別できる）。
const ICON_IMAGE_ALLOWED_CHARACTERS = [
    "ずんだもん",
    "四国めたん",
    "九州そら",
    "中国うさぎ",
    "東北ずん子",
    "東北イタコ",
    "東北きりたん"
];

// アイコン画像の保存サイズ（一辺のピクセル数）。
// storage.local を圧迫させず、かつ最大表示サイズ64pxで粗く見えない値。
const ICON_IMAGE_MAX_PX = 128;

// 利用者がアップロードできるアイコン画像の制限。
// SVG はスクリプトを含み得るため受け付けない（ラスタ画像のみ）。
const CUSTOM_ICON_MAX_BYTES = 2 * 1024 * 1024;
const CUSTOM_ICON_ACCEPT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// OCRワーカーを使い終えてから破棄するまでの待ち時間。
// 学習データは言語ごとに約14MBあり、生成に数百ミリ秒かかる。連続した読み上げでは
// 作り直したくないが、放置したまま常駐させたくもないため中間の値を取る。
const OCR_WORKER_IDLE_RELEASE_MS = 5 * 60 * 1000;

// OCR関連の設定デフォルト値（音声合成設定とは別に管理）
const OCR_SETTING_DEFAULTS = {
    // OCR読み上げでルビ（ふりがな）を除去するか。既定はOFF（利用者が任意で有効化）。
    ocrRemoveRuby: false
};
