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
        // 登録したリスナー（deactivate でまとめて解除する）
        this.storageListeners = [];
        this.keyboardShortcutListener = null;
        this.messageListener = null;
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
        this.addStorageListener((changes, namespace) => {
            if (!this.active || namespace !== "local") return;
            if (changes.ocrRemoveRuby) {
                this.ocrRemoveRuby = changes.ocrRemoveRuby.newValue === true;
            }
        });
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

    // アイコンのサイズと見た目をストレージから読み込んで適用し、変更をリアルタイムに反映する
    // （content script は constants.js を読み込まないため、キー名と既定値は直値で持つ）
    applyIconAppearance() {
        const keys = ["iconSize", "iconStyle", "vv_character_icon", "vv_custom_icon"];
        chrome.storage.local.get(keys, (res) => {
            if (!this.active || !this.indicator || chrome.runtime.lastError) return;
            this.applyIndicatorSize(res.iconSize || 16);
            this.applyIndicatorStyle(res);
        });

        this.addStorageListener((changes, namespace) => {
            // deactivate 済み（stale）インスタンスや、インジケーター未生成のフレームでは
            // detached になった indicator を触らないよう早期に抜ける。
            if (!this.active || !this.indicator) return;
            if (namespace !== 'local') return;

            // サイズのリアルタイム反映
            if (changes.iconSize) {
                this.applyIndicatorSize(changes.iconSize.newValue || 16);
            }

            // 見た目のリアルタイム反映。設定画面での保存直後に開いているページへ即反映する。
            // 画像データは storage 側にしか無いため、変更があれば毎回まとめて読み直す。
            if (changes.iconStyle || changes.vv_character_icon || changes.vv_custom_icon) {
                chrome.storage.local.get(keys, (res) => {
                    if (!this.active || !this.indicator || chrome.runtime.lastError) return;
                    this.applyIndicatorStyle(res);
                });
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

    // アイコンの一辺のサイズを適用する。
    // キャラクター名の文字表示は円に内接させたいので、文字サイズも連動させる。
    applyIndicatorSize(size) {
        const numeric = Number(size);
        const safeSize = Number.isFinite(numeric) ? Math.min(128, Math.max(16, numeric)) : 16;
        this.indicator.style.width = `${safeSize}px`;
        this.indicator.style.height = `${safeSize}px`;
        this.indicator.style.fontSize = `${Math.max(8, Math.round(safeSize * 0.62))}px`;
    }

    // アイコンの見た目（従来の円／拡張機能のアイコン／読み上げキャラクター／
    // 利用者がアップロードした画像）を適用する。
    // 画像・文字の指定が欠けている場合は、必ず従来の円にフォールバックする。
    applyIndicatorStyle(res) {
        const el = this.indicator;
        el.classList.remove('image', 'text');
        el.style.backgroundImage = '';
        el.textContent = '';
        el.removeAttribute('title');

        const style = ['dot', 'app', 'character', 'custom'].includes(res.iconStyle) ? res.iconStyle : 'dot';
        const safeRasterDataUrl = (url) => typeof url === 'string'
            && url.length <= 2 * 1024 * 1024
            && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(url);
        const asImage = (url) => {
            el.classList.add('image');
            el.style.backgroundImage = `url("${url}")`;
        };

        if (style === 'app') {
            try {
                if (!chrome.runtime?.id) return;
                asImage(chrome.runtime.getURL('images/icon128.png'));
                el.title = 'Web Reader for VOICEVOX';
            } catch (error) {
                // 更新直後の古いcontent scriptでは既定の円へフォールバックする。
            }
            return;
        }

        if (style === 'custom') {
            const custom = res.vv_custom_icon;
            if (safeRasterDataUrl(custom)) {
                asImage(custom);
                return;
            }
            return; // 画像が未設定なら従来の円のまま
        }

        if (style === 'character') {
            const character = res.vv_character_icon;
            const name = typeof character?.name === 'string' ? character.name.trim().slice(0, 100) : '';
            if (!name) return;
            el.title = name;
            if (safeRasterDataUrl(character.dataUrl)) {
                asImage(character.dataUrl);
            } else {
                // 画像の利用許諾が確認できないキャラクターは名前の頭文字で表示する。
                el.classList.add('text');
                el.textContent = name.slice(0, 1);
            }
        }
    }

    // 画面にインジケーターアイコンを注入
    injectIndicator() {
        // 再注入時に古いホストが残っていると UI が二重化するため、生成前に除去する。
        const stale = document.getElementById("vvradio-host");
        if (stale) stale.remove();

        const host = document.createElement("div");
        host.id = "vvradio-host";
        const parent = document.body || document.documentElement;
        if (!parent || typeof host.attachShadow !== "function") {
            this.indicator = null;
            return;
        }
        parent.appendChild(host);

        // Shadow DOM でカプセル化
        this.shadowRoot = host.attachShadow({ mode: "closed" });
        this.shadowRoot.appendChild(this.createIndicatorStyle());

        this.indicator = document.createElement("div");
        this.indicator.id = "vvradio-indicator";

        const isDragging = this.enableIndicatorDrag();

        // 読み上げ開始/停止のトグルリスナー（左クリック）
        this.indicator.addEventListener("click", (e) => {
            // ドラッグ操作だった場合はクリック判定を破棄（競合回避）
            if (isDragging()) {
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
            try {
                if (!this.active || !chrome.runtime?.id) return;
                chrome.storage.local.get({ iconRightClickAction: "capture" }, (res) => {
                    if (!this.active || chrome.runtime.lastError) return;
                    if (res.iconRightClickAction === "options") {
                        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }, () => {
                            void chrome.runtime.lastError;
                        });
                    } else {
                        // ページ内の範囲選択オーバーレイを直接開始する
                        // （インジケーターはトップフレームにのみ存在する）
                        this.startOcrSelection();
                    }
                });
            } catch (error) {
                // 更新・再読み込み直後の古いcontent scriptでは何もしない。
            }
        });

        this.shadowRoot.appendChild(this.indicator);
        this.restoreIndicatorPosition();
    }

    // インジケーターのスタイル定義を作る。
    // ページ側のCSSと干渉しないよう Shadow DOM の中だけで完結させる。
    createIndicatorStyle() {
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
            /* 画像アイコン（拡張機能のアイコン／キャラクター／アップロード画像）。
               背景色を消して画像そのものを見せ、状態は輪郭の光で表す。
               .reading / .error より詳細度を高くするため、必ず2クラス指定で上書きする。 */
            #vvradio-indicator.image {
                background-color: transparent; box-shadow: none; opacity: 0.85;
                background-size: contain; background-position: center; background-repeat: no-repeat;
            }
            #vvradio-indicator.image:hover { opacity: 1; }
            /* 画像は背景色で状態を表せないため輪郭線で示す。
               box-shadow は .reading のパルスアニメーションに上書きされるので outline を使う。 */
            #vvradio-indicator.image.reading {
                background-color: transparent; opacity: 1;
                outline: 2px solid rgba(46, 182, 125, 0.9); outline-offset: 1px;
            }
            #vvradio-indicator.image.error {
                background-color: transparent; opacity: 1; animation: none;
                outline: 2px solid rgba(224, 30, 90, 0.95); outline-offset: 1px;
                box-shadow: 0 0 14px rgba(224, 30, 90, 0.8);
            }
            /* キャラクター名の頭文字表示。画像の利用許諾が確認できないキャラクター向け。 */
            #vvradio-indicator.text {
                color: #ffffff; opacity: 0.85; overflow: hidden;
                font-family: sans-serif; font-weight: 700; line-height: 1;
                -webkit-user-select: none; user-select: none;
            }
            #vvradio-indicator.text:hover { opacity: 1; }
            #vvradio-indicator.text.reading { background-color: #2eb67d; opacity: 1; }
            #vvradio-indicator.text.error { background-color: #e01e5a; opacity: 1; animation: none; }
            @keyframes vvpulse {
                0% { box-shadow: 0 0 0 0 rgba(46, 182, 125, 0.7); }
                70% { box-shadow: 0 0 0 10px rgba(46, 182, 125, 0); }
                100% { box-shadow: 0 0 0 0 rgba(46, 182, 125, 0); }
            }
        `;
        return style;
    }

    // インジケーターのドラッグ移動を有効にする。
    // 戻り値は「直前の操作がドラッグだったか」を返す関数で、クリックでの
    // 読み上げトグルとドラッグの競合を避けるために使う。
    // @returns {() => boolean}
    enableIndicatorDrag() {
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
                try {
                    if (chrome.runtime?.id) {
                        chrome.storage.local.set({
                            vvradio_icon_pos: { left: this.indicator.offsetLeft, top: this.indicator.offsetTop }
                        });
                    }
                } catch (e) {
                    // コンテキスト無効化時のエラーを無視
                }
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

        return () => dragMoved;
    }

    // 保存された位置があれば復元する
    restoreIndicatorPosition() {
        chrome.storage.local.get(["vvradio_icon_pos", "iconSize"], (res) => {
            if (!this.active || !this.indicator || chrome.runtime.lastError) return;
            if (res.vvradio_icon_pos) {
                const left = Number(res.vvradio_icon_pos.left);
                const top = Number(res.vvradio_icon_pos.top);
                if (!Number.isFinite(left) || !Number.isFinite(top)) return;
                const rawSize = Number(res.iconSize);
                const size = Number.isFinite(rawSize) ? Math.min(128, Math.max(16, rawSize)) : 16;
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
                chrome.runtime.sendMessage({ type: "SHORTCUT_PRESSED" }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn("Web Reader for VOICEVOX: ショートカット通知に失敗:",
                            chrome.runtime.lastError.message);
                    }
                });
            } catch (error) {
                // 更新・再読み込み直後の古いcontent scriptでは何もしない。
            }
        };
        document.addEventListener("keydown", this.keyboardShortcutListener, true);
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
        };
        chrome.runtime.onMessage.addListener(this.messageListener);
    }

    // バックグラウンド経由でVOICEVOXエンジンの接続確認
    checkVoicevoxConnection() {
        chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" }, (res) => {
            if (!this.active) return;
            if (chrome.runtime.lastError || !res || !res.success) {
                console.warn("Web Reader for VOICEVOX: VOICEVOXに接続できません。");
                this.updateUIState('error');
            }
        });
    }

    // 既存ユーザー向けアップデート初回お知らせの確認と表示権の獲得
    checkUpdateNotice() {
        try {
            chrome.runtime.sendMessage({ type: "CLAIM_UPDATE_NOTICE" }, (res) => {
                if (!this.active || chrome.runtime.lastError || !res?.shouldShow) return;
                this.showUpdateNoticeModal();
            });
        } catch (e) {
            // 拡張コンテキスト無効化時は安全に何もしない
        }
    }

    // アップデートお知らせモーダルの表示
    showUpdateNoticeModal() {
        if (document.getElementById("vvradio-update-notice-host")) return;

        const host = document.createElement("div");
        host.id = "vvradio-update-notice-host";
        const parent = document.body || document.documentElement;
        if (!parent || typeof host.attachShadow !== "function") return;
        parent.appendChild(host);
        const root = host.attachShadow({ mode: "open" });

        const style = document.createElement("style");
        style.textContent = `
            :host {
                all: initial;
            }
            .notice-card {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 360px;
                max-width: calc(100vw - 48px);
                background: rgba(24, 28, 38, 0.94);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 16px;
                padding: 20px 22px;
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.05);
                color: #f3f4f6;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                z-index: 2147483647;
                box-sizing: border-box;
                animation: vvNoticeSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
            @keyframes vvNoticeSlideIn {
                from { opacity: 0; transform: translateY(20px) scale(0.96); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .notice-header {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 10px;
            }
            .notice-badge {
                background: linear-gradient(135deg, #2eb67d, #1fa86c);
                color: #ffffff;
                font-size: 11px;
                font-weight: 700;
                padding: 3px 8px;
                border-radius: 20px;
                letter-spacing: 0.5px;
            }
            .notice-title {
                font-size: 15px;
                font-weight: 700;
                color: #ffffff;
                margin: 0;
            }
            .notice-body {
                font-size: 13px;
                line-height: 1.55;
                color: #d1d5db;
                margin-bottom: 16px;
            }
            .notice-actions {
                display: flex;
                gap: 10px;
                align-items: center;
            }
            .btn-primary {
                flex: 1;
                background: linear-gradient(135deg, #a855f7, #6366f1);
                color: #ffffff;
                border: none;
                border-radius: 10px;
                padding: 9px 14px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                transition: transform 0.15s ease, box-shadow 0.15s ease;
                box-shadow: 0 4px 12px rgba(168, 85, 247, 0.3);
            }
            .btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 16px rgba(168, 85, 247, 0.45);
            }
            .btn-secondary {
                background: rgba(255, 255, 255, 0.08);
                color: #9ca3af;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 10px;
                padding: 9px 14px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease;
            }
            .btn-secondary:hover {
                background: rgba(255, 255, 255, 0.15);
                color: #ffffff;
            }
        `;

        const card = document.createElement("div");
        card.className = "notice-card";
        card.innerHTML = `
            <div class="notice-header">
                <span class="notice-badge">UPDATE</span>
                <h4 class="notice-title">Web Reader for VOICEVOX</h4>
            </div>
            <div class="notice-body">
                【新機能・変更点のお知らせ】<br>
                ・画像やPDFの文字認識（OCR）読み上げ対応<br>
                ・アイコンの位置移動＆自動保存<br>
                ・アイコン右クリックの動作をOCR起動に変更（※オプションから「設定を開く」に変更可能）<br>
                ・読み上げ動作と安定性の向上<br><br>
                率直なご感想や評価をお寄せください。今後の改善に活用します。
            </div>
            <div class="notice-actions">
                <button class="btn-primary" id="btn-rate">評価する</button>
                <button class="btn-secondary" id="btn-close">閉じる</button>
            </div>
        `;

        root.appendChild(style);
        root.appendChild(card);

        const closeNotice = () => host.remove();

        card.querySelector("#btn-rate").addEventListener("click", () => {
            const storeUrl = "https://chromewebstore.google.com/detail/web-reader-for-voicevox/ilcfondcjhaalpcghnhcejioopcbhhla/reviews";
            window.open(storeUrl, "_blank", "noopener,noreferrer");
            closeNotice();
        });

        card.querySelector("#btn-close").addEventListener("click", closeNotice);
    }

    // --- ページ内OCR範囲選択 ---
    // 閲覧中のページの表示を一切変えずに、オーバーレイ上で読み上げたい範囲を
    // ドラッグ選択させる。選択後はオーバーレイを除去してから background に
    // キャプチャとOCRを依頼する（オーバーレイが写り込まないようにするため）。

    startOcrSelection() {
        // 進行中のDOM抽出があれば、その結果から読み上げを開始しない。
        this.regionReadGeneration++;
        this.removeOcrOverlay();
        this.removeOcrToast();
        // 旧インスタンスが残したオーバーレイがあれば除去する（再注入時の保険）
        const stale = document.getElementById("vvradio-ocr-host");
        if (stale) stale.remove();

        const host = document.createElement("div");
        host.id = "vvradio-ocr-host";
        const parent = document.body || document.documentElement;
        if (!parent || typeof host.attachShadow !== "function") return;
        parent.appendChild(host);
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
            void this.startRegionReading(rect);
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
    async startRegionReading(rect) {
        const generation = ++this.regionReadGeneration;
        const dom = globalThis.VVRadioDomText;
        if (dom) {
            let result = null;
            // 自前のインジケーターが最前面判定を妨げ、その下の文字を
            // 「覆われている」と誤判定するため、抽出の間だけ隠す。
            const host = document.getElementById("vvradio-host");
            if (host) {
                if (this.regionExtractionCount === 0) {
                    this.regionExtractionPrevVisibility = host.style.visibility;
                    host.style.visibility = "hidden";
                }
                this.regionExtractionCount++;
            }
            try {
                result = await dom.collectRegionText(rect, {
                    removeRuby: this.ocrRemoveRuby === true
                });
            } catch (err) {
                console.warn("VVRadio: ページ内テキストの取得に失敗:", err.message);
            } finally {
                if (host) {
                    this.regionExtractionCount = Math.max(0, this.regionExtractionCount - 1);
                    if (this.regionExtractionCount === 0) {
                        host.style.visibility = this.regionExtractionPrevVisibility;
                    }
                }
            }
            // 抽出中に別の範囲選択が始まった、または拡張コンテキストが停止した場合、
            // 古い結果を読み上げない。
            if (!this.active || generation !== this.regionReadGeneration) return;
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
        if (!this.active) return;
        // キャプチャに自前UI（インジケーター・準備中トースト）が写り込むと、その文言まで
        // OCRされて読み上げに混入する（画面全体の選択で確実に起きる）。撮影前にインジケーターを
        // 隠し、進捗トーストは撮影完了後（sendMessage 応答後＝captureVisibleTab 済み）にのみ表示する。
        if (this.indicator) this.indicator.style.visibility = "hidden";
        requestAnimationFrame(() => requestAnimationFrame(() => {
            setTimeout(() => {
                if (!this.active) {
                    if (this.indicator) this.indicator.style.visibility = "";
                    return;
                }
                // OCRが長引いた場合・応答が途絶えた場合にトーストが残り続けないための保険。
                // ここでエラー扱いにすると、後から認識完了→読み上げ開始したときに表示と矛盾する
                // ため（巨大範囲・低速端末で発生）、中立的に待たせるに留める。
                this.ocrToastGuard = setTimeout(() => {
                    this.ocrToastGuard = null;
                    if (this.indicator) this.indicator.style.visibility = "";
                    this.showOcrToast("文字認識に時間がかかっています。しばらくお待ちください…");
                }, 90000);

                try {
                    if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
                    chrome.runtime.sendMessage({
                        type: "CAPTURE_OCR_REGION",
                        rect,
                        viewportWidth: window.innerWidth
                    }, (response) => {
                        if (!this.active) return;
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
                } catch (error) {
                    if (this.indicator) this.indicator.style.visibility = "";
                    this.clearOcrToastGuard();
                    // 更新直後の古いcontent scriptは静かに停止する。
                }
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

    // キャプチャ後の「時間がかかっています」表示を出す予約を取り消す
    clearOcrToastGuard() {
        if (this.ocrToastGuard) {
            clearTimeout(this.ocrToastGuard);
            this.ocrToastGuard = null;
        }
    }

    removeOcrToast() {
        this.clearOcrStallWatchdog();
        this.clearOcrToastGuard();
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
        this.clearOcrToastGuard();
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

        try {
            chrome.runtime.sendMessage({
                type: "GENERATE_VOICE",
                text: cleanText
            }, (response) => {
                if (!this.active) return;
                if (chrome.runtime.lastError || !response || !response.success) {
                    console.error("Web Reader for VOICEVOX: 依頼失敗:",
                        chrome.runtime.lastError?.message || response?.error || "応答なし");
                    this.updateUIState('error');
                }
            });
        } catch (error) {
            // 拡張機能の更新・再読み込み直後は何もしない。
        }
    }

    // 再生の完全停止とキューのクリア要求
    stopAll() {
        try {
            chrome.runtime.sendMessage({ type: "STOP_ALL" }, () => { void chrome.runtime.lastError; });
        } catch (error) {
            // 拡張機能の更新・再読み込み直後は何もしない。
        }
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
