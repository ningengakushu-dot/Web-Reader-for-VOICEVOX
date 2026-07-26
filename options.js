document.addEventListener('DOMContentLoaded', () => {
    const speakerSelect = document.getElementById('speaker-select');
    const saveBtn = document.getElementById('save-btn');
    const resetBtn = document.getElementById('reset-btn');
    const statusMsg = document.getElementById('status-msg');
    const loader = document.getElementById('loader');
    const ocrRemoveRubyCheck = document.getElementById('ocrRemoveRuby-check');
    const iconRightClickSelect = document.getElementById('iconRightClick-select');

    // スライダー設定定義: デフォルト値は constants.js の SETTING_DEFAULTS を単一の真実源とする
    const sliderConfigs = [
        { key: 'speedScale',       id: 'speed',      defaultVal: SETTING_DEFAULTS.speedScale,       decimals: 1 },
        { key: 'pitchScale',       id: 'pitch',      defaultVal: SETTING_DEFAULTS.pitchScale,       decimals: 2 },
        { key: 'intonationScale',  id: 'intonation', defaultVal: SETTING_DEFAULTS.intonationScale,  decimals: 1 },
        { key: 'volumeScale',      id: 'volume',     defaultVal: SETTING_DEFAULTS.volumeScale,      decimals: 1 },
        { key: 'pauseLengthScale', id: 'pause',      defaultVal: SETTING_DEFAULTS.pauseLengthScale, decimals: 1 },
        { key: 'iconSize',         id: 'iconSize',   defaultVal: SETTING_DEFAULTS.iconSize,         decimals: 0 },
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

            const storageKeys = ['speakerId', 'ocrRemoveRuby', 'iconRightClickAction', ...sliders.map(s => s.key)];
            const result = await chrome.storage.local.get(storageKeys);

            // speakerId が 0（先頭スピーカー等）でも復元できるよう、真偽値ではなく
            // undefined/null を除外する判定にする。
            if (result.speakerId !== undefined && result.speakerId !== null) {
                speakerSelect.value = result.speakerId;
            }
            for (const s of sliders) {
                // storage に保存値が無ければ SETTING_DEFAULTS 由来の既定値を表示する
                const value = result[s.key] !== undefined ? result[s.key] : s.defaultVal;
                s.slider.value = value;
                s.valueEl.textContent = Number(value).toFixed(s.decimals);
            }
            ocrRemoveRubyCheck.checked = result.ocrRemoveRuby === true;
            // 既定は「画面OCR読み上げを開始」（content.js 側の既定値と揃える）
            iconRightClickSelect.value = result.iconRightClickAction === 'options' ? 'options' : 'capture';
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
        const speakerId = parseInt(speakerSelect.value, 10);
        if (isNaN(speakerId)) {
            showStatus('キャラクターを選択してください。', 'error');
            return;
        }

        const settings = { speakerId };
        for (const s of sliders) {
            const val = parseFloat(s.slider.value);
            if (isNaN(val)) return;
            settings[s.key] = val;
        }
        settings.ocrRemoveRuby = ocrRemoveRubyCheck.checked;
        settings.iconRightClickAction = iconRightClickSelect.value === 'options' ? 'options' : 'capture';

        try {
            await chrome.storage.local.set(settings);
            showStatus('設定を保存しました！', 'success');
        } catch (error) {
            showStatus('保存に失敗しました。', 'error');
        }
    });

    resetBtn.addEventListener('click', async () => {
        try {
            // 位置のクリアとアイコンサイズの初期化を同時に行う
            await chrome.storage.local.remove('vvradio_icon_pos');
            await chrome.storage.local.set({ iconSize: SETTING_DEFAULTS.iconSize });

            // スライダーUIの表示を既定サイズに同期
            const iconSlider = sliders.find(s => s.key === 'iconSize');
            if (iconSlider) {
                iconSlider.slider.value = SETTING_DEFAULTS.iconSize;
                iconSlider.valueEl.textContent = String(SETTING_DEFAULTS.iconSize);
            }

            showStatus('アイコンを初期化しました', 'success');
        } catch (error) {
            showStatus('初期化に失敗しました。', 'error');
        }
    });

    let statusTimer = null;
    function showStatus(msg, type) {
        statusMsg.textContent = msg;
        statusMsg.className = `status-msg ${type}`;
        // 連続操作で前のタイマーが後続メッセージを早消ししないよう、毎回張り直す
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { statusTimer = null; statusMsg.textContent = ''; }, 3000);
    }

    function showLoader(show) {
        loader.style.display = show ? 'inline-block' : 'none';
        saveBtn.disabled = show;
    }

    init();
});
