console.log("Web Reader for VOICEVOX: Content Script 読み込み完了");

class VVRadioReader {
    constructor() {
        console.log("Web Reader for VOICEVOX: クラス初期化開始");
        this.VOICEVOX_BASE_URL = "http://127.0.0.1:50021";
        
        this.audioQueue = [];   // 再生待ち音声データのキュー
        this.isPlaying = false; // 現在再生中かどうかのフラグ
        this.currentAudio = null; // 現在再生中のAudioオブジェクト
        this.indicator = null;    // 画面上のUIアイコン

        // オーディオドライバのスリープ復帰用無音WAVデータ（ヘッダーのみ）
        this.SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==";

        this.init();
    }

    init() {
        this.injectIndicator();
        this.checkVoicevoxConnection();
        this.setupMessageListener();
        console.log("Web Reader for VOICEVOX: 起動");
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
                position: fixed; bottom: 20px; right: 20px; width: 32px; height: 32px;
                background-color: #4A154B; border-radius: 50%; z-index: 999999;
                opacity: 0.3; transition: opacity 0.3s ease, transform 0.2s ease, box-shadow 0.3s ease;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                background-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cG9seWdvbiBwb2ludHM9IjExIDUgNiA5IDIgOSAyIDE1IDYgMTUgMTEgMTkgMTEgNSI+PC9wb2x5Z29uPjxwYXRoIGQ9Ik0xNS41NCA4LjQ2YTUgNSAwIDAgMSAwIDcuMDciPjwvcGF0aD48L3N2Zz4=');
                background-repeat: no-repeat;
                background-position: center;
                background-size: 18px;
            }
            #vvradio-indicator:hover { opacity: 0.7; transform: scale(1.1); }
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
        
        // オプション画面を開くリスナー（右クリック）
        this.indicator.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
        });

        this.shadowRoot.appendChild(this.indicator);
    }

    // UIのステータス表示を更新
    updateUIState(state) {
        if (!this.indicator) return;
        this.indicator.classList.remove("reading", "error");
        if (state === 'reading') {
            this.indicator.classList.add("reading");
        } else if (state === 'error') {
            this.indicator.classList.add("error");
            setTimeout(() => {
                this.indicator.classList.remove("error");
            }, 3000);
        }
    }

    // バックグラウンド等からのメッセージのリスナーを設定
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.type === "READ_SELECTED_TEXT" && request.text) {
                this.speakText(request.text);
            } else if (request.type === "TOGGLE_READING") {
                if (this.isPlaying || this.audioQueue.length > 0) {
                    this.stopAll();
                } else {
                    const text = window.getSelection().toString().trim();
                    if (text) {
                        this.speakText(text);
                    }
                }
            }
        });
    }

    // バックグラウンド経由でVOICEVOXエンジンの接続確認
    async checkVoicevoxConnection() {
        chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" }, (res) => {
            if (chrome.runtime.lastError || !res || !res.success) {
                console.error("Web Reader for VOICEVOX: VOICEVOX に接続できません。");
                this.updateUIState('error');
            } else {
                console.log("Web Reader for VOICEVOX: VOICEVOX 接続OK (Port: 50021)");
            }
        });
    }

    // --- 音声再生リクエスト ---

    async speakText(text) {
        if (!text) return;

        const cleanText = this.cleanMessage(text);
        if (!cleanText) return;

        console.log("Web Reader for VOICEVOX: 読み上げ依頼送信:", cleanText);

        try {
            chrome.runtime.sendMessage({
                type: "GENERATE_VOICE",
                text: cleanText
            }, (response) => {
                if (chrome.runtime.lastError || !response || !response.success) {
                    console.error("Web Reader for VOICEVOX: 依頼失敗:", chrome.runtime.lastError || (response && response.error) || "応答なし");
                    this.updateUIState('error');
                    return;
                }
            });
        } catch (error) {
            console.error("Web Reader for VOICEVOX: 通信重大エラー:", error.message);
            this.updateUIState('error');
        }
    }

    // 再生の完全停止とキューのクリア要求
    stopAll() {
        console.log("Web Reader for VOICEVOX: 停止リクエスト送信");
        chrome.runtime.sendMessage({ type: "STOP_ALL" });
        this.isPlaying = false;
        this.updateUIState('idle');
    }

    // バックグラウンドからの再生状態通知のリスナー（各タブ共通）
    setupPlaybackStateListener() {
        chrome.runtime.onMessage.addListener((message) => {
            if (message.target !== 'background') return;

            switch (message.type) {
                case 'PLAYBACK_STARTED':
                    this.isPlaying = true;
                    this.updateUIState('reading');
                    break;
                case 'PLAYBACK_ENDED':
                case 'PLAYBACK_STOPPED':
                    this.isPlaying = false;
                    this.updateUIState('idle');
                    break;
                case 'PLAYBACK_ERROR':
                    console.error("Web Reader for VOICEVOX: 再生エラー通知受信:", message.error);
                    this.isPlaying = false;
                    this.updateUIState('error');
                    break;
            }
        });
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

const reader = new VVRadioReader();
reader.setupPlaybackStateListener();
