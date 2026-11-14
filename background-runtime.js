// 複数タブからの同時表示権要求を Promise チェーンで直列化し、1回のみ true を返す
let updateNoticeQueue = Promise.resolve();

function claimUpdateNotice() {
    const next = updateNoticeQueue.then(() => new Promise((resolve) => {
        if (!chrome.storage?.local) {
            resolve({ shouldShow: false });
            return;
        }
        chrome.storage.local.get(["update_notice_pending"], (res) => {
            if (chrome.runtime.lastError || !res || !res.update_notice_pending) {
                resolve({ shouldShow: false });
                return;
            }
            chrome.storage.local.set({ update_notice_pending: false }, () => {
                if (chrome.runtime.lastError) {
                    resolve({ shouldShow: false });
                    return;
                }
                resolve({ shouldShow: true });
            });
        });
    })).catch(() => ({ shouldShow: false }));

    updateNoticeQueue = next.catch(() => {});
    return next;
}

// ローカルのVOICEVOX互換APIが予期しないJSONを返しても、拡張ページへ巨大・不正な
// オブジェクトを渡さないよう、設定画面で必要な項目だけへ正規化する。
function normalizeSpeakerList(value) {
    if (!Array.isArray(value)) throw new Error("キャラクター一覧の形式が不正です");
    const speakers = [];
    for (const speaker of value.slice(0, 1000)) {
        if (!speaker || typeof speaker.name !== "string" || !Array.isArray(speaker.styles)) continue;
        const name = speaker.name.trim().slice(0, 100);
        if (!name) continue;
        const styles = [];
        for (const style of speaker.styles.slice(0, 1000)) {
            const id = Number(style?.id);
            if (!Number.isInteger(id) || id < 0 || id > 1000000) continue;
            const styleName = typeof style?.name === "string" ? style.name.trim().slice(0, 100) : "";
            styles.push({ id, name: styleName });
        }
        if (styles.length) {
            speakers.push({
                name,
                speaker_uuid: typeof speaker.speaker_uuid === "string"
                    ? speaker.speaker_uuid.slice(0, 200) : "",
                styles
            });
        }
    }
    if (!speakers.length) throw new Error("利用可能なキャラクターが見つかりません");
    return speakers;
}

// 音声の開始・停止要求を到着順に処理する。複数タブから同時に要求された場合でも、
// 「既存再生停止 → 宛先切替 → 新規キュー追加」の順序が交差しないようにする。
let voiceOperationQueue = Promise.resolve();
const pendingVoiceStarts = new Map();
const pendingVoiceStops = new Map();
function enqueueVoiceOperation(operation) {
    const next = voiceOperationQueue.then(operation);
    voiceOperationQueue = next.catch(() => {});
    return next;
}

