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
        }).catch(() => {});
    }
});

// ショートカットキーが押された時の処理
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-reading") {
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_READING" }).catch(() => {});
            }
        });
    }
});

// --- Offscreen Document 管理 ---
let offscreenCreating = null; // 作成中のPromise

async function setupOffscreen() {
    try {
        // すでに存在するか確認
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });

        if (existingContexts.length > 0) {
            return;
        }

        // 作成中なら待機
        if (offscreenCreating) {
            await offscreenCreating;
            return;
        }

        // 新規作成
        console.log("Background: Offscreen Document を作成します");
        offscreenCreating = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['AUDIO_PLAYBACK'],
            justification: '音声再生によるアクセシビリティ向上のため（CSP制限サイト回避）'
        });
        
        await offscreenCreating;
        offscreenCreating = null;
    } catch (err) {
        offscreenCreating = null;
        console.error("Background: setupOffscreen 失敗:", err.name, err.message);
        throw err;
    }
}

// Content Scriptからのメッセージを処理するリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // ターゲットがbackgroundでない場合は無視（Offscreenからの返信など）
    if (request.target && request.target !== 'background') return;

    // オプション画面を開く要求
    if (request.type === "OPEN_OPTIONS") {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
        return false;
    }

    // 接続確認
    if (request.type === "CHECK_CONNECTION") {
        fetch(`${VOICEVOX_BASE_URL}/version`)
            .then(res => res.ok ? sendResponse({ success: true }) : sendResponse({ success: false }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    // スピーカー一覧取得
    if (request.type === "GET_SPEAKERS") {
        fetch(`${VOICEVOX_BASE_URL}/speakers`)
            .then(res => res.json())
            .then(speakers => sendResponse({ success: true, speakers: speakers }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    // 音声生成リクエスト（分割して Offscreen へ送信）
    if (request.type === "GENERATE_VOICE") {
        chrome.storage.local.get(['speakerId', 'speedScale', 'pitchScale', 'intonationScale', 'volumeScale', 'pauseLength']).then(async (result) => {
            const speakerId = result.speakerId || 1;
            const speedScale = result.speedScale !== undefined ? result.speedScale : 1.0;
            const pitchScale = result.pitchScale !== undefined ? result.pitchScale : 0.0;
            const intonationScale = result.intonationScale !== undefined ? result.intonationScale : 1.0;
            const volumeScale = result.volumeScale !== undefined ? result.volumeScale : 1.0;
            const pauseLength = result.pauseLength !== undefined ? result.pauseLength : 1.0;
            
            const chunks = splitText(request.text);
            
            try {
                await setupOffscreen();
                // 新しい読み上げの前に以前の再生を停止しキューをクリアする
                chrome.runtime.sendMessage({
                    type: 'STOP_AUDIO',
                    target: 'offscreen'
                }).catch(() => {});

                // チャンクを順次送信（Offscreen 側のキューで管理）
                for (const chunk of chunks) {
                    chrome.runtime.sendMessage({
                        type: 'ENQUEUE_TEXT',
                        target: 'offscreen',
                        text: chunk,
                        speakerId: speakerId,
                        speedScale: speedScale,
                        pitchScale: pitchScale,
                        intonationScale: intonationScale,
                        volumeScale: volumeScale,
                        pauseLength: pauseLength
                    }).catch(() => {});
                }
                sendResponse({ success: true });
            } catch (err) {
                console.error("Background: 準備エラー:", err);
                sendResponse({ success: false, error: err.message });
            }
        });
        return true; 
    }

    // 停止リクエスト
    if (request.type === "STOP_ALL") {
        setupOffscreen().then(() => {
            chrome.runtime.sendMessage({
                type: 'STOP_AUDIO',
                target: 'offscreen'
            }).catch(() => {});
        });
        sendResponse({ success: true });
        return false;
    }

    // 再生状態の転送（Offscreen -> Content Script）
    if (["PLAYBACK_STARTED", "PLAYBACK_ENDED", "PLAYBACK_ERROR", "PLAYBACK_STOPPED"].includes(request.type)) {
        chrome.tabs.query({active: true}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, request).catch(() => {});
            });
        });
    }

    return false;
});

/**
 * テキストを適切な長さ（文単位）に分割する
 */
function splitText(text) {
    if (!text) return [];
    
    // 句読点や改行で分割
    // 。、！？\n など
    const sentences = text.split(/([。！？\n])/);
    
    const chunks = [];
    let currentChunk = "";
    
    for (let i = 0; i < sentences.length; i++) {
        currentChunk += sentences[i];
        
        // 区切り文字を含めて一定の長さになったか、区切り文字そのものの場合はチャンク確定
        if (i % 2 === 1 || i === sentences.length - 1) {
            const trimmed = currentChunk.trim();
            if (trimmed) {
                chunks.push(trimmed);
            }
            currentChunk = "";
        }
    }
    
    // 空の配列にならないようガード
    return chunks.length > 0 ? chunks : [text];
}
