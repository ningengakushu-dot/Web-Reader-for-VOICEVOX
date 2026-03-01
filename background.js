// VOICEVOXエンジンのベースURL（ローカルサーバー）
const VOICEVOX_BASE_URL = "http://127.0.0.1:50021";

// 拡張機能インストール時にコンテキストメニューを作成
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "read-selected-text",
        title: "選択したテキストをWeb Reader for VOICEVOXで読み上げ",
        contexts: ["selection"]
    });
});

// コンテキストメニューがクリックされた時の処理
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "read-selected-text" && info.selectionText) {
        // Content script にメッセージを送信
        chrome.tabs.sendMessage(tab.id, {
            type: "READ_SELECTED_TEXT",
            text: info.selectionText
        });
    }
});

// ショートカットキーが押された時の処理
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-reading") {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_READING" });
            }
        });
    }
});

// Content Scriptからのメッセージを処理するリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // オプション画面を開く要求
    if (request.type === "OPEN_OPTIONS") {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
        return false;
    }

    // 接続確認: エンジンのバージョンを取得して生存確認を行う
    if (request.type === "CHECK_CONNECTION") {
        fetch(`${VOICEVOX_BASE_URL}/version`)
            .then(res => res.ok ? sendResponse({ success: true, version: res.status }) : sendResponse({ success: false }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // 非同期レスポンスのためにtrueを返す
    }

    // スピーカー一覧の取得: オプション画面での選択用
    if (request.type === "GET_SPEAKERS") {
        fetch(`${VOICEVOX_BASE_URL}/speakers`)
            .then(res => res.json())
            .then(speakers => sendResponse({ success: true, speakers }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    // 音声生成リクエスト処理
    if (request.type === "GENERATE_VOICE") {
        console.log("Background: 音声生成要求受信", request.text);
        
        // 保存されたスピーカーIDと速度を取得（未設定の場合はデフォルトを使用）
        chrome.storage.local.get(['speakerId', 'speedScale']).then((result) => {
            const speakerId = result.speakerId || request.speakerId || 1;
            const speedScale = result.speedScale || 1.0;
            
            generateVoice(request.text, speakerId, speedScale)
                .then(data => {
                    console.log(`Background: 音声生成成功 (Speaker: ${speakerId}, Speed: ${speedScale})`);
                    sendResponse({ success: true, audioData: data });
                })
                .catch(err => {
                    console.error("Background: 生成失敗:", err);
                    sendResponse({ success: false, error: err.message });
                });
        }).catch(err => {
            console.error("Background: Storage取得エラー:", err);
            sendResponse({ success: false, error: "設定の取得に失敗しました" });
        });
        return true; 
    }

    // 未知のメッセージタイプの場合
    sendResponse({ success: false, error: "Unknown message type" });
    return false;
});

/**
 * VOICEVOX APIを使用して音声を生成し、Base64文字列として返す
 * @param {string} text - 読み上げるテキスト
 * @param {number} speakerId - スピーカーID
 * @param {number} speedScale - 読み上げ速度
 * @returns {Promise<string>} Base64エンコードされた音声データ
 */
async function generateVoice(text, speakerId, speedScale) {
    // タイムアウト制御用（15秒でリクエストを中断）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); 

    try {
        // 1. 音声合成用クエリの作成 (audio_query)
        const queryUrl = `${VOICEVOX_BASE_URL}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(text)}`;
        const queryResponse = await fetch(queryUrl, { method: "POST", signal: controller.signal });
        if (!queryResponse.ok) throw new Error(`Query失敗(${queryResponse.status})`);
        
        const queryJson = await queryResponse.json();

        // Content Script側でのウォームアップ実装に伴い、冒頭の無音時間を短縮してレスポンスを向上
        queryJson.prePhonemeLength = 0.1;
        // 読み上げ速度を適用
        queryJson.speedScale = speedScale;

        // 2. 音声合成の実行 (synthesis)
        const synthUrl = `${VOICEVOX_BASE_URL}/synthesis?speaker=${speakerId}`;
        const synthResponse = await fetch(synthUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(queryJson),
            signal: controller.signal
        });
        if (!synthResponse.ok) throw new Error(`Synthesis失敗(${synthResponse.status})`);

        const audioBlob = await synthResponse.blob();
        
        // BlobをBase64文字列に変換して返却
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("Base64変換失敗"));
            reader.readAsDataURL(audioBlob);
        });

    } finally {
        clearTimeout(timeoutId);
    }
}