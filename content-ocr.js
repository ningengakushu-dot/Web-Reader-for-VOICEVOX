// ページ内範囲選択、DOMテキスト優先抽出、OCR依頼、進捗トーストを担当する。
(() => {
    const content = globalThis.VVRadioContent;
    if (!content || content.reuseExisting) return;
    const OCR_STALL_TIMEOUT_MS = content.OCR_STALL_TIMEOUT_MS;
    const createVvRadioUiHost = content.createVvRadioUiHost;

content.parts.ocr = {
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
        // 更新案内カードが出ていれば隠す。画面右下に固定表示されるため、選択範囲に
        // 入るとその文言までページ内テキスト抽出・キャプチャOCRで読み上げられてしまう。
        // 一回限りの案内なので消さずに隠し、選択の取り消し・読み上げ開始・OCR終了で戻す。
        this.setUpdateNoticeHidden(true);
        // オーバーレイへフォーカスを移す前の要素を控え、除去時に戻す
        // （入力中の欄からフォーカスを奪ったままにしない）。
        this.ocrPrevFocus = document.activeElement;

        const host = createVvRadioUiHost("vvradio-ocr-host");
        const parent = document.body || document.documentElement;
        if (!parent || typeof host.attachShadow !== "function") return;
        parent.appendChild(host);
        const root = host.attachShadow({ mode: "closed" });

        const style = document.createElement("style");
        style.textContent = `
            #vvradio-ocr-overlay {
                position: fixed; inset: 0; z-index: 2147483647;
                cursor: crosshair; user-select: none; outline: none;
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
            if (rect.width < 12 || rect.height < 12) {
                this.setUpdateNoticeHidden(false);
                return;
            }
            void this.startRegionReading(rect);
        };

        const onKeyDown = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                this.removeOcrOverlay();
                this.setUpdateNoticeHidden(false);
            }
        };

        overlay.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mousemove", onMouseMove, true);
        window.addEventListener("mouseup", onMouseUp, true);
        window.addEventListener("keydown", onKeyDown, true);
        // フォーカスがページ内の iframe（広告・埋め込み等）や入力欄にあると Esc は
        // そちらへ届き、案内文どおりにキャンセルできない。オーバーレイ自身に
        // フォーカスを移して受け取る（ページ側の入力欄へのキー入力も止まる）。
        overlay.tabIndex = -1;
        try { overlay.focus({ preventScroll: true }); } catch (e) { /* 対応外環境 */ }

        this.ocrOverlay = {
            host,
            cleanup: () => {
                window.removeEventListener("mousemove", onMouseMove, true);
                window.removeEventListener("mouseup", onMouseUp, true);
                window.removeEventListener("keydown", onKeyDown, true);
            }
        };
    },

    removeOcrOverlay() {
        if (!this.ocrOverlay) return;
        this.ocrOverlay.cleanup();
        this.ocrOverlay.host.remove();
        this.ocrOverlay = null;
        // オーバーレイに移していたフォーカスを元の要素へ戻す
        const prev = this.ocrPrevFocus;
        this.ocrPrevFocus = null;
        if (prev && prev !== document.body && prev.isConnected && typeof prev.focus === "function") {
            try { prev.focus({ preventScroll: true }); } catch (e) { /* 対応外の要素は無視 */ }
        }
    },

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
                result = await dom.collectRegionText(rect);
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
                this.setUpdateNoticeHidden(false);
                this.speakText(result.text);
                return;
            }
        }
        this.requestRegionOcr(rect);
    },

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
                    this.setUpdateNoticeHidden(false);
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
                    this.setUpdateNoticeHidden(false);
                    // 更新直後の古いcontent scriptは静かに停止する。
                }
            }, 60);
        }));
    },

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
    },

    clearOcrStallWatchdog() {
        if (this.ocrStallWatchdog) {
            clearTimeout(this.ocrStallWatchdog);
            this.ocrStallWatchdog = null;
        }
    },

    // OCRの進行状況・完了・エラーを示す小さなトースト表示。
    // actionLabel を渡すと、対処へ進むためのリンクを1つだけ添える
    // （エラーを行き止まりにしないため。トースト自体は pointer-events: none を保つ）。
    showOcrToast(text, actionLabel, onAction) {
        if (!this.shadowRoot) return;
        // 前のエラー表示に予約された自動消去が、今から出す表示（進行中のOCR等）を
        // 途中で消してしまわないよう、新しい表示のたびに予約を取り消す。
        this.clearOcrToastDismiss();
        if (!this.ocrToast) {
            const toast = document.createElement("div");
            toast.id = "vvradio-ocr-toast";
            toast.setAttribute("role", "status");
            toast.style.cssText = `
                position: fixed; bottom: 48px; right: 20px; z-index: 2147483647;
                background: rgba(29, 28, 29, 0.85); color: #fff;
                font: 12px 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                padding: 6px 12px; border-radius: 6px; pointer-events: none;
                max-width: 320px;
            `;
            this.shadowRoot.appendChild(toast);
            this.ocrToast = toast;
        }
        this.ocrToast.textContent = text;
        if (!actionLabel || typeof onAction !== "function") return;
        const action = document.createElement("span");
        action.setAttribute("role", "button");
        action.tabIndex = 0;
        action.textContent = actionLabel;
        action.style.cssText = `
            margin-left: 8px; color: #9ecbff; text-decoration: underline;
            cursor: pointer; pointer-events: auto;
        `;
        action.addEventListener("click", onAction);
        action.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAction(); }
        });
        this.ocrToast.appendChild(action);
    },

    // 拡張機能のオプション画面を開く。VOICEVOX未起動のときに、
    // エンジンだけを常駐させる手順へ辿り着けるようにするための導線。
    openOptionsPage() {
        try {
            if (!chrome.runtime?.id) return;
            chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }, () => {
                void chrome.runtime.lastError;
            });
        } catch (error) {
            // 更新・再読み込み直後の古いcontent scriptでは何もしない。
        }
    },

    updateOcrToast(text) {
        if (this.ocrToast) this.showOcrToast(text);
    },

    // キャプチャ後の「時間がかかっています」表示を出す予約を取り消す
    clearOcrToastGuard() {
        if (this.ocrToastGuard) {
            clearTimeout(this.ocrToastGuard);
            this.ocrToastGuard = null;
        }
    },

    removeOcrToast() {
        this.clearOcrStallWatchdog();
        this.clearOcrToastGuard();
        this.clearOcrToastDismiss();
        if (this.ocrToast) {
            this.ocrToast.remove();
            this.ocrToast = null;
        }
    },

    // エラー等の表示を一定時間後に消す予約。追跡せずに setTimeout すると、
    // その間に始まった次のOCRの進捗表示と見張りタイマーまで巻き添えで消し、
    // 認識が途絶えても何も表示されないまま終わる（発火時点で何が表示中かを見ないため）。
    scheduleOcrToastDismiss(delayMs) {
        this.clearOcrToastDismiss();
        this.ocrToastDismissTimer = setTimeout(() => {
            this.ocrToastDismissTimer = null;
            this.removeOcrToast();
        }, delayMs);
    },

    clearOcrToastDismiss() {
        if (this.ocrToastDismissTimer) {
            clearTimeout(this.ocrToastDismissTimer);
            this.ocrToastDismissTimer = null;
        }
    },

    // 合成・再生の失敗をトーストで明示する。アイコンの状態変化だけでは
    // 「何も起きない」ように見えるため（VOICEVOX未起動が典型例）。
    showPlaybackErrorToast(error) {
        // タイムアウト時の文言（constants.js の「…応答しません」）も同じ案内にする。
        // 従来はここに当たらず「音声の再生に失敗しました: 合成失敗: …」と内部表現が出ていた。
        const isConnectionError = /Failed to fetch|NetworkError|ERR_CONNECTION|応答しません/i.test(error || "");
        const message = isConnectionError
            ? "VOICEVOXエンジンに接続できません。VOICEVOXを起動してから再度お試しください。"
            : `音声の再生に失敗しました: ${error || "不明なエラー"}`;
        if (isConnectionError) {
            // 起動方法へ辿り着けるよう導線を添える。読む時間が要るぶん表示も長くする。
            this.showOcrToast(message, "起動方法を見る", () => this.openOptionsPage());
            this.scheduleOcrToastDismiss(12000);
            return;
        }
        this.showOcrToast(message);
        this.scheduleOcrToastDismiss(6000);
    },

    handleOcrStatus(request) {
        // 撮影のために隠したインジケーター・更新案内を、どの終了経路でも確実に復帰させる。
        if (this.indicator) this.indicator.style.visibility = "";
        this.setUpdateNoticeHidden(false);
        this.clearOcrStallWatchdog();
        this.clearOcrToastGuard();
        if (request.status === "error") {
            this.showOcrToast(request.message || "文字認識に失敗しました。");
            this.updateUIState('error');
            this.scheduleOcrToastDismiss(4000);
        } else {
            // 完了: 読み上げが始まると PLAYBACK_STARTED でインジケーターが点灯する
            this.removeOcrToast();
        }
    }
};
})();
