// 再実行（manifest の自動注入と background.js のフォールバック注入の競合等）による
// 二重生成を防ぐガード。class 宣言自体が再評価で失敗し得るため、ガードを含めた
// 実装全体を IIFE で包む。
(() => {
    // 既存インスタンスが生存していれば再生成しない。拡張機能リロード後は旧フラグが
    // 残っていてもリスナーは死んでいるため、単純なフラグではなく「生きているか」を
    // 問い合わせる instance ガードにする。生存確認に失敗・例外する場合は古い
    // インスタンスを可能な範囲で停止してから新しいリーダーを生成する。
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

class VVRadioReader {
    constructor() {
        this.active = true;
        this.isPlaying = false;
        this.indicator = null;
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
            this.applyIconSize();
            this.checkVoicevoxConnection();
        }
        this.setupMessageListener();
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
        const host = document.getElementById("vvradio-host");
        if (host) host.remove();
    }

    // アイコンサイズをストレージから取得して適用し、変更をリアルタイム監視
    applyIconSize() {
        chrome.storage.local.get(["iconSize"], (res) => {
            const size = res.iconSize || 16;
            this.indicator.style.width = `${size}px`;
            this.indicator.style.height = `${size}px`;
        });

        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace !== 'local') return;

            // サイズのリアルタイム反映
            if (changes.iconSize) {
                const newSize = changes.iconSize.newValue || 16;
                this.indicator.style.width = `${newSize}px`;
                this.indicator.style.height = `${newSize}px`;
            }

            // 位置リセットのリアルタイム反映（オプション画面からリセットされた場合）
            if (changes.vvradio_icon_pos && !changes.vvradio_icon_pos.newValue) {
                this.indicator.style.left = '';
                this.indicator.style.top = '';
                this.indicator.style.bottom = '20px';
                this.indicator.style.right = '20px';
            }
        });
    }

    // 画面にインジケーターアイコンを注入
    injectIndicator() {
        // 再注入時に古いホストが残っていると UI が二重化するため、生成前に除去する。
        const stale = document.getElementById("vvradio-host");
        if (stale) stale.remove();

        const host = document.createElement("div");
        host.id = "vvradio-host";
        document.body.appendChild(host);

        // Shadow DOM でカプセル化
        this.shadowRoot = host.attachShadow({ mode: "closed" });

        const style = document.createElement("style");
        style.textContent = `
            #vvradio-indicator {
                position: fixed; bottom: 20px; right: 20px; width: 16px; height: 16px;
                background-color: #3498db; border-radius: 50%; z-index: 999999;
                opacity: 0.4; transition: opacity 0.3s ease, transform 0.2s ease, box-shadow 0.3s ease;
                cursor: grab; display: flex; align-items: center; justify-content: center;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            #vvradio-indicator:active { cursor: grabbing; }
            #vvradio-indicator:hover { opacity: 0.8; transform: scale(1.1); }
            #vvradio-indicator.reading {
                opacity: 1; background-color: #2eb67d; box-shadow: 0 0 15px rgba(46, 182, 125, 0.8);
                animation: vvpulse 2s infinite;
            }
            #vvradio-indicator.error {
                opacity: 1; background-color: #e01e5a; box-shadow: 0 0 15px rgba(224, 30, 90, 0.8);
            }
            @keyframes vvpulse {
                0% { box-shadow: 0 0 0 0 rgba(46, 182, 125, 0.7); }
                70% { box-shadow: 0 0 0 10px rgba(46, 182, 125, 0); }
                100% { box-shadow: 0 0 0 0 rgba(46, 182, 125, 0); }
            }
        `;
        this.shadowRoot.appendChild(style);

        this.indicator = document.createElement("div");
        this.indicator.id = "vvradio-indicator";

        // --- ドラッグ＆ドロップ実装 ---
        let isDragging = false;
        let dragMoved = false;
        let startX, startY, initialLeft, initialTop;

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            // 意図しない微細なブレをドラッグと判定しないための閾値（3px）
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;

            if (dragMoved) {
                // 画面外への飛び出しを防ぐガードレール
                const maxLeft = window.innerWidth - this.indicator.offsetWidth;
                const maxTop = window.innerHeight - this.indicator.offsetHeight;
                const newLeft = Math.max(0, Math.min(maxLeft, initialLeft + dx));
                const newTop = Math.max(0, Math.min(maxTop, initialTop + dy));

                this.indicator.style.left = `${newLeft}px`;
                this.indicator.style.top = `${newTop}px`;
            }
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);

            // 移動した場合、その位置を永続化（次回ロード時に復元するため）
            if (dragMoved) {
                chrome.storage.local.set({ 
                    vvradio_icon_pos: { left: this.indicator.offsetLeft, top: this.indicator.offsetTop } 
                });
            }
        };

        this.indicator.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // 左クリックのみ許可
            e.preventDefault(); // テキスト選択解除を防止

            isDragging = true;
            dragMoved = false;
            startX = e.clientX;
            startY = e.clientY;

            // getBoundingClientRect() は hover (transform: scale) の影響を受けて座標がずれるため、
            // transform 適用前の絶対座標である offsetLeft / offsetTop を使用する。
            initialLeft = this.indicator.offsetLeft;
            initialTop = this.indicator.offsetTop;

            // デフォルトの bottom/right を解除し、left/top 制御に切り替える
            this.indicator.style.bottom = "auto";
            this.indicator.style.right = "auto";
            this.indicator.style.left = `${initialLeft}px`;
            this.indicator.style.top = `${initialTop}px`;

            // ドキュメント全体でマウスイベントを捕捉（高速にドラッグしても見失わないため）
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });

        // 読み上げ開始/停止のトグルリスナー（左クリック）
        this.indicator.addEventListener("click", (e) => {
            // ドラッグ操作だった場合はクリック判定を破棄（競合回避）
            if (dragMoved) {
                e.preventDefault();
                return;
            }

            if (this.isPlaying) {
                this.stopAll();
            } else {
                const text = this.getSelectedText();
                if (text) {
                    this.speakText(text);
                } else {
                    this.updateUIState('error');
                    console.warn("Web Reader for VOICEVOX: 読み上げるテキストが選択されていません。");
                }
            }
        });

        // オプション画面を開くリスナー（右クリック）
        this.indicator.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
        });

        this.shadowRoot.appendChild(this.indicator);

        // 保存された位置があれば復元
        chrome.storage.local.get(["vvradio_icon_pos", "iconSize"], (res) => {
            if (res.vvradio_icon_pos) {
                const { left, top } = res.vvradio_icon_pos;
                const size = res.iconSize || 16;
                // 画面サイズ変更などで画面外に出ないように補正
                const maxLeft = window.innerWidth - size;
                const maxTop = window.innerHeight - size;
                const safeLeft = Math.max(0, Math.min(maxLeft, left));
                const safeTop = Math.max(0, Math.min(maxTop, top));

                this.indicator.style.bottom = "auto";
                this.indicator.style.right = "auto";
                this.indicator.style.left = `${safeLeft}px`;
                this.indicator.style.top = `${safeTop}px`;
            }
        });
    }

    // 選択中のテキストを取得する
    // input/textarea 内の選択（window.getSelection() では取得できない）にも対応する
    getSelectedText() {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
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
    }

    // UIのステータス表示を更新
    updateUIState(state) {
        if (!this.indicator) return;
        this.indicator.classList.remove("reading", "error");
        if (state === 'reading') {
            this.indicator.classList.add("reading");
        } else if (state === 'error') {
            this.indicator.classList.add("error");
            setTimeout(() => this.indicator.classList.remove("error"), 3000);
        }
    }

    // TOGGLE_READING を自フレームで処理すべきか判定する。
    // ショートカットは全フレームに配信されるため、フォーカスを持たないフレームや、
    // フォーカスが子フレーム（IFRAME/FRAME）にあるフレームでは処理せず、
    // 実際にフォーカスを持つフレームだけが読み上げを担当することで二重読み上げを防ぐ。
    shouldHandleToggleReading() {
        if (!document.hasFocus()) return false;
        const active = document.activeElement;
        if (active && (active.tagName === "IFRAME" || active.tagName === "FRAME")) {
            return false;
        }
        return true;
    }

    // バックグラウンド等からのメッセージのリスナーを設定
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request) => {
            // 停止済み（stale）インスタンスのリスナーは何もしない
            if (!this.active) return;
            switch (request.type) {
                case "READ_SELECTED_TEXT":
                    if (request.text) this.speakText(request.text);
                    break;
                case "TOGGLE_READING":
                    // フォーカスを持つフレームのみが処理（全フレーム配信による二重読み上げ防止）
                    if (!this.shouldHandleToggleReading()) break;
                    if (this.isPlaying) {
                        this.stopAll();
                    } else {
                        const text = this.getSelectedText();
                        if (text) {
                            this.speakText(text);
                        } else {
                            // ショートカット起動時に無音で失敗させず、エラー状態とログで可視化する
                            this.updateUIState('error');
                            console.warn("Web Reader for VOICEVOX: 読み上げるテキストが選択されていません。(ショートカット)");
                        }
                    }
                    break;
                case "PLAYBACK_STARTED":
                    this.isPlaying = true;
                    this.updateUIState('reading');
                    break;
                case "PLAYBACK_ENDED":
                case "PLAYBACK_STOPPED":
                    this.isPlaying = false;
                    this.updateUIState('idle');
                    break;
                case "PLAYBACK_ERROR":
                    console.error("Web Reader for VOICEVOX: 再生エラー:", request.error);
                    this.isPlaying = false;
                    this.updateUIState('error');
                    break;
            }
        });
    }

    // バックグラウンド経由でVOICEVOXエンジンの接続確認
    checkVoicevoxConnection() {
        chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" }, (res) => {
            if (chrome.runtime.lastError || !res || !res.success) {
                console.warn("Web Reader for VOICEVOX: VOICEVOXに接続できません。");
                this.updateUIState('error');
            }
        });
    }

    // 音声再生リクエスト
    speakText(text) {
        if (!text) return;

        const cleanText = this.cleanMessage(text);
        if (!cleanText) return;

        chrome.runtime.sendMessage({
            type: "GENERATE_VOICE",
            text: cleanText
        }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
                console.error("Web Reader for VOICEVOX: 依頼失敗:",
                    chrome.runtime.lastError?.message || response?.error || "応答なし");
                this.updateUIState('error');
            }
        });
    }

    // 再生の完全停止とキューのクリア要求
    stopAll() {
        chrome.runtime.sendMessage({ type: "STOP_ALL" });
        this.isPlaying = false;
        this.updateUIState('idle');
    }

    // メッセージの整形（不要な情報の削除・置換）
    cleanMessage(text) {
        if (!text) return "";
        return text
            .replace(/https?:\/\/[\w\/:%#\$&\?\(\)~\.=\+\-]+/g, "URL省略")
            .replace(/\n+/g, " ")
            .trim();
    }
}

    window.__vvRadioReaderInstance = new VVRadioReader();
})();
