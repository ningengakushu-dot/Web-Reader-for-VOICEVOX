// ページ右下インジケーターの見た目・ドラッグ・状態表示を担当する。
(() => {
    const content = globalThis.VVRadioContent;
    if (!content || content.reuseExisting) return;
    const INDICATOR_DEFAULT_TITLE = content.INDICATOR_DEFAULT_TITLE;
    const createVvRadioUiHost = content.createVvRadioUiHost;

content.parts.indicator = {
    // アイコンのサイズと見た目をストレージから読み込んで適用し、変更をリアルタイムに反映する
    // （content script は constants.js を読み込まないため、キー名と既定値は直値で持つ）
    applyIconAppearance() {
        const keys = ["iconSize", "iconStyle", "vv_character_icon", "vv_custom_icon"];
        chrome.storage.local.get(keys, (res) => {
            if (!this.active || !this.indicator || chrome.runtime.lastError) return;
            this.applyIndicatorSize(res.iconSize || 32);
            this.applyIndicatorStyle(res);
        });

        this.addStorageListener((changes, namespace) => {
            // deactivate 済み（stale）インスタンスや、インジケーター未生成のフレームでは
            // detached になった indicator を触らないよう早期に抜ける。
            if (!this.active || !this.indicator) return;
            if (namespace !== 'local') return;

            // サイズのリアルタイム反映
            if (changes.iconSize) {
                this.applyIndicatorSize(changes.iconSize.newValue || 32);
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
    },

    // アイコンの一辺のサイズを適用する。
    // キャラクター名の文字表示は円に内接させたいので、文字サイズも連動させる。
    applyIndicatorSize(size) {
        const numeric = Number(size);
        const safeSize = Number.isFinite(numeric) ? Math.min(128, Math.max(16, numeric)) : 32;
        this.indicator.style.width = `${safeSize}px`;
        this.indicator.style.height = `${safeSize}px`;
        this.indicator.style.fontSize = `${Math.max(8, Math.round(safeSize * 0.62))}px`;
    },

    // アイコンの見た目（従来の円／拡張機能のアイコン／読み上げキャラクター／
    // 利用者がアップロードした画像）を適用する。
    // 画像・文字の指定が欠けている場合は、必ず従来の円にフォールバックする。
    applyIndicatorStyle(res) {
        const el = this.indicator;
        el.classList.remove('image', 'text');
        el.style.backgroundImage = '';
        el.textContent = '';
        // 既定の円でも、ホバーで何のアイコンか分かるようにしておく（初回利用者向け）。
        el.title = INDICATOR_DEFAULT_TITLE;
        el.setAttribute("aria-label", INDICATOR_DEFAULT_TITLE);

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
            el.title = `${name} — ${INDICATOR_DEFAULT_TITLE}`;
            el.setAttribute("aria-label", el.title);
            if (safeRasterDataUrl(character.dataUrl)) {
                asImage(character.dataUrl);
            } else {
                // 画像の利用許諾が確認できないキャラクターは名前の頭文字で表示する。
                el.classList.add('text');
                el.textContent = name.slice(0, 1);
            }
        }
    },

    // 画面にインジケーターアイコンを注入
    injectIndicator() {
        // 再注入時に古いホストが残っていると UI が二重化するため、生成前に除去する。
        const stale = document.getElementById("vvradio-host");
        if (stale) stale.remove();

        const host = createVvRadioUiHost("vvradio-host");
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
        // 支援技術向けに役割と説明を付ける（tabindex は付けず、全ページのタブ順に
        // 余分な停止点を増やさない。キーボード操作はショートカットで行える）。
        this.indicator.setAttribute("role", "button");
        this.indicator.setAttribute("aria-label", INDICATOR_DEFAULT_TITLE);
        this.indicator.title = INDICATOR_DEFAULT_TITLE;

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
    },

    // インジケーターのスタイル定義を作る。
    // ページ側のCSSと干渉しないよう Shadow DOM の中だけで完結させる。
    createIndicatorStyle() {
        const style = document.createElement("style");
        style.textContent = `
            #vvradio-indicator {
                position: fixed; bottom: 20px; right: 20px; width: 32px; height: 32px;
                background-color: #3498db; border-radius: 50%; z-index: 2147483647;
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
    },

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
            window.removeEventListener("blur", onMouseUp);

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
            // ドラッグ中にウィンドウが非アクティブになる（Alt+Tab 等）と mouseup が
            // 届かず、アイコンがカーソルに貼り付いたままになるため、ここでも終了する。
            window.addEventListener("blur", onMouseUp);
        });

        return () => dragMoved;
    },

    // 保存された位置があれば復元する
    restoreIndicatorPosition() {
        chrome.storage.local.get(["vvradio_icon_pos", "iconSize"], (res) => {
            if (!this.active || !this.indicator || chrome.runtime.lastError) return;
            if (res.vvradio_icon_pos) {
                const left = Number(res.vvradio_icon_pos.left);
                const top = Number(res.vvradio_icon_pos.top);
                if (!Number.isFinite(left) || !Number.isFinite(top)) return;
                const rawSize = Number(res.iconSize);
                const size = Number.isFinite(rawSize) ? Math.min(128, Math.max(16, rawSize)) : 32;
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
    },

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
};
})();
