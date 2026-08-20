// 再実行（manifest の自動注入と background のフォールバック注入の競合等）による
// 二重生成を防ぐ。責務別モジュールは副作用を持たず、実インスタンス生成はここだけで行う。
(() => {
    const existing = window.__vvRadioReaderInstance;
    if (existing) {
        try {
            if (existing.isAlive()) return;
        } catch (e) {
            // 生存確認自体が例外（拡張コンテキスト無効化など）→ stale とみなし再生成
        }
        try {
            existing.deactivate();
        } catch (e) {
            // 停止処理の失敗は無視して再生成を続行
        }
    }

    const content = globalThis.VVRadioContent;
    const parts = content?.parts;
    if (!parts?.indicator || !parts?.reading || !parts?.notice || !parts?.ocr) {
        throw new Error("Web Reader for VOICEVOX: content modules are not loaded in the required order");
    }

class VVRadioReader {
    constructor() {
        this.active = true;
        this.isPlaying = false;
        this.indicator = null;
        // OCRの進捗途絶を検知する見張りタイマー（armOcrStallWatchdog で設定）
        this.ocrStallWatchdog = null;
        // エラートースト等の自動消去タイマー（scheduleOcrToastDismiss で設定）
        this.ocrToastDismissTimer = null;
        // 登録したリスナー（deactivate でまとめて解除する）
        this.storageListeners = [];
        this.keyboardShortcutListener = null;
        this.messageListener = null;
        this.pageShowListener = null;
        // OCR範囲選択オーバーレイへフォーカスを移す前にフォーカスを持っていた要素
        this.ocrPrevFocus = null;
        // 非同期のDOM抽出結果が、後から開始した範囲選択を上書きしないための世代番号。
        this.regionReadGeneration = 0;
        // DOM抽出が重なってもインジケーターの visibility を正しく復元するための参照数。
        this.regionExtractionCount = 0;
        this.regionExtractionPrevVisibility = "";
        // クロスオリジンの frame プロパティにアクセスせず、window.self/window.top の
        // 比較のみで安全にトップフレーム判定を行う
        this.isTopFrame = window.self === window.top;
        this.init();
    }

    init() {
        // インジケーター注入・アイコンサイズ適用・接続確認・オプションUIはトップフレームのみ。
        // サブフレームはメッセージリスナーのみ登録し、TOGGLE_READING で選択テキストを読む。
        if (this.isTopFrame) {
            this.injectIndicator();
            this.applyIconAppearance();
            this.checkVoicevoxConnection();
            this.checkUpdateNotice();
        }
        this.setupMessageListener();
        this.setupKeyboardShortcutFallback();
        this.setupPageShowReset();
    }

    // 読み上げ中にページを離れると background が再生を止めるが、離れたページには
    // 通知されない。bfcache から「戻る」で復帰すると「読み上げ中」の表示と
    // isPlaying がそのまま蘇り、最初のクリックが停止扱いで空振りするため、
    // 復帰時に待機状態へ戻す（実際の再生は遷移時に必ず止まっている）。
    setupPageShowReset() {
        this.pageShowListener = (event) => {
            if (!this.active || !event.persisted) return;
            this.isPlaying = false;
            this.updateUIState('idle');
            this.removeOcrToast();
        };
        window.addEventListener("pageshow", this.pageShowListener);
    }

    // storage の変更リスナーを登録し、deactivate で確実に解除できるよう控えておく。
    // active フラグだけに頼ると、拡張のリロードと再注入を繰り返した同一ページに
    // 動かないリスナーが積み上がる。
    addStorageListener(fn) {
        chrome.storage.onChanged.addListener(fn);
        this.storageListeners.push(fn);
    }

    // このインスタンスがまだ機能しているか（＝再注入をスキップしてよいか）を返す。
    // deactivate 済み、または拡張コンテキスト無効化で chrome.runtime.id が
    // 失われている場合は false（呼び出し側で例外になる場合もある）。
    isAlive() {
        if (!this.active) return false;
        if (!chrome.runtime || !chrome.runtime.id) return false;
        return true;
    }

    // このインスタンスを停止し、注入済みの UI を除去する。
    // 以降のメッセージは active=false により無視される。
    deactivate() {
        this.active = false;
        this.regionReadGeneration++;
        for (const fn of this.storageListeners || []) {
            try { chrome.storage.onChanged.removeListener(fn); } catch (e) { /* 無効化済み */ }
        }
        this.storageListeners = [];
        if (this.keyboardShortcutListener) {
            document.removeEventListener("keydown", this.keyboardShortcutListener, true);
            this.keyboardShortcutListener = null;
        }
        if (this.messageListener) {
            try { chrome.runtime.onMessage.removeListener(this.messageListener); } catch (e) { /* 無効化済み */ }
            this.messageListener = null;
        }
        if (this.pageShowListener) {
            window.removeEventListener("pageshow", this.pageShowListener);
            this.pageShowListener = null;
        }
        this.clearOcrToastDismiss();
        // OCR選択オーバーレイの window リスナーと、OCRトースト/進捗ガードタイマーも解放する。
        // host を消すだけでは window に張った mousemove/mouseup/keydown と setTimeout が
        // 取り残され、detached ノードを参照し続けてリークする（OCR選択中の再注入で発生）。
        this.removeOcrOverlay();
        this.removeOcrToast();
        const host = document.getElementById("vvradio-host");
        if (host) host.remove();
        // this.ocrOverlay が未設定の段階で残った stale な OCR ホストも念のため除去する。
        const ocrHost = document.getElementById("vvradio-ocr-host");
        if (ocrHost) ocrHost.remove();
        const noticeHost = document.getElementById("vvradio-update-notice-host");
        if (noticeHost) noticeHost.remove();
    }
}

    Object.assign(
        VVRadioReader.prototype,
        parts.indicator,
        parts.reading,
        parts.notice,
        parts.ocr
    );

    window.__vvRadioReaderInstance = new VVRadioReader();
})();