// Content Scriptからのメッセージを処理するリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.target && request.target !== 'background') return;
    const security = globalThis.VVRadioBackgroundSecurity;
    if (security) {
        const checked = security.validateRequest(request, sender);
        if (!checked.ok) {
            sendResponse(security.invalidResponse(request?.type, checked.error));
            return false;
        }
        request = checked.request;
    }
    // target:'background' は offscreen ドキュメントからの通知（PLAYBACK_* / OCR_*）に限る。
    // 送信元が offscreen.html であることを確認し、他コンテキストからの偽装を排除する（多層防御）。
    // content script/拡張ページからの要求は target を付けず、sender.tab で正しく扱っている。
    if (request.target === 'background'
        && sender.url !== chrome.runtime.getURL('offscreen.html')) {
        return;
    }

    switch (request.type) {
        case "CLAIM_UPDATE_NOTICE": {
            // タブのトップフレーム (frameId === undefined || frameId === 0) からの要求のみ許可する
            const isTopFrame = sender?.tab != null && (sender.frameId === undefined || sender.frameId === 0);
            if (!isTopFrame) {
                sendResponse({ shouldShow: false });
                return false;
            }
            claimUpdateNotice()
                .then(res => sendResponse(res))
                .catch(() => sendResponse({ shouldShow: false }));
            return true;
        }
        case "SHORTCUT_PRESSED":
            // content.js の trusted keydown フォールバックからの要求。
            // commands.onCommand と同じ共通処理に集約する。
            handleShortcutRequest(sender.tab?.id, "content.SHORTCUT_PRESSED")
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;

        case "TOGGLE_READING_REQUEST":
            respondWith(dispatchToggleReading(sender.tab?.id), sendResponse);
            return true;

        case "SELECTION_REQUIRED":
            respondWith(chrome.tabs.sendMessage(sender.tab.id,
                { type: "SELECTION_REQUIRED" }, { frameId: 0 }), sendResponse);
            return true;

        case "SELECTION_READING_ERROR":
            respondWith(chrome.tabs.sendMessage(sender.tab.id,
                { type: "SELECTION_READING_ERROR", error: request.error }, { frameId: 0 }), sendResponse);
            return true;

        case "OPEN_OPTIONS":
            respondWith(chrome.runtime.openOptionsPage(), sendResponse);
            return true;

        case "CHECK_CONNECTION":
            respondWith(
                fetchWithTimeout(`${VOICEVOX_BASE_URL}/version`, {}, VOICEVOX_FETCH_TIMEOUT_MS)
                    .then((res) => {
                        const cancellation = res.body?.cancel?.();
                        cancellation?.catch?.(() => {});
                        return res.ok;
                    }),
                sendResponse,
                (ok) => ({ success: ok }));
            return true;

        case "GET_SPEAKERS":
            respondWith(
                fetchWithTimeout(`${VOICEVOX_BASE_URL}/speakers`, {}, VOICEVOX_FETCH_TIMEOUT_MS)
                    .then((res) => {
                        if (!res.ok) throw new Error(`キャラクター一覧の取得に失敗しました (${res.status})`);
                        return readJsonResponseWithLimit(res).then(normalizeSpeakerList);
                    }),
                sendResponse,
                (speakers) => ({ success: true, speakers }));
            return true;

        case "GET_SPEAKER_ICON":
            // 設定画面のページ内アイコン表示用。VOICEVOXエンジンは拡張機能の
            // オリジンからしか叩けないため、取得は background に集約する。
            respondWith(
                fetchSpeakerIcon(request.speakerId),
                sendResponse,
                (result) => ({ success: true, ...result }));
            return true;

        case "GENERATE_VOICE":
            // 新しい読み上げの開始は、そのタブで進行中の範囲OCRを無効化する
            // （古い認識結果が後から届いてこの読み上げを中断しないように）。
            invalidatePendingOcr(sender.tab?.id);
            queueVoiceStart(request.text, sender.tab?.id ?? null,
                sender.frameId === 0 ? sender.documentId : undefined).then(sendResponse);
            return true;

        case "STOP_ALL":
            // 停止はそのタブで進行中の範囲OCRも取り消す（完了後に勝手に読み上げを始めない）。
            respondWith(stopAllForTab(sender.tab?.id ?? null), sendResponse);
            return true;

        case "PLAYBACK_PAGE_HIDDEN":
            respondWith(Promise.resolve(stopPlaybackForTab(sender.tab.id, sender.documentId)), sendResponse);
            return true;

        case "PLAYBACK_PAGE_READY":
            respondWith(stopPlaybackFromPreviousDocument(sender.tab.id, sender.documentId), sendResponse);
            return true;

        case "CAPTURE_OCR_REGION": {
            // ページ内オーバーレイで選択された範囲のキャプチャ→OCR開始要求
            const tab = sender.tab;
            if (!tab || tab.id == null) {
                sendResponse({ success: false, error: "要求元タブを特定できません" });
                return false;
            }
            captureAndRecognizeRegion(request, tab, sender.documentId)
                .then(() => sendResponse({ success: true }))
                .catch((err) => {
                    if (err.code !== "CAPTURE_TARGET_CHANGED") {
                        console.warn("Background: 範囲OCRの開始に失敗:", err.message);
                    }
                    // captureVisibleTab には毎秒の呼び出し回数制限がある。連続実行で踏んだ場合は
                    // 生のエラー文言だと利用者が対処できないため、原因の分かる案内に差し替える。
                    const message = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(err.message)
                        ? "短い間隔で連続して実行されました。少し待ってからもう一度お試しください。"
                        : err.message;
                    sendResponse({ success: false, error: message });
                });
            return true;
        }

        case "OCR_PROGRESS":
            // offscreen からのOCR進行状況を要求元タブへ転送する
            notifyTab(request.tabId, { type: "OCR_PROGRESS", progress: request.progress });
            return false;

        case "OCR_COMPLETE": {
            // offscreen でのOCR完了。認識テキストを既存の読み上げパイプラインへ流す。
            const tabId = request.tabId ?? null;
            // 選び直し・停止・別の読み上げ開始で古くなった要求の結果は使わない。
            if (consumeStaleOcrCompletion(tabId, request.requestId)) return false;
            if (request.error || !request.text) {
                notifyTab(tabId, {
                    type: "OCR_STATUS",
                    status: "error",
                    message: request.error || "文字を認識できませんでした。"
                }, "OCRエラー通知の送信失敗");
                return false;
            }
            notifyTab(tabId, { type: "OCR_STATUS", status: "done" });
            queueVoiceStart(request.text, tabId).then((res) => {
                if (!res.success) {
                    notifyTab(tabId, {
                        type: "OCR_STATUS", status: "error",
                        message: `読み上げを開始できませんでした: ${res.error}`
                    }, "読み上げ開始エラー通知の送信失敗");
                }
            });
            return false;
        }

        case "PLAYBACK_STARTED":
        case "PLAYBACK_ENDED":
        case "PLAYBACK_ERROR":
            // 停止中に発生したイベントで停止結果を上書きしない。
            enqueueVoiceOperation(() => forwardPlaybackEvent(request)).catch(warn("再生状態の転送失敗"));
            return false;
    }

    return false;
});

