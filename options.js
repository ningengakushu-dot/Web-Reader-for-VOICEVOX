document.addEventListener('DOMContentLoaded', () => {
    const speakerSelect = document.getElementById('speaker-select');
    const saveBtn = document.getElementById('save-btn');
    const statusMsg = document.getElementById('status-msg');
    const loader = document.getElementById('loader');
    const speedSlider = document.getElementById('speed-slider');
    const speedValue = document.getElementById('speed-value');

    const pitchSlider = document.getElementById('pitch-slider');
    const pitchValue = document.getElementById('pitch-value');

    const intonationSlider = document.getElementById('intonation-slider');
    const intonationValue = document.getElementById('intonation-value');

    const volumeSlider = document.getElementById('volume-slider');
    const volumeValue = document.getElementById('volume-value');

    const pauseSlider = document.getElementById('pause-slider');
    const pauseValue = document.getElementById('pause-value');

    // スライダー操作時のリアルタイム反映
    speedSlider.addEventListener('input', (e) => {
        speedValue.textContent = Number(e.target.value).toFixed(1);
    });
    pitchSlider.addEventListener('input', (e) => {
        pitchValue.textContent = Number(e.target.value).toFixed(2);
    });
    intonationSlider.addEventListener('input', (e) => {
        intonationValue.textContent = Number(e.target.value).toFixed(1);
    });
    volumeSlider.addEventListener('input', (e) => {
        volumeValue.textContent = Number(e.target.value).toFixed(1);
    });
    pauseSlider.addEventListener('input', (e) => {
        pauseValue.textContent = Number(e.target.value).toFixed(1);
    });

    // 初期化処理: スピーカー一覧の取得と保存済み設定の反映を行う
    async function init() {
        showLoader(true);
        try {
            // Background Script経由でVOICEVOXからスピーカー情報を取得
            const speakers = await getSpeakers();
            renderSpeakers(speakers);

            // Chromeストレージから保存済みの設定を取得
            const result = await chrome.storage.local.get(['speakerId', 'speedScale', 'pitchScale', 'intonationScale', 'volumeScale', 'pauseLength']);
            if (result.speakerId) {
                speakerSelect.value = result.speakerId;
            }
            if (result.speedScale !== undefined) {
                speedSlider.value = result.speedScale;
                speedValue.textContent = Number(result.speedScale).toFixed(1);
            }
            if (result.pitchScale !== undefined) {
                pitchSlider.value = result.pitchScale;
                pitchValue.textContent = Number(result.pitchScale).toFixed(2);
            }
            if (result.intonationScale !== undefined) {
                intonationSlider.value = result.intonationScale;
                intonationValue.textContent = Number(result.intonationScale).toFixed(1);
            }
            if (result.volumeScale !== undefined) {
                volumeSlider.value = result.volumeScale;
                volumeValue.textContent = Number(result.volumeScale).toFixed(1);
            }
            if (result.pauseLength !== undefined) {
                pauseSlider.value = result.pauseLength;
                pauseValue.textContent = Number(result.pauseLength).toFixed(1);
            }
        } catch (error) {
            console.error('Error during init:', error);
            showStatus('VOICEVOXエンジンに接続できません。起動しているか確認してください。', 'error');
        } finally {
            showLoader(false);
        }
    }

    // Background Scriptへメッセージを送り、スピーカーデータを非同期で取得
    async function getSpeakers() {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: "GET_SPEAKERS" }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (response && response.success) {
                    resolve(response.speakers);
                } else {
                    reject(new Error(response?.error || 'Failed to fetch speakers'));
                }
            });
        });
    }

    // 取得したスピーカーデータからセレクトボックスのオプション要素を生成
    function renderSpeakers(speakers) {
        speakerSelect.innerHTML = '';
        speakers.forEach(speaker => {
            // 各スピーカーのスタイル（ノーマル、あまあま等）ごとに選択肢を作成
            speaker.styles.forEach(style => {
                const option = document.createElement('option');
                option.value = style.id;
                option.textContent = `${speaker.name} (${style.name})`;
                speakerSelect.appendChild(option);
            });
        });
    }

    // 保存ボタンクリック時のイベントハンドラ
    saveBtn.addEventListener('click', async () => {
        const speakerId = parseInt(speakerSelect.value);
        const speedScale = parseFloat(speedSlider.value);
        const pitchScale = parseFloat(pitchSlider.value);
        const intonationScale = parseFloat(intonationSlider.value);
        const volumeScale = parseFloat(volumeSlider.value);
        const pauseLength = parseFloat(pauseSlider.value);
        if (isNaN(speakerId) || isNaN(speedScale) || isNaN(pitchScale) || isNaN(intonationScale) || isNaN(volumeScale) || isNaN(pauseLength)) return;

        try {
            // 設定値をChromeのローカルストレージに永続化
            await chrome.storage.local.set({ 
                speakerId: speakerId, 
                speedScale: speedScale,
                pitchScale: pitchScale,
                intonationScale: intonationScale,
                volumeScale: volumeScale,
                pauseLength: pauseLength
            });
            showStatus('設定を保存しました！', 'success');
        } catch (error) {
            showStatus('保存に失敗しました。', 'error');
        }
    });

    // ユーザーへのフィードバックメッセージを表示（3秒後に自動消去）
    function showStatus(msg, type) {
        statusMsg.textContent = msg;
        statusMsg.className = `status-msg ${type}`;
        setTimeout(() => {
            statusMsg.textContent = '';
        }, 3000);
    }

    // 通信中のローディング表示とボタンの無効化制御
    function showLoader(show) {
        loader.style.display = show ? 'inline-block' : 'none';
        saveBtn.disabled = show;
    }

    // 処理開始
    init();
});