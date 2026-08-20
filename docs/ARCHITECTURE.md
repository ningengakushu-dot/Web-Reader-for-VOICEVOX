# アーキテクチャと変更ガイド

この文書は、Web Reader for VOICEVOX の責務境界と、変更時に壊してはいけない前提を短時間で把握するための開発者向け資料である。

## 実行コンテキスト

| コンテキスト | 主な読み込み順 | 主責務 |
|---|---|---|
| Service Worker | `background-entry.js` → `validation-utils.js` → `background-security.js` → `constants.js` → `background-bootstrap.js` → `background-playback.js` → `background-runtime.js` → `background-speech.js` | メッセージ受付、権限境界、VOICEVOX 呼び出し、offscreen 管理、タブ間状態、画面キャプチャ |
| Content Script | `content-guard.js` → `dom-text.js` → `content.js` | 選択テキスト・範囲抽出、ページ内 UI、ユーザー操作受付、再注入時のライフサイクル管理 |
| Offscreen | `constants.js`、OCR モジュール、`validation-utils.js` → `offscreen-security.js` → `offscreen-entry.js` → `offscreen-ocr.js` → `offscreen-audio.js` | 音声合成キュー・再生、OCR 実行、高コスト処理の入力境界 |
| 設定画面 | `constants.js` → `runtime-messaging.js` → `options.js` | 設定の復元・検証・保存、キャラクター取得、アイコン設定 |
| 画面 OCR 画面 | OCR モジュール → `runtime-messaging.js` → `capture.js` | キャプチャ表示、範囲選択、OCR、認識結果の読み上げ |

読み込み順は依存関係そのものなので、ファイル分割時に単なる並び替えを行わない。拡張機能ページについては CI が参照ファイルの存在とトップレベル宣言の衝突を検査する。

## Service Worker の責務分割

- `background-bootstrap.js`: インストール/更新処理、コンテキストメニュー、画面キャプチャ、範囲 OCR 要求、ショートカット入口。
- `background-playback.js`: 再生宛先タブ、`storage.session` 復元、タブ終了/遷移時の停止、offscreen の生成・送信。
- `background-runtime.js`: Runtime Messaging の振り分け、音声操作の直列化、VOICEVOX のキャラクター情報取得。
- `background-speech.js`: 読み上げ前の文字列整形と分割。実測に基づく規則を持つため、構造整理だけを理由にルールを変更しない。

`background.js` は既存の Node VM 回帰テストとの互換性を保つための生成バンドルであり、Chrome の Service Worker では読み込まない。正本は上記4ファイルで、`node tools/sync-background-bundle.mjs` が互換バンドルを生成する。`architecture-contract` CI が差分を検出する。

## Offscreen の責務分割

- `offscreen-entry.js`: 共有状態の初期化と background からのメッセージ受付。
- `offscreen-ocr.js`: OCR 要求の直列化、進捗通知、ワーカー寿命、範囲認識。
- `offscreen-audio.js`: 合成キュー、先読み、VOICEVOX API、再生、停止、世代トークンによる stale 処理破棄。

`offscreen.js` も既存回帰テスト互換用の生成バンドルで、実際の `offscreen.html` は上記3ファイルを順に読み込む。`node tools/sync-offscreen-bundle.mjs` と `architecture-contract` CI で一致を固定している。

## 共通モジュール

### `validation-utils.js`

副作用を持たない数値・矩形検証を提供する。background と offscreen で同じ OCR 座標上限を別々に持つと、片側だけ許可・拒否する不整合が起きるため共通化している。OCR 認識アルゴリズムの閾値ではなく、メッセージ境界の入力サイズだけを扱う。

### `runtime-messaging.js`

設定画面と画面 OCR 画面から background へ送る Chrome Runtime Messaging の薄いアダプターである。callback API、Promise 化、拡張更新直後の無効コンテキスト処理を一箇所に寄せる。メッセージ内容の認可・正規化はここでは行わず、background 側のセキュリティ境界を単一の判断元とする。

## 高リスク領域

`ocr-image.js`、`ocr-refine.js`、`ocr-common.js` は画像前処理・候補選択・縦横判定・認識結果整形が実測で積み上げられている。関数の統合、閾値の共通化、処理順変更はコード量が減っても精度回帰を起こし得るため、通常の構造整理から除外する。

`content.js` は Shadow DOM UI、再注入時の stale instance 置換、bfcache 復帰、パスワード入力除外、OCR 範囲選択中の window リスナー解放を1つのインスタンス寿命で管理している。物理分割の前提として `tests/content-lifecycle.test.js` で再注入・置換・復帰・解除の契約を固定した。ここはファイルサイズだけを理由に分割しない。

## 変更対象から見る回帰テスト

- メッセージ認可・数値上限: `tests/security-boundary.test.js`、`tests/security-validation-contract.test.js`
- Service Worker 状態: `tests/background-state-contract.test.js`、`tests/background-robustness.test.js`、`tests/background-concurrency.test.js`、`tests/background-lifecycle.test.js`
- 読み上げテキスト整形: `tests/speech-text.test.js`
- Offscreen 音声処理: `tests/offscreen-prefetch.test.js`、`tests/offscreen-synthesis-failure.test.js`、`tests/offscreen-playback.test.js`、`tests/offscreen-queue.test.js`
- Content Script 寿命/プライバシー: `tests/content-lifecycle.test.js`、`tests/content-privacy.test.js`、`tests/context-invalidation.test.js`
- 設定画面: `tests/options-safety.test.js`
- Runtime Messaging: `tests/runtime-messaging.test.js`
- OCR: `tests/ocr-*.test.js` と `tools/ocr-*`、精度根拠は `docs/OCR-ACCURACY.md`

## パッケージと CI

Chrome Web Store 提出物は `tools/pack.ps1` の許可リスト方式で生成する。実行時ファイルを追加しても、この一覧に無ければ CI 上のソースが正常でも配布 ZIP では欠落するため、依存追加とパッケージ変更を同じ変更単位で扱う。互換バンドル `background.js` / `offscreen.js` は提出物に含めず、実際に Chrome が読む分割ファイルだけを同梱する。

`.github/workflows/check.yml` は構文、主要回帰テスト、静的セキュリティ監査、manifest/HTML の参照整合性、リモートコード禁止、パッケージ対象の存在を確認する。`.github/workflows/architecture-contract.yml` は高リスクな状態遷移と生成バンドルの同期を確認する。`CodeQL` と `build-release-candidate` を含む全チェック成功を `develop` 向け PR の完了条件とする。

## 次に分割する場合

残る大規模ファイルでは `content.js` が候補だが、最初に切り出すなら「表示だけを担当する UI 構築」と「選択・範囲抽出/ライフサイクル」を跨がない境界に限定する。Shadow DOM、更新直後の stale script 対策、パスワード入力除外、OCR オーバーレイのリスナー解放について、分割対象の状態遷移テストが不足している場合は先にテストを追加する。
