# アーキテクチャと変更ガイド

この文書は、Web Reader for VOICEVOX の責務境界と、変更時に壊してはいけない前提を短時間で把握するための開発者向け資料である。

## 実行コンテキスト

| コンテキスト | 主なファイル | 主責務 |
|---|---|---|
| Service Worker | `background-entry.js` → `validation-utils.js` → `background-security.js` → `background.js` | メッセージ受付、権限境界、VOICEVOX 呼び出し、offscreen 管理、タブ間状態、画面キャプチャ |
| Content Script | `content-guard.js` → `dom-text.js` → `content.js` | 選択テキスト・範囲抽出、ページ内 UI、ユーザー操作受付 |
| Offscreen | `constants.js`、OCR モジュール、`validation-utils.js` → `offscreen-security.js` → `offscreen.js` | 音声合成キュー・再生、OCR 実行、高コスト処理の入力境界 |
| 設定画面 | `constants.js` → `runtime-messaging.js` → `options.js` | 設定の復元・検証・保存、キャラクター取得、アイコン設定 |
| 画面 OCR 画面 | OCR モジュール → `runtime-messaging.js` → `capture.js` | キャプチャ表示、範囲選択、OCR、認識結果の読み上げ |

読み込み順は依存関係そのものなので、ファイル分割時に単なる並び替えを行わない。拡張機能ページについては CI が参照ファイルの存在とトップレベル宣言の衝突を検査する。

## 共通モジュール

### `validation-utils.js`

副作用を持たない数値・矩形検証を提供する。background と offscreen で同じ OCR 座標上限を別々に持つと、片側だけ許可・拒否する不整合が起きるため共通化している。OCR 認識アルゴリズムの閾値ではなく、メッセージ境界の入力サイズだけを扱う。

### `runtime-messaging.js`

設定画面と画面 OCR 画面から background へ送る Chrome Runtime Messaging の薄いアダプターである。callback API、Promise 化、拡張更新直後の無効コンテキスト処理を一箇所に寄せる。メッセージ内容の認可・正規化はここでは行わず、background 側のセキュリティ境界を単一の判断元とする。

## 高リスク領域

`ocr-image.js`、`ocr-refine.js`、`ocr-common.js` は画像前処理・候補選択・縦横判定・認識結果整形が実測で積み上げられている。関数の統合、閾値の共通化、処理順変更はコード量が減っても精度回帰を起こし得るため、通常の構造整理から除外する。

`background.js`、`content.js`、`offscreen.js` は依然として大きいが、Chrome のライフサイクル、タブ状態、再生キュー、DOM 選択状態と密接に結びつく。分割する場合は、先に対象状態の遷移テストを追加し、外部から見えるメッセージ型・storage キー・通知順を固定してから行う。

## 変更対象から見る回帰テスト

- メッセージ認可・数値上限: `tests/security-boundary.test.js`、`tests/security-validation-contract.test.js`
- 設定画面: `tests/options-safety.test.js`
- Runtime Messaging: `tests/runtime-messaging.test.js`、`tests/context-invalidation.test.js`
- background のタブ・要求管理: `tests/background-robustness.test.js`、`tests/background-concurrency.test.js`、`tests/background-lifecycle.test.js`
- 音声テキスト整形: `tests/speech-text.test.js`
- offscreen 音声処理: `tests/offscreen-prefetch.test.js`、`tests/offscreen-synthesis-failure.test.js`、`tests/offscreen-playback.test.js`、`tests/offscreen-queue.test.js`
- OCR: `tests/ocr-*.test.js` と `tools/ocr-*`、精度根拠は `docs/OCR-ACCURACY.md`
- プライバシー境界: `tests/content-privacy.test.js`

## パッケージと CI

Chrome Web Store 提出物は `tools/pack.ps1` の許可リスト方式で生成する。実行時ファイルを追加しても、この一覧に無ければ CI 上のソースが正常でも配布 ZIP では欠落するため、依存追加とパッケージ変更を同じ変更単位で扱う。

`.github/workflows/check.yml` は構文、主要回帰テスト、静的セキュリティ監査、manifest/HTML の参照整合性、リモートコード禁止、パッケージ対象の存在を確認する。`CodeQL` と `build-release-candidate` も `develop` 向け PR の完了条件とする。

## 今後の分割候補

優先度は「サイズ」だけでなく、変更頻度と状態境界の明確さで決める。

1. `background.js`: 音声要求の直列化、再生タブ状態、OCR要求世代管理を、既存メッセージ契約を変えずに分離できるか検討する。
2. `offscreen.js`: 音声キューと OCR キューの状態機械を、通知順の回帰テストを増やした後に分離する。
3. `content.js`: ページ内 UI と選択・範囲抽出の依存を整理する。ただし Shadow DOM、更新直後の stale script 対策、パスワード入力除外を維持する。

これらは今回のリファクタリングでは、精度・ライフサイクル・通知順に対する変更リスクが利益を上回るため、無理に分割していない。
