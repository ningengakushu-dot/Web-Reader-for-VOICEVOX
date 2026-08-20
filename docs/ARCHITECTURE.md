# アーキテクチャと変更ガイド

この文書は、Web Reader for VOICEVOX の責務境界と、変更時に壊してはいけない前提を短時間で把握するための開発者向け資料である。

## 実行コンテキスト

| コンテキスト | 主な読み込み順 | 主責務 |
|---|---|---|
| Service Worker | `background-entry.js` → `validation-utils.js` → `background-security.js` → `constants.js` → `background-bootstrap.js` → `background-content-scripts.js` → `background-playback.js` → `background-runtime.js` → `background-speech.js` | メッセージ受付、権限境界、VOICEVOX 呼び出し、offscreen 管理、タブ間状態、画面キャプチャ、Content Script 再注入 |
| Content Script | `content-guard.js` → `dom-text.js` → `content-common.js` → `content-indicator.js` → `content-reading.js` → `content-notice.js` → `content-ocr.js` → `content-entry.js` | 選択テキスト・範囲抽出、ページ内 UI、ユーザー操作受付、再注入時のライフサイクル管理 |
| Offscreen | `constants.js`、OCR モジュール、`validation-utils.js` → `offscreen-security.js` → `offscreen-entry.js` → `offscreen-ocr.js` → `offscreen-audio.js` | 音声合成キュー・再生、OCR 実行、高コスト処理の入力境界 |
| 設定画面 | `constants.js` → `runtime-messaging.js` → `options.js` | 設定の復元・検証・保存、キャラクター取得、アイコン設定 |
| 画面 OCR 画面 | OCR モジュール → `runtime-messaging.js` → `capture.js` | キャプチャ表示、範囲選択、OCR、認識結果の読み上げ |

読み込み順は依存関係そのものなので、ファイル分割時に単なる並び替えを行わない。拡張機能ページについては CI が参照ファイルの存在とトップレベル宣言の衝突を検査する。

## Service Worker の責務分割

- `background-bootstrap.js`: インストール/更新処理、コンテキストメニュー、画面キャプチャ、範囲 OCR 要求、ショートカット入口。
- `background-content-scripts.js`: manifest の Content Script 一覧を動的再注入にも反映する production 専用設定。manifest と再注入経路が別々の一覧を持たないようにする。
- `background-playback.js`: 再生宛先タブ、`storage.session` 復元、タブ終了/遷移時の停止、offscreen の生成・送信。
- `background-runtime.js`: Runtime Messaging の振り分け、音声操作の直列化、VOICEVOX のキャラクター情報取得。
- `background-speech.js`: 読み上げ前の文字列整形と分割。実測に基づく規則を持つため、構造整理だけを理由にルールを変更しない。

`background.js` は既存の Node VM 回帰テストとの互換性を保つための生成バンドルであり、Chrome の Service Worker では読み込まない。正本となる挙動コードは `background-bootstrap.js` / `background-playback.js` / `background-runtime.js` / `background-speech.js` で、`node tools/sync-background-bundle.mjs` が互換バンドルを生成する。`background-content-scripts.js` は manifest と注入一覧を接続する production 専用設定なので互換バンドルには含めない。`architecture-contract` CI は実際の `background-entry.js` 経路による状態遷移テストと互換バンドルの同期を両方確認する。

## Content Script の責務分割

従来の約 1,200 行の `content.js` は、同一の `VVRadioReader` インスタンス寿命を維持したまま責務別に分割した。状態を複数インスタンスへ分散せず、各モジュールは prototype に機能群を提供し、最後の `content-entry.js` だけがインスタンスを生成する。

