// 画面OCR読み上げページ:
// background から storage.session 経由で受け取ったキャプチャ画像を表示し、
// ドラッグ選択された範囲を同梱の Tesseract.js（WASM・完全ローカル動作）でOCRして、
// 既存の GENERATE_VOICE パイプライン（background → offscreen → VOICEVOX）で読み上げる。

// キャプチャ画像の受け渡しキー CAPTURE_STORAGE_KEY は constants.js で、
// OCRワーカー生成・画像切り出し・テキスト整形は ocr-common.js で定義（いずれも先行読み込み）。
(() => {
    // これ未満（表示px）のドラッグはクリック操作とみなして無視する
    const MIN_SELECTION_SIZE = 12;
    const CAPTURE_MAX_AGE_MS = 5 * 60 * 1000;

    const image = document.getElementById("capture-image");
    const container = document.getElementById("capture-container");
    const selectionBox = document.getElementById("selection-box");
    const ocrAllBtn = document.getElementById("ocr-all-btn");
    const ocrStatus = document.getElementById("ocr-status");
    const ocrProgress = document.getElementById("ocr-progress");
    const resultText = document.getElementById("result-text");
    const speakBtn = document.getElementById("speak-btn");
    const stopBtn = document.getElementById("stop-btn");
    const playbackStatus = document.getElementById("playback-status");
    const banner = document.getElementById("banner");
    const sourceInfo = document.getElementById("source-info");

    // OCRの世代トークン。実行中に新しい選択が行われた場合、古い結果を破棄する。
    let ocrGeneration = 0;

    function sendRuntimeMessage(message, callback) {
        try {
            if (!chrome.runtime?.id) return false;
            chrome.runtime.sendMessage(message, callback);
            return true;
        } catch (error) {
            return false;
        }
    }
    let ocrInProgress = false;

    // 組版方向（横書き jpn / 縦書き jpn_vert）ごとのワーカーを使い回す。
    // 生成処理（同梱アセットの指定・タイムアウト保護）と使い回しの管理は
    // ocr-common.js の createOcrWorkerPool に集約している。
    const workers = createOcrWorkerPool((m) => {
        if (m.status === "recognizing text") {
            ocrProgress.value = m.progress;
        }
    });
    const getWorker = workers.get;
    // ワーカーを破棄する（ページ離脱時・認識タイムアウト時）。
    const terminateWorkers = workers.terminate;

    // --- 初期化 ---

    document.addEventListener("DOMContentLoaded", () => {
        loadCapture();
        checkVoicevoxConnection();
    });

    // background が保存したキャプチャ画像を storage.session から読み込む
    async function loadCapture() {
        const captureId = new URLSearchParams(location.search).get("cid");
        if (!captureId) {
            showBanner("キャプチャ情報が見つかりません。元のページからもう一度実行してください。");
            return;
        }

        try {
            const stored = await chrome.storage.session.get(CAPTURE_STORAGE_KEY);
            const capture = stored[CAPTURE_STORAGE_KEY];
            if (!capture || !capture.dataUrl) {
                showBanner("キャプチャ画像が見つかりません（このタブの再読み込み、またはブラウザの再起動で破棄されています）。元のページからもう一度実行してください。");
                return;
            }
            const createdAt = Number(capture.createdAt);
            if (!Number.isFinite(createdAt) || Date.now() - createdAt > CAPTURE_MAX_AGE_MS) {
                await chrome.storage.session.remove(CAPTURE_STORAGE_KEY).catch(() => {});
                showBanner("キャプチャ情報の有効期限が切れました。元のページからもう一度実行してください。");
                return;
            }
            // 固定キーは常に最新のキャプチャで上書きされるため、このタブが対象とする
            // captureId と一致しない場合（古いタブの再読み込み等）は明示的に案内する。
            if (capture.captureId !== captureId) {
                showBanner("このタブのキャプチャは新しいキャプチャで置き換えられたため表示できません。元のページからもう一度実行してください。");
                return;
            }

            image.addEventListener("load", () => {
                // 画像の準備ができたらOCRエンジン（横書き）を先行初期化しておく
                // （初回の認識開始までの待ち時間を短縮するため）
                getWorker("jpn").catch((err) => {
                    showBanner(`文字認識エンジンの初期化に失敗しました: ${err.message}`);
                });
            }, { once: true });
            image.src = capture.dataUrl;
            // 画像はこのタブが保持したので、セッションストレージからは直ちに消す。
            // 画面全体のスクリーンショットを、必要が無くなった後もブラウザ終了まで
            // 残しておかないため（このタブを再読み込みすると失われるが、
            // 元のページから実行し直せば取り直せる）。
            chrome.storage.session.remove(CAPTURE_STORAGE_KEY).catch(() => {});

            const source = capture.sourceTitle || capture.sourceUrl;
            if (source) {
                sourceInfo.textContent = `取得元: ${source}`;
                sourceInfo.title = capture.sourceUrl || "";
            }
        } catch (err) {
            showBanner(`キャプチャ画像の読み込みに失敗しました: ${err.message}`);
        }
    }

    // VOICEVOXエンジンへの接続を確認し、未起動なら警告を表示する（読み上げ時の躓き防止）
    function checkVoicevoxConnection() {
        const sent = sendRuntimeMessage({ type: "CHECK_CONNECTION" }, (res) => {
            if (chrome.runtime.lastError || !res || !res.success) {
                showBanner("VOICEVOXエンジンに接続できません。読み上げにはVOICEVOXの起動が必要です（OCRは利用できます）。");
            }
        });
        if (!sent) showBanner("拡張機能が更新されました。このタブを再読み込みしてください。");
    }

    function showBanner(message) {
        banner.textContent = message;
        banner.hidden = false;
    }

    // ページを離れるときにワーカーを破棄する
    window.addEventListener("pagehide", terminateWorkers);

    // --- 範囲選択（ドラッグ） ---

    let dragState = null;

    container.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (!image.complete || !image.naturalWidth) return;
        e.preventDefault();

        const rect = image.getBoundingClientRect();
        dragState = {
            rect,
            startX: clamp(e.clientX - rect.left, 0, rect.width),
            startY: clamp(e.clientY - rect.top, 0, rect.height),
            moved: false
        };

        document.addEventListener("mousemove", onDragMove);
        document.addEventListener("mouseup", onDragEnd);
    });

    function onDragMove(e) {
        if (!dragState) return;
        const sel = currentSelection(e);
        if (sel.width >= 2 || sel.height >= 2) dragState.moved = true;
        renderSelectionBox(sel);
    }

    function onDragEnd(e) {
        if (!dragState) return;
        document.removeEventListener("mousemove", onDragMove);
        document.removeEventListener("mouseup", onDragEnd);

        const sel = currentSelection(e);
        const state = dragState;
        dragState = null;

        // クリック（微小ドラッグ）は選択解除として扱う
        if (!state.moved || sel.width < MIN_SELECTION_SIZE || sel.height < MIN_SELECTION_SIZE) {
            selectionBox.hidden = true;
            return;
        }

        runOcr(sel);
    }

    // ドラッグ中のマウス位置から表示座標系の選択矩形を計算する
    function currentSelection(e) {
        const rect = dragState.rect;
        const curX = clamp(e.clientX - rect.left, 0, rect.width);
        const curY = clamp(e.clientY - rect.top, 0, rect.height);
        return {
            x: Math.min(dragState.startX, curX),
            y: Math.min(dragState.startY, curY),
            width: Math.abs(curX - dragState.startX),
            height: Math.abs(curY - dragState.startY)
        };
    }

    function renderSelectionBox(sel) {
        selectionBox.style.left = `${sel.x}px`;
        selectionBox.style.top = `${sel.y}px`;
        selectionBox.style.width = `${sel.width}px`;
        selectionBox.style.height = `${sel.height}px`;
        selectionBox.hidden = false;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    // 画像全体をOCRするボタン
    ocrAllBtn.addEventListener("click", () => {
        if (!image.complete || !image.naturalWidth) return;
        const rect = image.getBoundingClientRect();
        renderSelectionBox({ x: 0, y: 0, width: rect.width, height: rect.height });
        runOcr({ x: 0, y: 0, width: rect.width, height: rect.height });
    });

    // --- OCR実行 ---

    async function runOcr(displaySel) {
        // 表示座標 → 実画像座標へ変換（画像は max-width:100% で縮小表示されるため）
        const rect = image.getBoundingClientRect();
        const scaleX = image.naturalWidth / rect.width;
        const scaleY = image.naturalHeight / rect.height;

        const sx = clamp(Math.round(displaySel.x * scaleX), 0, image.naturalWidth - 1);
        const sy = clamp(Math.round(displaySel.y * scaleY), 0, image.naturalHeight - 1);
        const sw = clamp(Math.round(displaySel.width * scaleX), 1, image.naturalWidth - sx);
        const sh = clamp(Math.round(displaySel.height * scaleY), 1, image.naturalHeight - sy);

        const canvas = cropToOcrCanvas(image, sx, sy, sw, sh);

        const generation = ++ocrGeneration;
        // Tesseractワーカーは同一ワーカー上の並行recognizeに対応しないため、
        // 新しい選択を優先するときは前のワーカーを破棄して競合を防ぐ。
        if (ocrInProgress) terminateWorkers();
        ocrInProgress = true;
        setOcrStatus("文字認識を実行中...");
        ocrProgress.value = 0;
        ocrProgress.hidden = false;

        try {
            // 組版方向（横書き/縦書き）を自動判定して認識する。
            // 認識がハングしても「実行中」表示が残らないようタイムアウトで打ち切る。
            const data = await withOcrTimeout(
                recognizeWithOrientation(canvas, getWorker),
                OCR_RECOGNIZE_TIMEOUT_MS,
                "文字認識に時間がかかりすぎました。範囲を狭めてお試しください。"
            );
            // 実行中に新しい選択が始まっていたら、この結果は破棄する
            if (generation !== ocrGeneration) return;

            const text = normalizeOcrText(data.text);
            if (!text) {
                setOcrStatus("文字を認識できませんでした。範囲を変えてお試しください。", true);
                return;
            }

            resultText.value = text;
            setOcrStatus(`認識が完了しました（信頼度: ${Math.round(data.confidence)}%）`);
        } catch (err) {
            if (generation !== ocrGeneration) return;
            console.error("Capture: OCR失敗:", err);
            // タイムアウトはワーカーがハングした可能性が高いため破棄して作り直させる
            if (err && err.isOcrTimeout) terminateWorkers();
            setOcrStatus(`文字認識に失敗しました: ${err.message}`, true);
        } finally {
            if (generation === ocrGeneration) {
                ocrInProgress = false;
                ocrProgress.hidden = true;
            }
        }
    }

    function setOcrStatus(message, isError = false) {
        ocrStatus.textContent = message;
        ocrStatus.classList.toggle("error", isError);
    }

    // --- 読み上げ ---

    speakBtn.addEventListener("click", () => {
        const text = cleanForSpeech(resultText.value);
        if (!text) {
            setPlaybackStatus("読み上げるテキストがありません。", "error");
            return;
        }

        const sent = sendRuntimeMessage({ type: "GENERATE_VOICE", text }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
                const reason = chrome.runtime.lastError?.message || response?.error || "応答なし";
                setPlaybackStatus(`読み上げの開始に失敗しました: ${reason}`, "error");
            }
        });
        if (!sent) setPlaybackStatus("拡張機能が更新されました。このタブを再読み込みしてください。", "error");
    });

    stopBtn.addEventListener("click", () => {
        const sent = sendRuntimeMessage({ type: "STOP_ALL" }, () => { void chrome.runtime.lastError; });
        setPlayingState(false);
        setPlaybackStatus(sent ? "停止しました。" : "拡張機能が更新されました。このタブを再読み込みしてください。",
            sent ? "" : "error");
    });

    // background から転送される再生状態（target:'tab'）を反映する。
    // offscreen が全拡張ページへブロードキャストする通知（target:'background'）は
    // background 経由の転送と二重になるため、ここでは処理しない。
    chrome.runtime.onMessage.addListener((request) => {
        if (request.target !== "tab") return;

        switch (request.type) {
            case "PLAYBACK_STARTED":
                setPlayingState(true);
                setPlaybackStatus("再生中...", "playing");
                break;
            case "PLAYBACK_ENDED":
                setPlayingState(false);
                setPlaybackStatus("再生が完了しました。");
                break;
            case "PLAYBACK_STOPPED":
                setPlayingState(false);
                setPlaybackStatus("停止しました。");
                break;
            case "PLAYBACK_ERROR":
                setPlayingState(false);
                setPlaybackStatus(`再生エラー: ${request.error || "不明なエラー"}`, "error");
                break;
        }
    });

    function setPlayingState(playing) {
        stopBtn.disabled = !playing;
    }

    function setPlaybackStatus(message, state = "") {
        playbackStatus.textContent = message;
        playbackStatus.classList.remove("playing", "error");
        if (state) playbackStatus.classList.add(state);
    }
})();
