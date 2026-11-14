// 選択テキスト、ショートカット、Runtime Messaging、音声要求を担当する。
(() => {
    const content = globalThis.VVRadioContent;
    if (!content || content.reuseExisting) return;

content.parts.reading = {
    // 選択中のテキストを取得する
    // input/textarea 内の選択（window.getSelection() では取得できない）にも対応する
    getSelectedText() {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
            // Password fields must never be read or sent to the local speech engine.
            if (active.tagName === "INPUT" && String(active.type).toLowerCase() === "password") return "";
            try {
                const { selectionStart, selectionEnd, value } = active;
                // type=number/email など selection 非対応の input では selectionStart が null になる
                if (selectionStart != null && selectionEnd != null && selectionEnd > selectionStart) {
                    return value.substring(selectionStart, selectionEnd).trim();
                }
            } catch (e) {
                // selection 非対応の input でのアクセス例外は無視し、通常の選択取得にフォールバック
            }
        }
        return window.getSelection().toString().trim();
    },

    setupKeyboardShortcutFallback() {
        this.keyboardShortcutListener = (event) => {
            if (!this.active || event.repeat || !event.isTrusted) return;
            if (!this.isShortcutEvent(event)) return;
            if (!this.shouldHandleToggleReading()) return;

            // Chrome commands が未割当/競合していて background に届かない場合の保険。
            // content 側では実行せず background に集約し、commands 経路との二重処理を防ぐ。
            event.preventDefault();
            event.stopPropagation();

            try {
                if (!chrome.runtime?.id) return;
                chrome.runtime.sendMessage({ type: "SHORTCUT_PRESSED" }, () => { void chrome.runtime.lastError; });
            } catch (error) {
                // 更新・再読み込み直後の古いcontent scriptでは何もしない。
            }
        };
        document.addEventListener("keydown", this.keyboardShortcutListener, true);
    },

    isShortcutEvent(event) {
        const key = (event.key || "").toLowerCase();
        return event.altKey
            && event.shiftKey
            && !event.ctrlKey
            && !event.metaKey
            && (event.code === "KeyU" || key === "u");
    },

    requestToggleReading() {
        if (!this.active) return;
        const revision = this.playbackRevision;
        try {
            if (!chrome.runtime?.id) return;
            // 親ページから子フレームの選択を直接読むと同一オリジン制約に阻まれる。
            // background 経由で配信し、選択を持つフレーム自身に取得させる。
            chrome.runtime.sendMessage({ type: "TOGGLE_READING_REQUEST" }, (response) => {
                const error = chrome.runtime.lastError?.message || response?.error;
                if (error && this.active && this.playbackRevision === revision) {
                    this.updateUIState('error');
                    this.showPlaybackErrorToast(error);
                }
            });
        } catch (error) {
            // 更新・再読み込み直後の古いcontent scriptでは何もしない。
        }
    },

    toggleReading() {

        const text = this.getSelectedText();
        if (text) {
            this.speakText(text);
        } else {
            // 何も選ばずに実行したとき、従来はアイコンの色が3秒変わるだけだった。
            // ショートカット（Alt+Shift+U）ではアイコンを見ていないので「押しても何も
            // 起きない」ように見える。記号だけを選んだ場合は背景から
            // 「読み上げられる文字がありません」が返ってトーストが出るので、案内の有無をそろえる。
            this.updateUIState('error');
            if (this.isTopFrame) {
                this.showOcrToast("読み上げるテキストを選択してください。");
                this.scheduleOcrToastDismiss(4000);
            } else {
                // インジケーターと案内UIはトップフレームだけが持つ。
                try {
                    chrome.runtime.sendMessage({ type: "SELECTION_REQUIRED" }, () => { void chrome.runtime.lastError; });
                } catch (error) { /* 更新直後の無効コンテキスト */ }
            }
        }
    },

    // TOGGLE_READING を自フレームで処理すべきか判定する。
    // アイコン・ショートカットは全フレームに配信されるため、フォーカスを持たないフレームや、
    // フォーカスが子フレーム（IFRAME/FRAME）にあるフレームでは処理せず、
    // 実際にフォーカスを持つフレームだけが読み上げを担当することで二重読み上げを防ぐ。
    shouldHandleToggleReading() {
        if (!document.hasFocus()) return false;
        // Shadow DOM 内の iframe にフォーカスがある場合、document.activeElement は
        // ホスト要素を返す（retargeting）ため、shadow root をたどって実際の要素を見る。
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        if (active && (active.tagName === "IFRAME" || active.tagName === "FRAME")) {
            return false;
        }
        return true;
    },

    // バックグラウンド等からのメッセージのリスナーを設定
    setupMessageListener() {
        this.messageListener = (request, sender, sendResponse) => {
            // 停止済み（stale）インスタンスのリスナーは何もしない
            if (!this.active) return;
            switch (request.type) {
                case "READ_SELECTED_TEXT":
                    if (request.text) this.speakText(request.text);
                    break;
                case "START_OCR_SELECTION":
                    // ページ内OCR範囲選択はトップフレームのみが担当する
                    // （background も frameId: 0 を指定して送ってくる）
                    if (!this.isTopFrame) break;
                    this.startOcrSelection();
                    // 応答を返さないと送信側が「応答チャネルが閉じた」で失敗扱いになる。
                    // background 側はこれをフォールバック判断に使わないが、
                    // 無用な失敗ログを出さないためここで明示的に応答する。
                    sendResponse({ success: true });
                    break;
                case "OCR_PROGRESS":
                    // トーストと見張りタイマーはトップフレームだけが持つ（全フレームへ
                    // 配信されるため、サブフレームで無駄なタイマーを張り直さない）
                    if (!this.isTopFrame) break;
                    this.updateOcrToast(`文字認識中... ${Math.round((request.progress || 0) * 100)}%`);
                    this.armOcrStallWatchdog();
                    break;
                case "OCR_STATUS":
                    if (!this.isTopFrame) break;
                    this.handleOcrStatus(request);
                    break;
                case "TOGGLE_READING":
                    // フォーカスを持つフレームのみが処理（全フレーム配信による二重読み上げ防止）
                    if (!this.shouldHandleToggleReading()) break;
                    this.toggleReading();
                    break;
                case "SELECTION_REQUIRED":
                    if (!this.isTopFrame) break;
                    this.updateUIState('error');
                    this.showOcrToast("読み上げるテキストを選択してください。");
                    this.scheduleOcrToastDismiss(4000);
                    break;
                case "SELECTION_READING_ERROR":
                    if (!this.isTopFrame) break;
                    this.updateUIState('error');
                    this.showPlaybackErrorToast(request.error);
                    break;
                case "PLAYBACK_PREPARING":
                case "PLAYBACK_STARTED":
                case "PLAYBACK_STOPPING":
                case "PLAYBACK_ENDED":
                case "PLAYBACK_STOPPED":
                case "PLAYBACK_START_FAILED":
                case "PLAYBACK_STOP_FAILED":
                case "PLAYBACK_ERROR":
                    if (this.isTopFrame) this.applyPlaybackEvent(request);
                    break;
            }
        };
        chrome.runtime.onMessage.addListener(this.messageListener);
    },

    applyPlaybackEvent(request) {
        if (request.type === "PLAYBACK_PREPARING") {
            this.playbackRequestId = request.requestId;
        } else if (this.playbackRequestId != null && request.requestId !== this.playbackRequestId) {
            return;
        }
        this.playbackRevision++;
        this.isPreparingPlayback = request.type === "PLAYBACK_PREPARING";
        this.isPlaying = request.type === "PLAYBACK_STARTED";
        switch (request.type) {
            case "PLAYBACK_PREPARING":
                this.removeOcrToast();
                this.updateUIState('preparing');
                break;
            case "PLAYBACK_STARTED":
                this.updateUIState('reading');
                break;
            case "PLAYBACK_STOPPING":
                this.removeOcrToast();
                this.updateUIState('stopping');
                break;
            case "PLAYBACK_ENDED":
            case "PLAYBACK_STOPPED":
                this.updateUIState('idle');
                break;
            case "PLAYBACK_STOP_FAILED":
                this.updateUIState('error');
                this.showOcrToast(`停止できませんでした: ${request.error} アイコンで再試行できます。`);
                this.scheduleOcrToastDismiss(6000);
                break;
            case "PLAYBACK_START_FAILED":
            case "PLAYBACK_ERROR":
                this.updateUIState('error');
                this.showPlaybackErrorToast(request.error);
                break;
        }
    },

    // バックグラウンド経由でVOICEVOXエンジンの接続確認。
    // VOICEVOX未起動は利用前には起こり得る通常状態なので、拡張機能の警告ログには残さず
    // インジケーターだけで接続できていないことを知らせる。
    checkVoicevoxConnection() {
        const revision = this.playbackRevision;
        try {
            chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" }, (res) => {
                if (!this.active) return;
                // 拡張機能の更新・再読み込み直後に古いcontent scriptから返るlastErrorも
                // 初期接続確認では想定内。コールバック内で参照して未処理エラー化を防ぐ。
                if (chrome.runtime.lastError) return;
                if ((!res || !res.success) && this.playbackRevision === revision) this.updateUIState('error');
            });
        } catch (error) {
            // 拡張機能の更新・再読み込み直後は接続確認を打ち切る。
        }
    },

    // 音声再生リクエスト
    speakText(text) {
        if (!text) return;

        const cleanText = this.cleanMessage(text);
        if (!cleanText) return;

        const revision = this.playbackRevision;
        try {
            chrome.runtime.sendMessage({
                type: "GENERATE_VOICE",
                text: cleanText
            }, (response) => {
                const lastError = chrome.runtime.lastError;
                if (!this.active || this.playbackRevision !== revision || response?.reported) return;
                if (lastError || !response?.success) {
                    const reason = lastError?.message || response?.error || "応答なし";
                    console.error("Web Reader for VOICEVOX: 依頼失敗:", reason);
                    this.updateUIState('error');
                    // 「テキストが長すぎる」「Offscreenを用意できない」等の理由を利用者にも見せる
                    // （アイコンが赤くなるだけでは原因不明の無反応に見える）。
                    if (this.isTopFrame) {
                        this.showPlaybackErrorToast(reason);
                    } else {
                        // 子フレームは案内UIを持たないため、要求元タブのトップへ理由を返す。
                        chrome.runtime.sendMessage({
                            type: "SELECTION_READING_ERROR", error: String(reason).slice(0, 1000)
                        }, () => { void chrome.runtime.lastError; });
                    }
                }
            });
        } catch (error) {
            // 拡張機能の更新・再読み込み直後は何もしない。
        }
    },

    // メッセージの整形（不要な情報の削除・置換）
    // 改行は残す。合成側（background の splitText）が改行を文の区切りとして扱うため、
    // 見出し・箇条書き・表のセルが1件ずつになり、段落の「間」も自然に入る。
    // 以前はテキスト選択の経路だけ改行を空白にしていたが、見出しと本文が1つの長い
    // 「文」につながって分割位置が不自然になるだけで、利点は無かった。
    // 細かな整形（不可視文字・記号の連続・日付や単位の読み・URLの取りこぼし）は
    // すべての経路が通る background 側で行う。
    cleanMessage(text) {
        if (!text) return "";
        return text
            .replace(/https?:\/\/[\w\/:%#\$&\?\(\)~\.=\+\-]+/g, "URL省略")
            .replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
    }
};
})();
