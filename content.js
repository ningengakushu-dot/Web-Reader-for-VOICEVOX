class VVRadioReader {
    constructor() {
        this.isPlaying = false;
        this.indicator = null;
        this.init();
    }

    init() {
        this.injectIndicator();
        this.checkVoicevoxConnection();
        this.setupMessageListener();
    }

    // 画面にインジケーターアイコンを注入
    injectIndicator() {
        if (document.getElementById("vvradio-host")) return;

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
                const rect = this.indicator.getBoundingClientRect();
                chrome.storage.local.set({ vvradio_icon_pos: { left: rect.left, top: rect.top } });
            }
        };

        this.indicator.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // 左クリックのみ許可
            e.preventDefault(); // テキスト選択解除を防止

            isDragging = true;
            dragMoved = false;
            startX = e.clientX;
            startY = e.clientY;

            const rect = this.indicator.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

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
                const text = window.getSelection().toString().trim();
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
        chrome.storage.local.get("vvradio_icon_pos", (res) => {
            if (res.vvradio_icon_pos) {
                const { left, top } = res.vvradio_icon_pos;
                // 画面サイズ変更などで画面外に出ないように補正
                const maxLeft = window.innerWidth - 16;
                const maxTop = window.innerHeight - 16;
                const safeLeft = Math.max(0, Math.min(maxLeft, left));
                const safeTop = Math.max(0, Math.min(maxTop, top));

                this.indicator.style.bottom = "auto";
                this.indicator.style.right = "auto";
                this.indicator.style.left = `${safeLeft}px`;
                this.indicator.style.top = `${safeTop}px`;
            }
        });
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

    // バックグラウンド等からのメッセージのリスナーを設定
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request) => {
            switch (request.type) {
                case "READ_SELECTED_TEXT":
                    if (request.text) this.speakText(request.text);
                    break;
                case "TOGGLE_READING":
                    if (this.isPlaying) {
                        this.stopAll();
                    } else {
                        const text = window.getSelection().toString().trim();
                        if (text) this.speakText(text);
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

new VVRadioReader();