chrome.runtime.onConnect?.addListener(port => {
    if (!port.name.startsWith("playback-lifetime:") || port.sender?.id !== chrome.runtime.id
        || port.sender.url !== chrome.runtime.getURL("offscreen.html") || port.sender.tab) return;
    // Chrome は Offscreen からの Port の sender に documentId を付けない。
    // URLで送信元を確認し、Chromeが列挙した文書IDと照合する。
    const documentId = port.name.slice("playback-lifetime:".length);
    if (!documentId) return;
    port.onDisconnect.addListener(() => {
        enqueueVoiceOperation(async () => {
            const owner = await getPlaybackOwner();
            if (!owner || owner.offscreenDocumentId !== documentId) return;
            if (owner.stopFailed) return;
            // SW 再起動やポート切断だけでは、再生中の Offscreen を失ったと判断しない。
            const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
            if (contexts.some(context => context.documentId === documentId)) return;
            await setPlaybackOwner(null);
            if (!pendingVoiceStarts.has(owner.tabId) && !pendingVoiceStops.has(owner.tabId)) {
                notifyVoiceRequest(owner, "PLAYBACK_ERROR", {
                    terminal: true, error: "音声処理画面が閉じました。もう一度読み上げを開始してください。"
                });
            }
        }).catch(warn("音声処理画面の終了確認失敗"));
    });
});

async function forwardPlaybackEvent(message) {
    const owner = await getPlaybackOwner();
    if (!owner || owner.requestId !== message.requestId || owner.stopFailed) return;
    if (message.type === "PLAYBACK_ENDED" || message.terminal === true) await setPlaybackOwner(null);
    if (!pendingVoiceStarts.has(owner.tabId) && !pendingVoiceStops.has(owner.tabId)) {
        notifyTab(owner.tabId, { ...message, requestId: owner.uiRequestId ?? owner.requestId }, "再生状態の転送失敗");
    }
}

function notifyVoiceRequest(owner, type, details) {
    if (owner) notifyTab(owner.tabId, { type, requestId: owner.uiRequestId ?? owner.requestId, ...details });
}

