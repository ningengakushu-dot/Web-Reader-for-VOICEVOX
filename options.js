document.addEventListener('DOMContentLoaded', () => {
    const speakerSelect = document.getElementById('speaker-select');
    const saveBtn = document.getElementById('save-btn');
    const statusMsg = document.getElementById('status-msg');
    const loader = document.getElementById('loader');

    // スライダー設定定義: [storageKey, elementId, デフォルト値, 小数点桁数]
    const sliderConfigs = [
        { key: 'speedScale',      id: 'speed',      defaultVal: 1.0,  decimals: 1 },
        { key: 'pitchScale',      id: 'pitch',      defaultVal: 0.0,  decimals: 2 },
        { key: 'intonationScale', id: 'intonation',  defaultVal: 1.0,  decimals: 1 },
        { key: 'volumeScale',     id: 'volume',     defaultVal: 1.0,  decimals: 1 },
        { key: 'pauseLengthScale', id: 'pause',     defaultVal: 1.0,  decimals: 1 },
    ];

    // 各スライダーのDOM参照を取得し、inputイベントを設定
    const sliders = sliderConfigs.map(config => {
        const slider = document.getElementById(`${config.id}-slider`);
        const valueEl = document.getElementById(`${config.id}-value`);
        slider.addEventListener('input', () => {
            valueEl.textContent = Number(slider.value).toFixed(config.decimals);
        });
        return { ...config, slider, valueEl };
    });

    async function init() {
        showLoader(true);
        try {
            const speakers = await getSpeakers();
            renderSpeakers(speakers);

            const storageKeys = ['speakerId', ...sliders.map(s => s.key)];
            const result = await chrome.storage.local.get(storageKeys);

            if (result.speakerId) {
                speakerSelect.value = result.speakerId;
            }
            for (const s of sliders) {
                if (result[s.key] !== undefined) {
                    s.slider.value = result[s.key];
                    s.valueEl.textContent = Number(result[s.key]).toFixed(s.decimals);
                }
            }
        } catch (error) {
            console.error('Error during init:', error);
            showStatus('VOICEVOXエンジンに接続できません。起動しているか確認してください。', 'error');
        } finally {
            showLoader(false);
        }
    }

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

    function renderSpeakers(speakers) {
        speakerSelect.innerHTML = '';
        for (const speaker of speakers) {
            for (const style of speaker.styles) {
                const option = document.createElement('option');
                option.value = style.id;
                option.textContent = `${speaker.name} (${style.name})`;
                speakerSelect.appendChild(option);
            }
        }
    }

    saveBtn.addEventListener('click', async () => {
        const speakerId = parseInt(speakerSelect.value);
        if (isNaN(speakerId)) return;

        const settings = { speakerId };
        for (const s of sliders) {
            const val = parseFloat(s.slider.value);
            if (isNaN(val)) return;
            settings[s.key] = val;
        }

        try {
            await chrome.storage.local.set(settings);
            showStatus('設定を保存しました！', 'success');
        } catch (error) {
            showStatus('保存に失敗しました。', 'error');
        }
    });

    function showStatus(msg, type) {
        statusMsg.textContent = msg;
        statusMsg.className = `status-msg ${type}`;
        setTimeout(() => { statusMsg.textContent = ''; }, 3000);
    }

    function showLoader(show) {
        loader.style.display = show ? 'inline-block' : 'none';
        saveBtn.disabled = show;
    }

    init();
});
