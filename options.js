document.addEventListener('DOMContentLoaded', () => {
    const speakerSelect = document.getElementById('speaker-select');
    const saveBtn = document.getElementById('save-btn');
    const resetBtn = document.getElementById('reset-btn');
    const statusMsg = document.getElementById('status-msg');
    const loader = document.getElementById('loader');
    const ocrRemoveRubyCheck = document.getElementById('ocrRemoveRuby-check');
    const iconRightClickSelect = document.getElementById('iconRightClick-select');
    const iconStyleSelect = document.getElementById('iconStyle-select');
    const iconStylePreview = document.getElementById('iconStyle-preview');
    const iconStyleHintCharacter = document.getElementById('iconStyle-hint-character');
    const customIconRow = document.getElementById('customIcon-row');
    const customIconFile = document.getElementById('customIcon-file');
    const customIconClear = document.getElementById('customIcon-clear');

    // 「画像を指定する」で選ばれた画像。保存ボタンを押すまで storage には書かない。
    let pendingCustomIcon = null;

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

    const STORED_ICON_DATA_URL_MAX_CHARS = 2 * 1024 * 1024;
    const ICON_DECODE_MAX_DIMENSION = 16384;
    const ICON_DECODE_MAX_PIXELS = 40 * 1024 * 1024;

    function clampSliderValue(slider, value, fallback) {
        const min = Number(slider.min);
        const max = Number(slider.max);
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.min(max, Math.max(min, numeric));
    }

    function isSafeRasterDataUrl(value) {
        return typeof value === 'string'
            && value.length <= STORED_ICON_DATA_URL_MAX_CHARS
            && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(value);
    }

    function sanitizeCharacterIcon(value) {
        if (!value || typeof value !== 'object') return null;
        const name = typeof value.name === 'string' ? value.name.trim().slice(0, 100) : '';
        if (!name) return null;
        return { name, dataUrl: isSafeRasterDataUrl(value.dataUrl) ? value.dataUrl : null };
    }

    async function init() {
        showLoader(true);
        // 保存済み設定の復元はエンジンの起動状態に依存しない。
        // キャラクター一覧の取得失敗でスライダーやアイコン設定まで初期化されないよう、
        // storage の読み出しを先に済ませてから一覧の取得を試みる。
        const storageKeys = ['speakerId', 'ocrRemoveRuby', 'iconRightClickAction', 'iconStyle',
            CHARACTER_ICON_STORAGE_KEY, CUSTOM_ICON_STORAGE_KEY, ...sliders.map(s => s.key)];
        let result = {};
        try {
            result = await chrome.storage.local.get(storageKeys);
        } catch (error) {
            console.error('Error reading settings:', error);
        }

        try {
            for (const s of sliders) {
                // storage が破損・改変されていても、UIで許可する範囲へ正規化する。
                const stored = result[s.key] !== undefined ? result[s.key] : s.defaultVal;
                const value = clampSliderValue(s.slider, stored, s.defaultVal);
                s.slider.value = value;
                s.valueEl.textContent = Number(value).toFixed(s.decimals);
            }
            ocrRemoveRubyCheck.checked = result.ocrRemoveRuby === true;
            // 既定は「画面OCR読み上げを開始」（content.js 側の既定値と揃える）
            iconRightClickSelect.value = result.iconRightClickAction === 'options' ? 'options' : 'capture';

            const savedStyle = result.iconStyle;
            iconStyleSelect.value = ICON_STYLE_VALUES.includes(savedStyle)
                ? savedStyle : SETTING_DEFAULTS.iconStyle;
            pendingCustomIcon = isSafeRasterDataUrl(result[CUSTOM_ICON_STORAGE_KEY])
                ? result[CUSTOM_ICON_STORAGE_KEY] : null;
            updateIconStyleUI(sanitizeCharacterIcon(result[CHARACTER_ICON_STORAGE_KEY]));
        } catch (error) {
            console.error('Error restoring settings:', error);
        }

        try {
            const speakers = await getSpeakers();
            renderSpeakers(speakers);
            // 一覧の描画後でないと select に値を入れられないため、ここで復元する。
            // speakerId が 0（先頭スピーカー等）でも復元できるよう、真偽値ではなく
            // undefined/null を除外する判定にする。
            if (result.speakerId !== undefined && result.speakerId !== null) {
                const savedId = String(result.speakerId);
                if ([...speakerSelect.options].some((option) => option.value === savedId)) {
                    speakerSelect.value = savedId;
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
        if (!Array.isArray(speakers)) throw new Error('キャラクター一覧の形式が不正です');
        speakerSelect.textContent = '';
        let count = 0;
        for (const speaker of speakers.slice(0, 1000)) {
            if (!speaker || typeof speaker.name !== 'string' || !Array.isArray(speaker.styles)) continue;
            const speakerName = speaker.name.trim().slice(0, 100);
            if (!speakerName) continue;
            for (const style of speaker.styles.slice(0, 1000)) {
                const id = Number(style?.id);
                if (!Number.isInteger(id) || id < 0 || id > 1000000) continue;
                const styleName = typeof style?.name === 'string' ? style.name.trim().slice(0, 100) : '';
                const option = document.createElement('option');
                option.value = String(id);
                option.textContent = styleName ? `${speakerName} (${styleName})` : speakerName;
                speakerSelect.appendChild(option);
                count++;
            }
        }
        if (count === 0) throw new Error('利用可能なキャラクターが見つかりません');
    }

    // ===== ページ内アイコンの見た目 =====

    // 選択肢の妥当性検査に使う。storage に想定外の値が入っていても既定へ戻せるようにする。
    const ICON_STYLE_VALUES = ['dot', 'app', 'character', 'custom'];

    // 選択中の見た目に応じて、補足説明・画像指定欄・プレビューの表示を切り替える。
    function updateIconStyleUI(characterIcon) {
        const style = iconStyleSelect.value;
        iconStyleHintCharacter.hidden = style !== 'character';
        customIconRow.hidden = style !== 'custom';
        renderIconPreview(style, characterIcon);
    }

    // 実際のページ内アイコンと同じ見え方をプレビューに再現する。
    function renderIconPreview(style, characterIcon) {
        iconStylePreview.className = 'icon-preview';
        iconStylePreview.style.backgroundImage = '';
        iconStylePreview.textContent = '';

        if (style === 'app') {
            iconStylePreview.classList.add('image');
            iconStylePreview.style.backgroundImage = `url("${chrome.runtime.getURL('images/icon128.png')}")`;
        } else if (style === 'custom' && isSafeRasterDataUrl(pendingCustomIcon)) {
            iconStylePreview.classList.add('image');
            iconStylePreview.style.backgroundImage = `url("${pendingCustomIcon}")`;
        } else if (style === 'character' && characterIcon && characterIcon.name) {
            if (isSafeRasterDataUrl(characterIcon.dataUrl)) {
                iconStylePreview.classList.add('image');
                iconStylePreview.style.backgroundImage = `url("${characterIcon.dataUrl}")`;
            } else {
                iconStylePreview.classList.add('text');
                iconStylePreview.textContent = characterIcon.name.slice(0, 1);
            }
        }
    }

    iconStyleSelect.addEventListener('change', async () => {
        updateIconStyleUI(null);
        if (iconStyleSelect.value === 'character') {
            // プレビューのために先読みする。失敗しても保存時に再取得するので無視してよい。
            const icon = await buildCharacterIcon().catch(() => null);
            if (iconStyleSelect.value === 'character') updateIconStyleUI(icon);
        }
    });

    customIconFile.addEventListener('change', async () => {
        const file = customIconFile.files && customIconFile.files[0];
        if (!file) return;
        try {
            pendingCustomIcon = await readCustomIconFile(file);
            updateIconStyleUI(null);
            showStatus('画像を読み込みました。「設定を保存」で確定します。', 'success');
        } catch (error) {
            customIconFile.value = '';
            showStatus(error.message, 'error');
        }
    });

    customIconClear.addEventListener('click', () => {
        pendingCustomIcon = null;
        customIconFile.value = '';
        updateIconStyleUI(null);
        showStatus('画像を削除しました。「設定を保存」で確定します。', 'success');
    });

    /**
     * アップロードされた画像を検査し、正方形に縮小したPNGのデータURLへ変換する。
     * canvas で描き直すため、元ファイルに含まれるスクリプトやメタデータは保存値に残らない。
     */
    async function readCustomIconFile(file) {
        if (!CUSTOM_ICON_ACCEPT_TYPES.includes(file.type)) {
            throw new Error('PNG / JPEG / WebP / GIF の画像を選んでください。');
        }
        if (file.size > CUSTOM_ICON_MAX_BYTES) {
            throw new Error(`画像が大きすぎます（${Math.round(CUSTOM_ICON_MAX_BYTES / 1024 / 1024)}MBまで）。`);
        }
        const objectUrl = URL.createObjectURL(file);
        try {
            return await toSquareIconDataUrl(objectUrl);
        } catch (error) {
            throw new Error('画像を読み込めませんでした。別の画像をお試しください。');
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }

    /**
     * 画像を ICON_IMAGE_MAX_PX の正方形に収めた PNG のデータURLにする。
     * 縦横比は保ったまま中央に配置し、余白は透明のままにする。
     */
    function toSquareIconDataUrl(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                try {
                    if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)
                        || img.naturalWidth > ICON_DECODE_MAX_DIMENSION
                        || img.naturalHeight > ICON_DECODE_MAX_DIMENSION
                        || img.naturalWidth * img.naturalHeight > ICON_DECODE_MAX_PIXELS) {
                        throw new Error('画像の縦横サイズが大きすぎます');
                    }
                    const side = ICON_IMAGE_MAX_PX;
                    const canvas = document.createElement('canvas');
                    canvas.width = side;
                    canvas.height = side;
                    const ctx = canvas.getContext('2d');
                    const scale = Math.min(side / img.naturalWidth, side / img.naturalHeight);
                    const w = Math.max(1, Math.round(img.naturalWidth * scale));
                    const h = Math.max(1, Math.round(img.naturalHeight * scale));
                    ctx.drawImage(img, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
                    resolve(canvas.toDataURL('image/png'));
                } catch (error) {
                    reject(error);
                }
            };
            img.onerror = () => reject(new Error('画像を読み込めませんでした'));
            img.src = src;
        });
    }

    /**
     * 選択中のキャラクターの表示情報を作る。
     *
     * 画像は拡張機能に同梱せず、利用者のPCで動いている VOICEVOX エンジンから取得する。
     * さらに、キャラクター画像の利用が規約で明示的に許可されているキャラクター
     * （ICON_IMAGE_ALLOWED_CHARACTERS）に限って画像を採用し、それ以外は dataUrl を
     * null にして content.js 側で名前の頭文字表示にフォールバックさせる。
     *
     * @returns {Promise<{name: string, dataUrl: string|null}|null>}
     */
    async function buildCharacterIcon() {
        const speakerId = parseInt(speakerSelect.value, 10);
        if (isNaN(speakerId)) return null;

        // エンジンが止まっていても名前だけは選択欄から取れるので、まず控えておく。
        const optionText = speakerSelect.selectedOptions[0]?.textContent || '';
        const fallbackName = optionText.replace(/\s*\([^)]*\)\s*$/, '').trim().slice(0, 100);

        const response = await sendMessage({ type: 'GET_SPEAKER_ICON', speakerId });
        if (!response || !response.success) {
            return fallbackName ? { name: fallbackName, dataUrl: null } : null;
        }

        const name = (typeof response.name === 'string' ? response.name : fallbackName).trim().slice(0, 100);
        if (!name) return null;
        const icon = typeof response.icon === 'string' && response.icon.length <= STORED_ICON_DATA_URL_MAX_CHARS
            && /^[A-Za-z0-9+/=]+$/.test(response.icon) ? response.icon : null;
        if (!ICON_IMAGE_ALLOWED_CHARACTERS.includes(name) || !icon) {
            return { name, dataUrl: null };
        }

        try {
            const dataUrl = await toSquareIconDataUrl(`data:image/png;base64,${icon}`);
            return { name, dataUrl };
        } catch (error) {
            return { name, dataUrl: null };
        }
    }

    function sendMessage(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) return resolve(null);
                resolve(response);
            });
        });
    }

    saveBtn.addEventListener('click', async () => {
        const speakerId = parseInt(speakerSelect.value, 10);
        if (isNaN(speakerId)) {
            showStatus('キャラクターを選択してください。', 'error');
            return;
        }

        const settings = { speakerId };
        for (const s of sliders) {
            const val = clampSliderValue(s.slider, s.slider.value, s.defaultVal);
            settings[s.key] = val;
            s.slider.value = val;
            s.valueEl.textContent = Number(val).toFixed(s.decimals);
        }
        settings.ocrRemoveRuby = ocrRemoveRubyCheck.checked;
        settings.iconRightClickAction = iconRightClickSelect.value === 'options' ? 'options' : 'capture';
        settings.iconStyle = ICON_STYLE_VALUES.includes(iconStyleSelect.value)
            ? iconStyleSelect.value : SETTING_DEFAULTS.iconStyle;
        settings[CUSTOM_ICON_STORAGE_KEY] = isSafeRasterDataUrl(pendingCustomIcon)
            ? pendingCustomIcon : null;

        // キャラクター表示のときだけ、保存時点の選択キャラで表示情報を作り直す。
        // キャラクターを変えて保存した場合にページ内アイコンが古いままにならないようにする。
        let characterIcon = null;
        if (settings.iconStyle === 'character') {
            characterIcon = await buildCharacterIcon().catch(() => null);
            settings[CHARACTER_ICON_STORAGE_KEY] = characterIcon;
        }

        try {
            await chrome.storage.local.set(settings);
            updateIconStyleUI(characterIcon);
            if (settings.iconStyle === 'character' && characterIcon && !characterIcon.dataUrl) {
                showStatus('設定を保存しました（このキャラクターは名前で表示します）', 'success');
            } else {
                showStatus('設定を保存しました！', 'success');
            }
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