function queueVoiceStart(text, tabId, documentId) {
    const start = { tabId, requestId: crypto.randomUUID(), documentId, cancelled: false };
    pendingVoiceStarts.set(tabId, start);
    notifyVoiceRequest(start, "PLAYBACK_PREPARING");
    const isCurrent = () => !start.cancelled && pendingVoiceStarts.get(tabId) === start;
    const cancelled = { success: true, cancelled: true };

    return enqueueVoiceOperation(async () => {
        try {
            if (!isCurrent()) return cancelled;
            const result = await chrome.storage.local.get(Object.keys(SETTING_DEFAULTS));
            if (!isCurrent()) return cancelled;
            const settings = { ...SETTING_DEFAULTS, ...result };
            const chunks = splitText(text);
            if (chunks.length === 0) throw new Error("読み上げられる文字がありません");

            if (tabId != null && !start.documentId) {
                // 子フレームの選択や OCR も、タブのメイン文書の寿命に従う。
                const frames = await chrome.scripting.executeScript({
                    target: { tabId, frameIds: [0] }, func: () => true
                }).catch(() => []);
                start.documentId = frames?.[0]?.documentId;
                if (!isCurrent()) return cancelled;
            }

            await setupOffscreen();
            if (!isCurrent()) return cancelled;
            const previous = await getPlaybackOwner();
            if (!isCurrent()) return cancelled;
            try {
                await sendToOffscreen({ type: "STOP_AUDIO" });
            } catch (err) {
                const error = await recordVoiceStopFailure(previous, start, err);
                if (previous?.tabId === tabId && isCurrent()) {
                    notifyVoiceRequest(start, "PLAYBACK_STOP_FAILED", { error });
                    return { success: false, error, reported: true };
                }
                throw new Error(error);
            }
            if (previous) {
                await setPlaybackOwner(null);
                if (!pendingVoiceStarts.has(previous.tabId) && !pendingVoiceStops.has(previous.tabId)) {
                    notifyVoiceRequest(previous, "PLAYBACK_STOPPED");
                }
            }
            if (!isCurrent()) return cancelled;

            // Offscreen が応答前に再生通知を送っても、この要求の宛先を復元できるようにする。
            const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
            if (!isCurrent()) return cancelled;
            const offscreenDocumentId = contexts[0]?.documentId;
            await setPlaybackOwner({ tabId, requestId: start.requestId, documentId: start.documentId,
                offscreenDocumentId });
            if (!isCurrent()) return cancelled;
            await sendToOffscreen({ type: "ENQUEUE_TEXTS", texts: chunks, settings, requestId: start.requestId,
                offscreenDocumentId });
            return isCurrent() ? { success: true } : cancelled;
        } catch (err) {
            if (playbackOwner?.requestId === start.requestId) await setPlaybackOwner(null);
            if (!isCurrent()) return cancelled;
            const error = err?.message || "読み上げを開始できませんでした";
            const oldVoiceActive = playbackOwner?.tabId === tabId;
            if (oldVoiceActive) await setPlaybackOwner({ ...playbackOwner, uiRequestId: start.requestId });
            if (!isCurrent()) return cancelled;
            notifyVoiceRequest(start, "PLAYBACK_START_FAILED", { error, oldVoiceActive });
            console.error("Background: 準備エラー:", err);
            return { success: false, error, reported: tabId != null };
        } finally {
            if (pendingVoiceStarts.get(tabId) === start && !start.cancelled) pendingVoiceStarts.delete(tabId);
        }
    });
}

function stopAllForTab(tabId) {
    invalidatePendingOcr(tabId);
    return queueVoiceStop(tabId);
}

async function recordVoiceStopFailure(owner, target, error) {
    const reason = error?.message || "読み上げを停止できませんでした";
    if (owner) {
        const uiRequestId = target?.tabId === owner.tabId ? target.requestId : owner.uiRequestId;
        await setPlaybackOwner({ ...owner, stopFailed: true, uiRequestId });
    }
    return reason;
}

