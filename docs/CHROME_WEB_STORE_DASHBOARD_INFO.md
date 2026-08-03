# Chrome Web Store Developer Dashboard Info

このファイルは、Chrome Web Store デベロッパーダッシュボードの公開設定時に入力・参照するための情報をまとめています。

## 1. プライバシーに関する読み上げ (Privacy Read-me)
審査担当者がデータの取り扱いを確認するための説明文（英語併記を推奨）です。

### 英語 (Recommended)
This extension is designed to provide text-to-speech functionality using the locally installed VOICEVOX engine. All data processing is performed within the user's local environment. Specifically:
1. **No Data Collection**: The extension does not collect, store, or transmit any user data to external servers managed by the developer or any third parties.
2. **Local Processing Only**: Selected text for reading is sent only to the local VOICEVOX engine (`http://127.0.0.1:50021`) on the user's machine.
3. **Storage**: User settings (e.g., character ID, speech rate, pitch, intonation, volume, inter-sentence pause length, and icon position and size) are stored locally in the browser using `chrome.storage.local`.
4. **Text-First Reading**: When the user selects a region to read, the extension first reads the text that already exists in the page's DOM. On ordinary web pages this completes the request and **no screenshot is taken at all**. A screenshot is captured only when the selected region contains no retrievable text (text inside images, canvas drawings, cross-origin frames, PDFs).
5. **On-Device OCR**: In that fallback case, the captured screenshot is processed entirely within the browser using the bundled Tesseract.js (WASM) engine. On normal web pages the capture is passed to OCR in memory only; only on pages that open a dedicated region-selection tab (e.g. the PDF viewer) is the image — together with the source page title and URL, used solely to label the tab — briefly held in `chrome.storage.session` (discarded on browser exit or when a new capture is taken). In neither case is it ever transmitted anywhere.

### 日本語
この拡張機能は、ユーザーのローカル環境にインストールされたVOICEVOXエンジンを使用してテキスト読み上げ機能を提供します。
1. **データ収集なし**: 開発者や第三者のサーバーにユーザーデータを送信・保存することはありません。
2. **ローカル完結**: 読み上げ用のテキストは、ユーザーのPC内でのみ動作するVOICEVOXエンジン（デフォルト：127.0.0.1:50021）に送信されます。
3. **ストレージ**: 音声設定（キャラクター・速度・音の高さ・抑揚・音量・文の間）、アイコンの位置・サイズ・右クリック動作は、ブラウザのローカルストレージ（chrome.storage.local）にのみ保存されます。
4. **テキスト優先**: 範囲読み上げでは、まずページ内に既に存在するテキストをそのまま読み取ります。通常のWebページではこれで完結し、**スクリーンショットは一切取得しません**。画像内の文字・canvas描画・別オリジンのフレーム・PDFなど、テキストとして取り出せない範囲を選択した場合に限りキャプチャを行います。
5. **端末内OCR**: そのキャプチャは、同梱のTesseract.js（WASM）によりブラウザ内でのみ処理されます。通常のWebページではキャプチャ画像はメモリ上でのみOCRに渡され、PDFビューア等で範囲選択タブを開く場合に限り、画像とタブ表示用の元ページのタイトル・URLが `chrome.storage.session` に一時保持されます（ブラウザ終了時・新規キャプチャ時に破棄）。いずれの場合も外部への送信は一切ありません。

---

## 1-2. 単一目的 (Single Purpose)

### 英語 (Recommended)
The single purpose of this extension is to read aloud the text on the page the user is viewing — text the user selects, text retrieved directly from the page for a dragged region, and text contained in images or PDFs (obtained via on-device OCR) — using the VOICEVOX speech engine installed on the user's own machine. All features exist to serve that one purpose.

### 日本語
本拡張機能の単一目的は、ユーザーが閲覧しているページ上の文字を、ユーザー自身の端末にインストールされたVOICEVOX音声合成エンジンで読み上げることです。対象には、ユーザーが選択したテキスト、ドラッグ選択した範囲からページ内で直接取得した文字、および端末内のOCRで取得した画像・PDF上の文字を含みます。すべての機能はこの一つの目的のために存在します。

---

## 1-3. リモートコードの使用 (Remote Code)

**使用していません（No, I am not using remote code）。**

Tesseract.js本体・WASMコア・日本語学習データ（`jpn.traineddata` / `jpn_vert.traineddata`）・語彙辞書（`ocr-words.txt`）はすべて拡張機能パッケージに同梱しており、実行時に外部から取得するコードやデータはありません。`content_security_policy.extension_pages` の `'wasm-unsafe-eval'` は、同梱のWASMを `WebAssembly` で実行するためにのみ必要です。

