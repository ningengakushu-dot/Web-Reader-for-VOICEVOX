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
// 「宛先切替 → 既存再生停止 → 新規キュー追加」の順序が交差しないようにする。
let voiceOperationQueue = Promise.resolve();
function enqueueVoiceOperation(operation) {
    const next = voiceOperationQueue.then(operation);
    voiceOperationQueue = next.catch(() => {});
    return next;
}

// Content Scriptからのメッセージを処理するリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target && request.target !== 'background') return;
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

        case "GENERATE_VOICE": {
            // 新しい読み上げの開始は、そのタブで進行中の範囲OCRを無効化する。
            // 取消状態の session 保存を同じ直列キュー内で待ち、直後に届く古いOCR結果が
            // 新しい読み上げを追い越さないようにする。
            const ocrInvalidated = invalidatePendingOcr(sender.tab?.id);
            enqueueVoiceOperation(async () => {
                await ocrInvalidated;
                await switchPlaybackTabTo(sender.tab?.id ?? null);
                await handleGenerateVoice(request.text, sendResponse);
            }).catch((err) => sendResponse({ success: false, error: err.message }));
            return true;
        }

        case "STOP_ALL": {
            // 停止はそのタブで進行中の範囲OCRも取り消す（完了後に勝手に読み上げを始めない）。
            const ocrInvalidated = invalidatePendingOcr(sender.tab?.id);
            respondWith(enqueueVoiceOperation(async () => {
                await ocrInvalidated;
                await stopOffscreenAudioIfPresent();
            }), sendResponse);
            return true;
        }

        case "CAPTURE_OCR_REGION": {
            // ページ内オーバーレイで選択された範囲のキャプチャ→OCR開始要求
            const tab = sender.tab;
            if (!tab || tab.id == null) {
                sendResponse({ success: false, error: "要求元タブを特定できません" });
                return false;
            }
            captureAndRecognizeRegion(request, tab)
                .then(() => sendResponse({ success: true }))
                .catch((err) => {
                    console.warn("Background: 範囲OCRの開始に失敗:", err.message);
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
            // OCR完了も読み上げ開始・停止と同じ直列キューへ即座に積む。
            // session の照合は非同期だが、キューへ入れる順序をメッセージ到着順に固定することで、
            // 後から来た GENERATE_VOICE / STOP_ALL に古いOCRが追い越されるのを防ぐ。
            const tabId = request.tabId ?? null;
            enqueueVoiceOperation(async () => {
                if (await consumeStaleOcrCompletion(tabId, request.requestId)) return;
                if (request.error || !request.text) {
                    notifyTab(tabId, {
                        type: "OCR_STATUS",
                        status: "error",
                        message: request.error || "文字を認識できませんでした。"
                    }, "OCRエラー通知の送信失敗");
                    return;
                }
                await switchPlaybackTabTo(tabId);
                notifyTab(tabId, { type: "OCR_STATUS", status: "done" });
                await handleGenerateVoice(request.text, (res) => {
                    if (res && res.success === false) {
                        notifyTab(tabId, {
                            type: "OCR_STATUS",
                            status: "error",
                            message: `読み上げを開始できませんでした: ${res.error}`
                        }, "読み上げ開始エラー通知の送信失敗");
                    }
                });
            }).catch((err) => {
                notifyTab(tabId, {
                    type: "OCR_STATUS", status: "error",
                    message: `読み上げを開始できませんでした: ${err.message}`
                }, "読み上げ開始エラー通知の送信失敗");
            });
            return false;
        }

        case "PLAYBACK_STARTED":
        case "PLAYBACK_ENDED":
        case "PLAYBACK_ERROR":
        case "PLAYBACK_STOPPED":
            // 再生を要求したタブにのみ転送する。全アクティブタブへ配信すると、
            // 別ウィンドウのアクティブタブのUIまで誤って更新されてしまう。
            // target を 'tab' に付け替えるのは、拡張機能ページ（capture.html）が
            // offscreen からの全体ブロードキャスト（target:'background'）と
            // このタブ宛て転送を区別して二重処理を防げるようにするため。
            // SW休止から復帰した直後はメモリ上の宛先が失われているため、
            // storage.session から復元してから転送する（getPlaybackTabId）。
            getPlaybackTabId().then((tabId) => notifyTab(tabId, request, "再生状態の転送失敗"));
            return false;
    }

    return false;
});

async function handleGenerateVoice(text, sendResponse) {
    try {
        // 設定の読み出しも try の内側に入れる。ここで例外が出ると応答が返らず、
        // 要求元は「無反応」のまま待たされてしまう。
        const result = await chrome.storage.local.get(Object.keys(SETTING_DEFAULTS));
        const settings = { ...SETTING_DEFAULTS, ...result };
        const chunks = splitText(text);
        // 記号・罫線だけの選択など、読める文字が無い場合は無音の合成要求を送らず、
        // 理由を返す（呼び出し側がトーストに出す）。
        if (chunks.length === 0) {
            sendResponse({ success: false, error: "読み上げられる文字がありません" });
            return;
        }

        await setupOffscreen();
        // Offscreen への配信完了を確認してから成功応答を返す（無音失敗の可視化）
        await sendToOffscreen({ type: 'STOP_AUDIO' });

        // 1文ずつ送ると、短い文では先頭の再生完了時にキューが空になり
        // 読み上げ終了が早すぎるタイミングで通知される。まとめて渡す。
        await sendToOffscreen({
            type: 'ENQUEUE_TEXTS',
            texts: chunks,
            settings
        });
        sendResponse({ success: true });
    } catch (err) {
        console.error("Background: 準備エラー:", err);
        sendResponse({ success: false, error: err.message });
    }
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
