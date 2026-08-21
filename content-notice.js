// 既存ユーザー向け更新案内の取得・表示・一時非表示を担当する。
(() => {
    const content = globalThis.VVRadioContent;
    if (!content || content.reuseExisting) return;
    const createVvRadioUiHost = content.createVvRadioUiHost;

content.parts.notice = {
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
    },

    // アップデートお知らせモーダルの表示
    showUpdateNoticeModal() {
        if (document.getElementById("vvradio-update-notice-host")) return;

        const host = createVvRadioUiHost("vvradio-update-notice-host");
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
    },

    // 更新案内カードの一時的な非表示（範囲読み上げの対象・キャプチャに写さないため）
    setUpdateNoticeHidden(hidden) {
        const notice = document.getElementById("vvradio-update-notice-host");
        if (notice) notice.style.visibility = hidden ? "hidden" : "";
    }
};
})();
