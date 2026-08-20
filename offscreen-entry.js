// Offscreen Document: 実際の音声再生と合成、およびページ内範囲選択OCRの文字認識を担当

let textQueue = [];
let audioQueue = [];
let isSynthesizing = false;
let isPlaying = false;
let currentAudio = null;
let currentAudioUrl = null;
// 再生中の音声とは別に、完成済み音声をどれだけ先読みするか（件数と合計秒数の両方で制限）。
// 全文を再生より速く合成すると、長文では Blob と VOICEVOX の処理負荷が読み上げ終了まで
// 増え続ける。一方で「次の1件だけ」では、短い文（見出し・箇条書きの1行）の直後に長い文が
// 来ると、その合成（音声長の約0.5〜0.7倍）が短い文の再生中に終わらず無音になる。
// 実測（音声1秒あたり合成0.5秒）では、再生済みの音声が数十秒分たまっていれば
// 1件の合成時間（最長で音声30〜60秒＝合成15〜40秒）を吸収できる。
// 24kHz/16bit の WAV は1分で約2.9MB なので、メモリは文章量に依存しない一定範囲に収まる。
const MAX_READY_AUDIO_QUEUE = 24;
const MAX_READY_AUDIO_SECONDS = 45;
// 合成の世代トークン。stopAll() で繰り上げることで、停止前に開始済みの
// 合成（in-flight）が完了しても、その結果を破棄して状態に反映させない。
let synthesisGeneration = 0;
// 再生の世代トークン。stopAll() 直後に古い audio.play() の reject が届いても無視する。
let playbackGeneration = 0;

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;
    // 拡張自身（background）からのメッセージに限る（多層防御）
    if (sender.id !== chrome.runtime.id) return;
    const security = globalThis.VVRadioOffscreenSecurity;
    if (security) {
        const checked = security.validate(message);
        if (!checked.ok) {
            sendResponse({ success: false, error: checked.error });
            return false;
        }
        message = checked.message;
    }

    switch (message.type) {
        case 'ENQUEUE_TEXTS':
            enqueueTexts(message.texts, message.settings);
            sendResponse({ success: true });
            break;
        case 'STOP_AUDIO':
            stopAll();
            sendResponse({ success: true });
            break;
        case 'PREWARM_OCR':
            // 範囲選択中の先読み。横書きは実測で圧倒的に多いので jpn だけ用意する
            // （縦書きが必要になった場合はそのとき生成される）。
            getOcrWorker("jpn").catch(() => {});
            // 範囲選択をやめた場合にワーカーが残り続けないよう、解放予約も入れておく
            // （実際にOCRが始まれば recognizeRegion 側で取り消される）。
            scheduleOcrWorkerIdleRelease();
            sendResponse({ success: true });
            break;
        case 'OCR_RECOGNIZE':
            // OCRは数秒かかるため応答チャネルは保持せず、完了時に
            // OCR_COMPLETE を background へ送るイベント駆動にする。
            // 共有ワーカーと進捗通知先（ocrProgressTabId）が競合しないよう直列化する。
            if (!enqueueOcrRecognition(message)) {
                sendResponse({ success: false, error: "文字認識の要求が混み合っています。少し待ってから再度お試しください。" });
            } else {
                sendResponse({ success: true });
            }
            break;
    }
    return false;
});
