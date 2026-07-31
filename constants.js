// 共通の定数とユーティリティ。
// Service Worker（background.js の importScripts）と拡張機能ページ
// （offscreen.html / capture.html / options.html の script タグ）の両方から読み込む。

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

/**
 * 制限時間つきの fetch。時間内に応答が無ければ中断して例外にする。
 * VOICEVOXエンジンが落ちている・固まっている場合に、接続確認やキャラクター一覧の
 * 取得が終わらないまま固まったり、合成キューが永久に詰まったりするのを防ぐ。
 * background（Service Worker）と offscreen の双方で使う。
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err.name === "AbortError") {
            throw new Error(`VOICEVOXエンジンが応答しません（${Math.round(timeoutMs / 1000)}秒）`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ローカルサーバーを別プロセスが占有している場合でも、巨大応答で拡張機能の
// メモリを使い切らないよう、VOICEVOX応答を読み込むサイズに上限を設ける。
const VOICEVOX_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const VOICEVOX_AUDIO_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;

async function readResponseBytesWithLimit(response, maxBytes, timeoutMs = VOICEVOX_FETCH_TIMEOUT_MS) {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error("VOICEVOXエンジンの応答が大きすぎます");
    }

    const timeoutError = () => new Error(
        `VOICEVOXエンジンの応答受信が完了しません（${Math.round(timeoutMs / 1000)}秒）`);
    const withDeadline = (promise, remainingMs, onTimeout) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { onTimeout?.(); } catch (error) { /* タイムアウトを優先 */ }
            reject(timeoutError());
        }, Math.max(1, remainingMs));
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
    const deadline = Date.now() + timeoutMs;

    if (!response.body?.getReader) {
        const bytes = new Uint8Array(await withDeadline(
            response.arrayBuffer(), timeoutMs, () => {
                const cancellation = response.body?.cancel?.();
                cancellation?.catch?.(() => {});
            }));
        if (bytes.byteLength > maxBytes) throw new Error("VOICEVOXエンジンの応答が大きすぎます");
        return bytes;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                try { await reader.cancel(); } catch (error) { /* タイムアウトを優先 */ }
                throw timeoutError();
            }
            const { done, value } = await withDeadline(
                reader.read(), remaining, () => { void reader.cancel().catch(() => {}); });
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                try { await reader.cancel(); } catch (error) { /* サイズ超過を優先 */ }
                throw new Error("VOICEVOXエンジンの応答が大きすぎます");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock?.();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

async function readJsonResponseWithLimit(
    response,
    maxBytes = VOICEVOX_JSON_RESPONSE_MAX_BYTES,
    timeoutMs = VOICEVOX_FETCH_TIMEOUT_MS
) {
    const bytes = await readResponseBytesWithLimit(response, maxBytes, timeoutMs);
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function readBlobResponseWithLimit(
    response,
    maxBytes = VOICEVOX_AUDIO_RESPONSE_MAX_BYTES,
    timeoutMs = VOICEVOX_SYNTHESIS_TIMEOUT_MS
) {
    const bytes = await readResponseBytesWithLimit(response, maxBytes, timeoutMs);
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    if (bytes.byteLength < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE") {
        throw new Error("VOICEVOXエンジンから不正な音声データが返されました");
    }
    return new Blob([bytes], { type: "audio/wav" });
}

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
// storage.local を圧迫させず、かつ最大表示サイズ128pxで粗く見えない値。
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