function queueVoiceStop(tabId, { navigating = false, documentId } = {}) {
    const start = pendingVoiceStarts.get(tabId);
    if (documentId && start?.documentId && start.documentId !== documentId) return Promise.resolve();
    const existing = pendingVoiceStops.get(tabId);
    if (existing && existing.start === start) {
        existing.navigating ||= navigating;
        return existing.operation;
    }
    // 初期化中でも、停止の受付以降は取り消した要求を Offscreen に渡さない。
    if (start) start.cancelled = true;
    const stop = { start, navigating };
    pendingVoiceStops.set(tabId, stop);
    const notifyStop = (owner, type, error) => {
        const pending = pendingVoiceStarts.get(tabId);
        if (!stop.navigating && pendingVoiceStops.get(tabId) === stop && (!pending || pending === start)) {
            notifyVoiceRequest(owner, type, { error });
        }
    };
    const receivedOwner = start || (playbackOwner?.tabId === tabId ? playbackOwner : null);
    notifyStop(receivedOwner, "PLAYBACK_STOPPING");

    stop.operation = enqueueVoiceOperation(async () => {
        const owner = await getPlaybackOwner();
        const ownsOffscreen = owner?.tabId === tabId
            && (!documentId || !owner.documentId || owner.documentId === documentId);
        const target = receivedOwner || (ownsOffscreen ? owner : null);
        try {
            if (ownsOffscreen) {
                await stopOffscreenAudioIfPresent();
                await setPlaybackOwner(null);
            }
            notifyStop(target, "PLAYBACK_STOPPED");
        } catch (err) {
            const error = await recordVoiceStopFailure(ownsOffscreen ? owner : null, target, err);
            notifyStop(target, "PLAYBACK_STOP_FAILED", error);
            throw new Error(error);
        } finally {
            if (start && pendingVoiceStarts.get(tabId) === start) pendingVoiceStarts.delete(tabId);
            if (pendingVoiceStops.get(tabId) === stop) pendingVoiceStops.delete(tabId);
        }
    });
    return stop.operation;
}

/**
 * スタイルID（speakerId）から、キャラクター名とアイコン画像を取得する。
 *
 * 画像は拡張機能に同梱せず、利用者自身のPCで動いている VOICEVOX エンジンから
 * その都度取得する（VOICEVOX本体の規約が禁じる「再配布」を避けるため）。
 * 取得した画像は利用者のブラウザ内にとどまり、外部へ送信されることはない。
 *
 * エンジンが起動していない場合は例外になるが、呼び出し側（options.js）は
 * 名前だけの表示にフォールバックできるため、致命的ではない。
 *
 * @returns {Promise<{name: string, icon: string|null}>} icon は base64（データURL接頭辞なし）
 */
async function fetchSpeakerIcon(speakerId) {
    const id = Number(speakerId);
    if (!Number.isInteger(id)) throw new Error("speakerId が不正です");

    const speakersRes = await fetchWithTimeout(
        `${VOICEVOX_BASE_URL}/speakers`, {}, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!speakersRes.ok) throw new Error(`キャラクター一覧の取得に失敗しました (${speakersRes.status})`);
    const speakers = normalizeSpeakerList(await readJsonResponseWithLimit(speakersRes));

    const speaker = speakers.find(s => s.styles.some(st => st.id === id));
    if (!speaker) throw new Error("選択中のキャラクターが見つかりません");

    // speaker_uuid が無いエンジンでも名前だけは返し、文字表示にフォールバックさせる。
    if (!speaker.speaker_uuid) return { name: speaker.name, icon: null };

    const infoRes = await fetchWithTimeout(
        `${VOICEVOX_BASE_URL}/speaker_info?speaker_uuid=${encodeURIComponent(speaker.speaker_uuid)}`,
        {}, VOICEVOX_FETCH_TIMEOUT_MS);
    if (!infoRes.ok) return { name: speaker.name, icon: null };
    const info = await readJsonResponseWithLimit(infoRes);

    // スタイルごとにアイコンが違うため、選択中のスタイルのものを優先する。
    const styleInfos = Array.isArray(info?.style_infos) ? info.style_infos.slice(0, 1000) : [];
    const matched = styleInfos.find(si => Number(si?.id) === id) || styleInfos[0];
    const icon = typeof matched?.icon === "string"
        && matched.icon.length <= 3 * 1024 * 1024
        && /^[A-Za-z0-9+/=]+$/.test(matched.icon)
        ? matched.icon : null;
    return { name: speaker.name, icon };
}
