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

Tesseract.js本体・WASMコア・日本語学習データ（`jpn.traineddata` / `jpn_vert.traineddata`）はすべて拡張機能パッケージに同梱しており、実行時に外部から取得するコードやデータはありません。`content_security_policy.extension_pages` の `'wasm-unsafe-eval'` は、同梱のWASMを `WebAssembly` で実行するためにのみ必要です。

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

### v1.2.1 → v1.4.4（今回の提出用・累積）

ストアで公開中のバージョンは **v1.2.1** のため、既存ユーザーには v1.3.0 以降の変更がまとめて届く。
今回の提出ではこの累積版を掲載文として使う。

#### 日本語

今回の更新では、公開中のv1.2.1から機能が大きく増えています。

■ 新機能：画面OCR読み上げ（β版）

画像内の文字・PDF・電子書籍ビューア・コピー禁止サイトなど、これまで選択できなかった文字を読み上げられるようになりました。閲覧中のページの上で読み上げたい範囲をドラッグするだけで、ページの表示やサイズを一切変えずに読み上げます。通常のWebページではページが持っている文字をそのまま読み取るため、読み間違いがなく待ち時間もほとんどありません。文字として取り出せない範囲だけが自動的に文字認識（OCR）へ切り替わります。縦書き・横書きは自動判定するため、縦書きの小説にも対応します。右クリックメニュー「画面をキャプチャしてOCR読み上げ」、ショートカット（Alt+Shift+O）、ツールバーの拡張機能アイコンから起動できます。PDFビューアなど範囲選択ができない画面では、キャプチャ画像のタブが開き、範囲選択と認識結果の編集ができます。

※OCRはβ版です。文書によっては読み間違いや読み飛ばしが起こり、認識に10〜20秒ほどかかります。枠で囲まれた短いボタンの文字が復元しないこと、表の列の区切りが読み上げに現れないことがあります。文字として選択できるページではOCRを介さないため、これらの制約は当てはまりません。

文字認識は同梱のTesseract.js（WASM）によりブラウザ内で完結し、画像が外部へ送信されることはありません。

■ 新機能：ページ内アイコンのカスタマイズ

アイコンをドラッグで好きな位置へ移動でき、位置は自動的に保存されます。大きさは16pxから128pxまで選べます（既定は32px）。見た目も「シンプルな円」「このアプリのアイコン」「読み上げキャラクター」「好きな画像」の4種類から選べます。「読み上げキャラクター」を選ぶと、いまどのキャラクターで読み上げるかがページ上で確認できます。キャラクター画像は拡張機能に同梱しておらず、お使いの端末で起動しているVOICEVOXから取得するため、ブラウザの外へ送信されることはありません。アイコンの右クリックで画面OCR読み上げをすぐ開始できます（オプション画面から「設定を開く」動作に変更できます）。

■ 読み上げの品質と安定性

多様な文章での途切れ・不自然さを見直しました。句点の無い長い箇条書きや、短い見出しの直後の長い段落で文の間に無音が空く問題、記号・罫線だけの行や不可視文字による無音・欠落、日付「2026/08/16」・時刻「10:30」・金額「¥12,800」の読み、崩れたURLの読み飛ばしを改善しています。横に並んだメニュー項目が区切りなく続けて読まれる問題、表形式のテキストで行と列が混ざって読まれる問題、「±」「≒」「〜」「°」など読み上げると意味が変わる記号の読みも修正しました。短い文が続くときにアイコンが待機状態へ戻る問題、VOICEVOXエンジンが応答しないときに操作できなくなる問題、更新後に右クリックメニューが表示されなくなる問題もあわせて修正しています。

■ ショートカットについて

新しく追加された画面OCR読み上げのショートカット（Alt+Shift+O）は、他の拡張機能と割り当てが重なっていると有効にならないことがあります。chrome://extensions/shortcuts で確認・変更できます。

■ 動作環境

Chrome 119以降が必要です。読み上げには、お使いのPCでVOICEVOXを起動しておく必要があります。

### v1.4.4

#### 日本語
表の罫線やボタンの枠がある画像をOCRすると、行の見出しやボタンの文字が丸ごと読み飛ばされる問題を修正しました。文字の画よりずっと長い直線だけを認識前に取り除くようにしています。罫線の無い文書は一切変更していません。あわせて、ニュース記事・技術文書・表・箇条書き・アプリのUIなど、縦書き小説以外の媒体でもOCR精度を確認・改善し、画面OCRの待ち時間を短縮しました（文字が十分に鮮明なときは複数倍率での再認識を省略し、実運用でおよそ1/3に短縮。認識結果は変更していません）。VOICEVOXエンジンが一時的でなく繰り返し応答を拒否する状況（話者IDの不一致、他アプリによるポート競合など）で、無意味な再試行を繰り返したり分かりにくいエラーが表示されたりしないよう修正しました。範囲ドラッグ読み上げでは、横に並んだメニュー項目が区切りなく続けて読まれる問題や、表形式のテキストで行・列が混ざって読まれる問題を修正し、「±」「≒」「〜」「°」など読み上げると意味が変わる記号を正しく読むようにしました。精度への寄与が小さいことを実測で確認できた語彙辞書（約1MB）を削除し、パッケージを軽量化しています。文字認識は引き続き同梱のTesseract.js（WASM）によりブラウザ内で完結し、画像が外部へ送信されることはありません。

