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

// OCRの進捗がこの時間だけ途絶えたら、処理が中断されたとみなして待つのをやめる。
// 認識自体の上限（offscreen 側の 60 秒）より長く取り、正常に時間がかかっている
// だけの場合に誤って打ち切らないようにする。
const OCR_STALL_TIMEOUT_MS = 90000;

class VVRadioReader {
    constructor() {
        this.active = true;
        this.isPlaying = false;
        this.indicator = null;
        // OCRの進捗途絶を検知する見張りタイマー（armOcrStallWatchdog で設定）
        this.ocrStallWatchdog = null;
        // ルビ優先読みの設定。ページ内テキスト経路（Tier 0）でも同じ設定に従う。
        this.ocrRemoveRuby = false;
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
        this.setupKeyboardShortcutFallback();
        this.watchOcrSettings();
    }

    // ルビ優先読みの設定を読み込み、変更に追従する。
    // OCR経路では background が設定を読んでメッセージに載せるが、
    // ページ内テキスト経路は content script 側で完結するためここで持つ。
    watchOcrSettings() {
        chrome.storage.local.get(["ocrRemoveRuby"], (res) => {
            if (!this.active) return;
            this.ocrRemoveRuby = res.ocrRemoveRuby === true;
        });
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (!this.active || namespace !== "local") return;
            if (changes.ocrRemoveRuby) {
                this.ocrRemoveRuby = changes.ocrRemoveRuby.newValue === true;
            }
        });
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
    }

    // アイコンサイズをストレージから取得して適用し、変更をリアルタイム監視
    applyIconSize() {
        chrome.storage.local.get(["iconSize"], (res) => {
            if (!this.indicator) return;
            const size = res.iconSize || 16;
            this.indicator.style.width = `${size}px`;
            this.indicator.style.height = `${size}px`;
        });

        chrome.storage.onChanged.addListener((changes, namespace) => {
            // deactivate 済み（stale）インスタンスや、インジケーター未生成のフレームでは
            // detached になった indicator を触らないよう早期に抜ける。
            if (!this.active || !this.indicator) return;
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

            this.toggleReading();
        });

        // 右クリックリスナー。動作は設定で切替可能（既定: 画面OCR読み上げの開始）。
        // 従来のオプション画面を開く動作は、設定 iconRightClickAction を
        // "options" にすることで維持できる。
        this.indicator.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            chrome.storage.local.get({ iconRightClickAction: "capture" }, (res) => {
                if (res.iconRightClickAction === "options") {
                    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
                } else {
                    // ページ内の範囲選択オーバーレイを直接開始する
                    // （インジケーターはトップフレームにのみ存在する）
                    this.startOcrSelection();
                }
            });
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

    setupKeyboardShortcutFallback() {
        document.addEventListener("keydown", (event) => {
            if (!this.active || event.repeat || !event.isTrusted) return;
            if (!this.isShortcutEvent(event)) return;
            if (!this.shouldHandleToggleReading()) return;

            // Chrome commands が未割当/競合していて background に届かない場合の保険。
            // content 側では実行せず background に集約し、commands 経路との二重処理を防ぐ。
            event.preventDefault();
            event.stopPropagation();

            chrome.runtime.sendMessage({ type: "SHORTCUT_PRESSED" }, () => {
                if (chrome.runtime.lastError) {
                    console.warn("Web Reader for VOICEVOX: ショートカット通知に失敗:",
                        chrome.runtime.lastError.message);
                }
            });
        }, true);
    }

    isShortcutEvent(event) {
        const key = (event.key || "").toLowerCase();
        return event.altKey
            && event.shiftKey
            && !event.ctrlKey
            && !event.metaKey
            && (event.code === "KeyU" || key === "u");
    }

    toggleReading() {
        if (this.isPlaying) {
            this.stopAll();
            return;
        }

        const text = this.getSelectedText();
        if (text) {
            this.speakText(text);
        } else {
            this.updateUIState('error');
            console.warn("Web Reader for VOICEVOX: 読み上げるテキストが選択されていません。(ショートカット)");
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
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
                    this.updateOcrToast(`文字認識中... ${Math.round((request.progress || 0) * 100)}%`);
                    this.armOcrStallWatchdog();
                    break;
                case "OCR_STATUS":
                    this.handleOcrStatus(request);
                    break;
                case "TOGGLE_READING":
                    // フォーカスを持つフレームのみが処理（全フレーム配信による二重読み上げ防止）
                    if (!this.shouldHandleToggleReading()) break;
                    this.toggleReading();
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
                    this.showPlaybackErrorToast(request.error);
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

    // --- ページ内OCR範囲選択 ---
    // 閲覧中のページの表示を一切変えずに、オーバーレイ上で読み上げたい範囲を
    // ドラッグ選択させる。選択後はオーバーレイを除去してから background に
    // キャプチャとOCRを依頼する（オーバーレイが写り込まないようにするため）。

    startOcrSelection() {
        this.removeOcrOverlay();
        this.removeOcrToast();
        // 旧インスタンスが残したオーバーレイがあれば除去する（再注入時の保険）
        const stale = document.getElementById("vvradio-ocr-host");
        if (stale) stale.remove();

        const host = document.createElement("div");
        host.id = "vvradio-ocr-host";
        (document.body || document.documentElement).appendChild(host);
        const root = host.attachShadow({ mode: "closed" });

        const style = document.createElement("style");
        style.textContent = `
            #vvradio-ocr-overlay {
                position: fixed; inset: 0; z-index: 2147483647;
                cursor: crosshair; user-select: none;
                background: rgba(29, 28, 29, 0.3);
            }
            #vvradio-ocr-overlay.dragging { background: transparent; }
            #vvradio-ocr-hint {
                position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
                background: rgba(29, 28, 29, 0.85); color: #fff;
                font: 13px 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                padding: 8px 16px; border-radius: 6px; pointer-events: none;
            }
            #vvradio-ocr-box {
                position: fixed; box-sizing: border-box;
                border: 2px dashed #ffffff;
                box-shadow: 0 0 0 100000px rgba(29, 28, 29, 0.3);
                display: none; pointer-events: none;
            }
        `;
        root.appendChild(style);

        const overlay = document.createElement("div");
        overlay.id = "vvradio-ocr-overlay";
        const hint = document.createElement("div");
        hint.id = "vvradio-ocr-hint";
        hint.textContent = "読み上げたい範囲をドラッグで選択（Escまたはクリックでキャンセル）";
        const box = document.createElement("div");
        box.id = "vvradio-ocr-box";
        overlay.appendChild(hint);
        overlay.appendChild(box);
        root.appendChild(overlay);

        const state = { startX: 0, startY: 0, dragging: false };

        const currentRect = (e) => {
            const curX = Math.max(0, Math.min(e.clientX, window.innerWidth));
            const curY = Math.max(0, Math.min(e.clientY, window.innerHeight));
            return {
                x: Math.min(state.startX, curX),
                y: Math.min(state.startY, curY),
                width: Math.abs(curX - state.startX),
                height: Math.abs(curY - state.startY)
            };
        };

        const onMouseDown = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            state.dragging = true;
            state.startX = e.clientX;
            state.startY = e.clientY;
            hint.style.display = "none";
            overlay.classList.add("dragging");
        };

        const onMouseMove = (e) => {
            if (!state.dragging) return;
            const rect = currentRect(e);
            box.style.left = `${rect.x}px`;
            box.style.top = `${rect.y}px`;
            box.style.width = `${rect.width}px`;
            box.style.height = `${rect.height}px`;
            box.style.display = "block";
        };

        const onMouseUp = (e) => {
            if (!state.dragging) return;
            const rect = currentRect(e);
            this.removeOcrOverlay();
            // 微小ドラッグ（クリック）はキャンセル扱い
            if (rect.width < 12 || rect.height < 12) return;
            this.startRegionReading(rect);
        };

        const onKeyDown = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                this.removeOcrOverlay();
            }
        };

        overlay.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mousemove", onMouseMove, true);
        window.addEventListener("mouseup", onMouseUp, true);
        window.addEventListener("keydown", onKeyDown, true);

        this.ocrOverlay = {
            host,
            cleanup: () => {
                window.removeEventListener("mousemove", onMouseMove, true);
                window.removeEventListener("mouseup", onMouseUp, true);
                window.removeEventListener("keydown", onKeyDown, true);
            }
        };
    }

    removeOcrOverlay() {
        if (!this.ocrOverlay) return;
        this.ocrOverlay.cleanup();
        this.ocrOverlay.host.remove();
        this.ocrOverlay = null;
    }

    // 選択範囲の読み上げ。まずページが持っている文字データを直接取り出し（Tier 0）、
    // 取れない範囲（画像内の文字・canvas・別オリジンのフレーム等）だけを
    // 従来どおり画面キャプチャ＋OCRに回す。
    //
    // Tier 0 で取れる場合、認識誤りが原理的に起こらず、待ち時間も桁違いに短い
    // （実測: 実サイト8件で読み取れた率 61.0%→84.7%、11.5秒→52ミリ秒）。
    startRegionReading(rect) {
        const dom = globalThis.VVRadioDomText;
        if (dom) {
            let result = null;
            // 自前のインジケーターが最前面判定を妨げ、その下の文字を
            // 「覆われている」と誤判定するため、抽出の間だけ隠す。
            const host = document.getElementById("vvradio-host");
            const prevVisibility = host ? host.style.visibility : null;
            if (host) host.style.visibility = "hidden";
            try {
                result = dom.collectRegionText(rect, { removeRuby: this.ocrRemoveRuby === true });
            } catch (err) {
                console.warn("VVRadio: ページ内テキストの取得に失敗:", err.message);
            } finally {
                if (host) host.style.visibility = prevVisibility;
            }
            if (result && result.ok && result.text) {
                // 段落の切れ目はDOM構造から正確に分かっているので、改行のまま渡して
                // 合成側で「間」にしてもらう（OCR経路と同じ扱い）。
                this.speakText(result.text, { keepParagraphs: true });
                return;
            }
        }
        this.requestRegionOcr(rect);
    }

    // 選択範囲（ビューポートCSS座標）を background に渡してキャプチャ→OCR→読み上げを依頼する。
    // オーバーレイ除去の再描画がキャプチャに反映されるよう、2フレーム＋少し待ってから送る。
    requestRegionOcr(rect) {
        // キャプチャに自前UI（インジケーター・準備中トースト）が写り込むと、その文言まで
        // OCRされて読み上げに混入する（画面全体の選択で確実に起きる）。撮影前にインジケーターを
        // 隠し、進捗トーストは撮影完了後（sendMessage 応答後＝captureVisibleTab 済み）にのみ表示する。
        if (this.indicator) this.indicator.style.visibility = "hidden";
        requestAnimationFrame(() => requestAnimationFrame(() => {
            setTimeout(() => {
                // OCRが長引いた場合・応答が途絶えた場合にトーストが残り続けないための保険。
                // ここでエラー扱いにすると、後から認識完了→読み上げ開始したときに表示と矛盾する
                // ため（巨大範囲・低速端末で発生）、中立的に待たせるに留める。
                this.ocrToastGuard = setTimeout(() => {
                    this.ocrToastGuard = null;
                    if (this.indicator) this.indicator.style.visibility = "";
                    this.showOcrToast("文字認識に時間がかかっています。しばらくお待ちください…");
                }, 90000);

                chrome.runtime.sendMessage({
                    type: "CAPTURE_OCR_REGION",
                    rect,
                    viewportWidth: window.innerWidth
                }, (response) => {
                    // 応答は background が captureVisibleTab を終えた後に届く＝撮影済み。
                    // ここで初めてインジケーターを戻し、進捗トーストを出す（写り込み防止）。
                    if (this.indicator) this.indicator.style.visibility = "";
                    if (chrome.runtime.lastError || !response || !response.success) {
                        const reason = chrome.runtime.lastError?.message || response?.error || "応答なし";
                        this.handleOcrStatus({ status: "error", message: `キャプチャに失敗しました: ${reason}` });
                    } else {
                        this.showOcrToast("文字認識中...");
                        this.armOcrStallWatchdog();
                    }
                });
            }, 60);
        }));
    }

    // 認識処理そのものが止まったことを検知する見張り。進捗が届くたびに掛け直す。
    // OCRを担う offscreen ドキュメントが認識中に破棄されると、完了もエラーも
    // 届かないまま待ち続けることになるため、その場合でも必ず終わらせる。
    armOcrStallWatchdog() {
        if (this.ocrStallWatchdog) clearTimeout(this.ocrStallWatchdog);
        this.ocrStallWatchdog = setTimeout(() => {
            this.ocrStallWatchdog = null;
            this.handleOcrStatus({
                status: "error",
                message: "文字認識が中断されました。もう一度お試しください。"
            });
        }, OCR_STALL_TIMEOUT_MS);
    }

    clearOcrStallWatchdog() {
        if (this.ocrStallWatchdog) {
            clearTimeout(this.ocrStallWatchdog);
            this.ocrStallWatchdog = null;
        }
    }

    // OCRの進行状況・完了・エラーを示す小さなトースト表示
    showOcrToast(text) {
        if (!this.shadowRoot) return;
        if (!this.ocrToast) {
            const toast = document.createElement("div");
            toast.id = "vvradio-ocr-toast";
            toast.style.cssText = `
                position: fixed; bottom: 48px; right: 20px; z-index: 999999;
                background: rgba(29, 28, 29, 0.85); color: #fff;
                font: 12px 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                padding: 6px 12px; border-radius: 6px; pointer-events: none;
                max-width: 320px;
            `;
            this.shadowRoot.appendChild(toast);
            this.ocrToast = toast;
        }
        this.ocrToast.textContent = text;
    }

    updateOcrToast(text) {
        if (this.ocrToast) this.showOcrToast(text);
    }

    removeOcrToast() {
        this.clearOcrStallWatchdog();
        if (this.ocrToastGuard) {
            clearTimeout(this.ocrToastGuard);
            this.ocrToastGuard = null;
        }
        if (this.ocrToast) {
            this.ocrToast.remove();
            this.ocrToast = null;
        }
    }

    // 合成・再生の失敗をトーストで明示する。アイコンの状態変化だけでは
    // 「何も起きない」ように見えるため（VOICEVOX未起動が典型例）。
    showPlaybackErrorToast(error) {
        const message = /Failed to fetch|NetworkError|ERR_CONNECTION/i.test(error || "")
            ? "VOICEVOXエンジンに接続できません。VOICEVOXを起動してから再度お試しください。"
            : `音声の再生に失敗しました: ${error || "不明なエラー"}`;
        this.showOcrToast(message);
        setTimeout(() => this.removeOcrToast(), 6000);
    }

    handleOcrStatus(request) {
        // 撮影のために隠したインジケーターを、どの終了経路でも確実に復帰させる。
        if (this.indicator) this.indicator.style.visibility = "";
        this.clearOcrStallWatchdog();
        if (this.ocrToastGuard) {
            clearTimeout(this.ocrToastGuard);
            this.ocrToastGuard = null;
        }
        if (request.status === "error") {
            this.showOcrToast(request.message || "文字認識に失敗しました。");
            this.updateUIState('error');
            setTimeout(() => this.removeOcrToast(), 4000);
        } else {
            // 完了: 読み上げが始まると PLAYBACK_STARTED でインジケーターが点灯する
            this.removeOcrToast();
        }
    }

    // 音声再生リクエスト
    speakText(text, options = {}) {
        if (!text) return;

        const cleanText = this.cleanMessage(text, options.keepParagraphs === true);
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
    // keepParagraphs=true のときは改行を残す。合成側が改行を文の区切りとして扱い、
    // 段落の「間」になるため（ページ内テキスト経路で段落構造が分かる場合に使う）。
    cleanMessage(text, keepParagraphs = false) {
        if (!text) return "";
        const withoutUrls = text
            .replace(/https?:\/\/[\w\/:%#\$&\?\(\)~\.=\+\-]+/g, "URL省略");
        if (keepParagraphs) {
            return withoutUrls.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
        }
        return withoutUrls.replace(/\n+/g, " ").trim();
    }
}

    window.__vvRadioReaderInstance = new VVRadioReader();
})();