---

## 2. 権限の使用理由 (Permission Justification)
ダッシュボードで必要になる場合がある説明です。

- **activeTab**: ユーザー操作（右クリックメニュー・ショートカット・ツールバーアイコン）を起点として、現在閲覧しているタブから選択テキストを取得し、また表示中タブのキャプチャ（`tabs.captureVisibleTab`）を行うために使用します。
- **scripting**: 拡張機能のインストール・更新より前から開かれていたタブでもコンテンツスクリプトが動作するよう、ユーザー操作時に `scripting.executeScript` で `content.js` / `dom-text.js` を注入し直すために使用します。範囲選択オーバーレイの表示と、選択範囲のページ内テキスト取得にも使用します。
- **offscreen**: MV3のService Workerでは音声再生（`Audio`）とWebAssemblyワーカーを実行できないため、オフスクリーンドキュメントを生成し、VOICEVOXで合成した音声の再生と、同梱Tesseract.js（WASM）による文字認識を行うために使用します。
- **storage**: ユーザーが選択したキャラクターや読み上げ速度などの設定を次回起動時も保持するために使用します。また、画面OCR読み上げのPDFビューア等向けタブ方式で、キャプチャ画像を `chrome.storage.session` で一時的に受け渡すためにも使用します（永続保存はしません）。
- **contextMenus**: 右クリックメニューから読み上げを開始するエントリーを追加するために使用します。
- **host_permissions (http://127.0.0.1:50021/*)**: ローカルで起動しているVOICEVOXエンジンのAPIと通信するために不可欠です。
- **host_permissions (`<all_urls>`)**: ページ内アイコンの右クリックから範囲読み上げを起動し、ページ内テキストを取得できない範囲でフォールバックする際の画面キャプチャ（`tabs.captureVisibleTab`）に必要です。ページ内アイコンの操作はChromeが `activeTab` を自動付与する操作（ツールバー・メニュー・ショートカット）に該当しないため、明示的なホスト権限が必要になります。コンテンツスクリプトが既に `<all_urls>` で動作しているため、この追加によって新たな権限警告は発生しません（キャプチャは常にユーザーの明示的な操作を起点にのみ実行され、取得した画像は端末内でのみ処理されます）。

---

## 3. バージョン別 ストア更新テキスト (Version Update Text)
ダッシュボードの「公開用メモ」やストア掲載の更新内容として使用できます。

### v1.4.0

#### 日本語
ページ内アイコンの見た目を選べるようにしました。オプション画面の「アイコンの見た目」から、シンプルな円（既定）／このアプリのアイコン／読み上げキャラクター／好きな画像 の4種類を選べます。アイコンを大きく表示したときの見栄えを改善するための機能です。「読み上げキャラクター」を選ぶと、いまどのキャラクターで読み上げるかがページ上で確認できます。キャラクター画像は拡張機能に同梱しておらず、ユーザーの端末で起動しているVOICEVOXから取得し、ブラウザの外へ送信されることはありません。キャラクター画像の利用が規約で明示的に許可されているキャラクターのみ画像で表示し、それ以外はキャラクター名で表示します。「好きな画像」ではPNG / JPEG / WebP / GIF（2MBまで）を指定でき、128pxの正方形に縮小して端末内に保存します。

#### English (Recommended)
The on-page icon can now be customized. Under "Icon appearance" in the options page you can choose from four styles: a simple circle (default), the extension's own icon, the current VOICEVOX character, or an image of your choice. This makes the icon look better when displayed at a larger size. Choosing the character style lets you see at a glance which voice is currently selected. Character images are not bundled with the extension: they are retrieved from the VOICEVOX application running on your own computer and never leave your browser. Only characters whose terms explicitly permit in-app use are shown as images; all others are shown by name. For a custom image, PNG / JPEG / WebP / GIF files up to 2 MB are accepted and are resized to a 128 px square stored on your device.

### v1.3.1

#### 日本語
安定性の修正です。短い文が続く場合に読み上げ中のアイコンが途中で待機状態に戻る問題、VOICEVOXエンジンが応答しないときに読み上げが止まったまま操作できなくなる問題、拡張機能の更新後に右クリックメニューが表示されなくなることがある問題をそれぞれ修正しました。あわせて、動作に必要なChromeのバージョン（119以降）を明示しました。

#### English (Recommended)
Stability fixes. Resolved an issue where the icon could return to the idle state mid-playback when reading a series of short sentences, an issue where playback could hang with no way to recover when the VOICEVOX engine stopped responding, and an issue where the context menu could disappear after the extension was updated. The minimum supported Chrome version (119+) is now declared explicitly.

### v1.3.0

#### 日本語
範囲ドラッグによる読み上げ機能を追加しました。閲覧中のページ上で読み上げたい範囲をドラッグ選択するだけで読み上げます。通常のWebページではページ内の文字をそのまま読み取るため、認識誤りがなく待ち時間もほとんどありません。画像内の文字・PDF・電子書籍ビューア・コピー禁止サイトなど、文字として取り出せない範囲は自動的に文字認識（OCR）へ切り替わります。ページの表示やサイズは一切変わらないため、本文を見ながら読み上げを聞けます。右クリックメニュー「画面をキャプチャしてOCR読み上げ」、ショートカット `Alt+Shift+O`、またはツールバーの拡張機能アイコンから起動できます。PDFビューア等ではキャプチャ画像のタブが開き、範囲選択と認識結果の編集ができます。選択肢や箇条書きの記号（ア・①・(1) など）のあとには短い「間」を入れて読み上げます。文字認識は同梱のTesseract.js（WASM）によりブラウザ内で完結し、画像が外部へ送信されることはありません。

#### English (Recommended)
Added drag-to-select region reading. Simply drag over the part of the page you want to hear. On ordinary web pages the extension reads the text already present in the page, so there are no recognition errors and virtually no wait. For regions where no text can be retrieved — text inside images, PDFs, e-book viewers, and copy-protected sites — it automatically falls back to on-device OCR. The page layout and size remain completely unchanged, so you can follow the text while listening. Start it from the context menu ("Capture screen and read with OCR"), the shortcut `Alt+Shift+O`, or the extension's toolbar icon. On PDF viewer pages, a capture tab opens instead, where you can select a region and edit the recognized text. A short pause is inserted after list and choice markers (e.g. ア, ①, (1)) so that options do not run together. OCR runs entirely inside the browser using the bundled Tesseract.js (WASM); captured images are never transmitted externally.

### v1.2.1

#### 日本語
ショートカットキーからの読み上げ起動の安定性を改善しました。あわせて、再生状態の通知を読み上げを要求したタブにのみ送るよう修正し、別タブ・別ウィンドウのアイコン表示が誤って切り替わる不具合を解消しました。ショートカットが効かない場合は `chrome://extensions/shortcuts` で割り当てをご確認ください。

#### English (Recommended)
Improved the stability of starting read-aloud via the keyboard shortcut. Playback status notifications are now sent only to the tab that requested playback, fixing an issue where the icon state could incorrectly change in other tabs or windows. If the shortcut does not work, please check the assignment at `chrome://extensions/shortcuts`.

---

## 3-2. パッケージ作成時の除外

ストア提出用ZIPには、拡張機能の動作に必要なファイルのみを含めます。
リポジトリのフォルダをそのまま zip すると掲載用の素材まで混入するため、
必ず `tools/pack.ps1` で作成してください（下記の一覧をそのまま実装しています）。

```
powershell -ExecutionPolicy Bypass -File tools\pack.ps1
```

出力: `dist/web-reader-for-voicevox-<version>.zip`

**含めるもの**: `manifest.json` / `background.js` / `content.js` / `dom-text.js` / `constants.js` / `ocr-common.js` / `ocr-image.js` / `ocr-refine.js` / `offscreen.html` / `offscreen.js` / `options.html` / `options.js` / `options.css` / `capture.html` / `capture.js` / `capture.css` / `ocr-words.txt` / `ocr-dictionary-NOTICE.md` / `LICENSE` / `LICENSE-APACHE-2.0` / `images/icon*.png` / `vendor/`

**除外するもの**: `README.md`、`docs/`、`tools/`、`dist/`、ストア掲載用の素材（`images/Web-Reader-for-VOICEVOX_*.png`、`images/Web_Reader_for_VOICEVOX.mp4`）、`.claude/`、`AGENTS.md`、`CLAUDE.md`、`audio/`

---

## 4. プライバシーポリシーの連絡先
`PRIVACY.md` に記載されているURLと同じものを設定してください。
`https://github.com/ningengakushu-dot/Web-Reader-for-VOICEVOX/blob/main/docs/PRIVACY.md`
（※公開時はGitHubリポジトリの直リンクが便利です）