#### English (Recommended)
Fixed an issue where OCR on images containing table borders or button outlines could drop entire words — row labels, button text — because only very long, thin lines (much longer than any character stroke) are now removed before recognition. Documents without such lines are completely unaffected. Also verified and improved OCR accuracy on media beyond vertical novels — news articles, technical documents, tables, bullet lists, and app UI. Reduced screen-OCR wait time: when text is already sharp, the extension now skips the multi-scale re-recognition pass, cutting real-world wait time by roughly two-thirds with no change to the recognized text. Fixed excessive retries and confusing error messages when the VOICEVOX engine persistently rejects requests rather than failing once (e.g. a mismatched speaker ID, or another process using the same port). Drag-to-select reading no longer runs horizontally laid-out menu items together without a pause, and no longer merges rows and columns of pre-formatted text (such as tables) into one another. Symbols that change meaning when silently dropped ("±", "≒", "〜", "°") are now read aloud correctly. Removed a roughly 1 MB word-vocabulary dictionary whose measured contribution to accuracy was negligible, shrinking the package. OCR still runs entirely inside the browser using the bundled Tesseract.js (WASM); captured images are never transmitted externally.

### v1.4.3

#### 日本語
縦書きの文字認識（OCR）精度を改善しました。組版方向を断定できない範囲は縦横の両モデルで認識して比較し、余分に挿入された重複文字の除去と、短い列の低確信度漢字の局所再確認を追加しています。あわせて、精度を安定して保証できなかった「ルビ（ふりがな）優先読み」設定を削除し、OCRの進捗表示が開始直後にほぼ100%で止まって見える問題を修正しました。ページ内アイコンのサイズ上限を64pxから128pxへ拡張しています。読み上げでは、句点の無い長い箇条書きや短い見出しの直後の長い段落で文の間に無音が空く問題、記号だけの行や不可視文字による無音、日付・時刻・金額の読み、崩れたURLの読み飛ばしなど、多様な文章での途切れ・不自然さを見直しました。罫線付きの表の画像をOCRすると意味のない文字列になっていた問題も修正しています。文字認識は引き続き同梱のTesseract.js（WASM）によりブラウザ内で完結し、画像が外部へ送信されることはありません。

#### English (Recommended)
Improved OCR accuracy for vertical Japanese text. When the text direction cannot be determined reliably, the region is now recognized with both the horizontal and vertical models and compared; duplicated characters inserted by the recognizer are removed, and low-confidence kanji in short columns are re-checked locally. The "prefer furigana" OCR option, whose accuracy could not be guaranteed, has been removed, and the OCR progress bar no longer appears to stall near 100% right after starting. The maximum size of the on-page icon has been raised from 64 px to 128 px. Reading is smoother across varied content: long unpunctuated lists and long paragraphs after short headings no longer leave gaps of silence between sentences, symbol-only lines and invisible characters no longer cause silence or dropped text, dates, times and prices are read naturally, and broken URLs are skipped. OCR of images containing ruled tables, which previously produced garbage text, now reads the cell contents. OCR still runs entirely inside the browser using the bundled Tesseract.js (WASM); captured images are never transmitted externally.

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

**含めるもの**: `manifest.json` / `background-entry.js` / `background-security.js` / `background.js` / `content-guard.js` / `content.js` / `dom-text.js` / `constants.js` / `ocr-common.js` / `ocr-image.js` / `ocr-refine.js` / `offscreen.html` / `offscreen-security.js` / `offscreen.js` / `options.html` / `options.js` / `options.css` / `capture.html` / `capture.js` / `capture.css` / `LICENSE` / `LICENSE-APACHE-2.0` / `images/icon*.png` / `vendor/`

**除外するもの**: `README.md`、`docs/`、`tools/`、`dist/`、ストア掲載用の素材（`images/Web-Reader-for-VOICEVOX_*.png`、`images/Web_Reader_for_VOICEVOX.mp4`）、`.claude/`、`AGENTS.md`、`CLAUDE.md`、`audio/`

---

## 3-3. キャラクター画像のクレジット表記（ストア掲載文へ必ず含める）

ページ内アイコンにキャラクター画像を表示する機能があるため、ストアの説明文の末尾に
次の一文を入れる。WhiteCUL（ZAN-SHIN）と離途（LitMus）は、権利者の規約で
「第三者が閲覧できる箇所へのクレジット表記」が許諾の条件になっている。

```
キャラクター画像は本拡張機能に同梱しておらず、お使いの端末で起動しているVOICEVOXから取得して表示します。画像の権利は各キャラクターの権利者に帰属します。本拡張機能は無償で提供される非商用のソフトウェアであり、各権利者の利用規約にもとづいて画像を表示しています。

画像を表示するキャラクター: ずんだもん / 四国めたん / 九州そら / 中国うさぎ / 中部つるぎ / あんこもん / 東北ずん子 / 東北イタコ / 東北きりたん / 玄野武宏 / 白上虎太郎 / 青山龍星 / 雀松朱司 / 麒ヶ島宗麟 / 黒沢冴白 / WhiteCUL / No.7 / ぞん子 / 離途 / 冥鳴ひまり / 雨晴はう / 剣崎雌雄 / 猫使アル / 猫使ビィ
（VOICEVOX:WhiteCUL、VOICEVOX:離途 ほか、各キャラクターの権利は各権利者に帰属します）

上記以外のキャラクターは、権利上の確認が取れていないためキャラクター名で表示します。
```

キャラクターを追加・削除したときは、この一覧と `constants.js` の
`ICON_IMAGE_ALLOWED_CHARACTERS` を必ず揃えること。

---

## 4. プライバシーポリシーの連絡先
`PRIVACY.md` に記載されているURLと同じものを設定してください。
`https://github.com/ningengakushu-dot/Web-Reader-for-VOICEVOX/blob/main/docs/PRIVACY.md`
（※公開時はGitHubリポジトリの直リンクが便利です）