- `content-common.js`: 生存中インスタンスへの再注入を早期終了させる共有ガード、共通定数、Shadow DOM ホスト生成。
- `content-indicator.js`: インジケーターの生成、見た目、ドラッグ、位置保存、再生状態表示。
- `content-reading.js`: 選択テキスト取得、パスワード入力除外、ショートカット、Runtime Messaging、読み上げ開始/停止要求。
- `content-notice.js`: 更新案内の取得・表示・一時非表示。
- `content-ocr.js`: OCR 範囲選択、DOM テキスト優先抽出、画面 OCR 要求、進捗・エラー表示。
- `content-entry.js`: `VVRadioReader` の状態初期化、bfcache 復帰、stale instance の置換、リスナーと UI の一括解放。ライフサイクルの単一管理点。

manifest の `content_scripts[0].js` が production の読み込み順の正本であり、Service Worker の動的再注入も `background-content-scripts.js` を通じて同じ一覧を使用する。これにより、通常注入とフォールバック注入でファイルの欠落や順序差が生じないようにしている。

`tests/content-source.js` は責務別 Content Script を VM テスト向けに同じ順序で連結するテスト補助であり、拡張機能には同梱しない。旧 `content.js` は production・提出物ともに使用しない。

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

Content Script は物理分割後も、再注入時の stale instance 置換、bfcache 復帰、パスワード入力除外、OCR 範囲選択中の window リスナー解放、`regionReadGeneration` による古い非同期結果の破棄を1つのインスタンス寿命で管理する。この状態を「さらに小さくする」目的だけで複数のオブジェクト寿命へ分散しない。`tests/content-lifecycle.test.js`、`tests/content-privacy.test.js`、`tests/context-invalidation.test.js` がこの境界を固定する。

## 変更対象から見る回帰テスト

- メッセージ認可・数値上限: `tests/security-boundary.test.js`、`tests/security-validation-contract.test.js`
- Service Worker 状態: `tests/background-state-contract.test.js`、`tests/background-robustness.test.js`、`tests/background-concurrency.test.js`、`tests/background-lifecycle.test.js`
- 読み上げテキスト整形: `tests/speech-text.test.js`
- Offscreen 音声処理: `tests/offscreen-prefetch.test.js`、`tests/offscreen-synthesis-failure.test.js`、`tests/offscreen-playback.test.js`、`tests/offscreen-queue.test.js`
- Content Script 寿命/プライバシー/注入順: `tests/content-lifecycle.test.js`、`tests/content-privacy.test.js`、`tests/context-invalidation.test.js`
- 設定画面: `tests/options-safety.test.js`
- Runtime Messaging: `tests/runtime-messaging.test.js`
- OCR: `tests/ocr-*.test.js` と `tools/ocr-*`、精度根拠は `docs/OCR-ACCURACY.md`

## パッケージと CI

Chrome Web Store 提出物は `tools/pack.ps1` の許可リスト方式で生成する。実行時ファイルを追加しても、この一覧に無ければ CI 上のソースが正常でも配布 ZIP では欠落するため、依存追加とパッケージ変更を同じ変更単位で扱う。互換バンドル `background.js` / `offscreen.js` と旧 `content.js` は提出物に含めず、実際に Chrome が読む責務別ファイルだけを同梱する。

`.github/workflows/check.yml` は構文、主要回帰テスト、静的セキュリティ監査、manifest/HTML の参照整合性、リモートコード禁止、パッケージ対象の存在を確認する。`.github/workflows/architecture-contract.yml` は高リスクな状態遷移、Content Script の寿命/プライバシー/注入順、生成バンドルの同期を確認する。`CodeQL` と `build-release-candidate` を含む全チェック成功を `develop` 向け PR の完了条件とする。

## 今後の構造変更

主要な大規模実行ファイルの責務分割は完了している。以降はファイル行数だけを目的に細分化せず、変更頻度・テスト容易性・実測した性能ボトルネックに根拠がある場合だけ追加の境界を導入する。

性能改善は構造整理と同じ変更に混ぜず、ベンチマークで変更前後を比較できるものから独立して行う。特に OCR 認識回数・画像前処理・読み上げ分割を性能だけを理由に削減しない。
