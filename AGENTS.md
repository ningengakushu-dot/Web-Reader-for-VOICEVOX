# AI・自動化ツール向け開発ガードレール

このリポジトリを AI や自動化ツールで変更するときは、見た目の整理より既存挙動の維持を優先する。

## 変更してはいけない前提

- `main` へ直接コミットしない。通常は `develop` から作業ブランチを作り、`develop` 向け PR にする。
- OCR の閾値、処理順、候補融合、縦横判定、画像前処理を「単純化」のために変更しない。変更する場合は `docs/OCR-ACCURACY.md` と既存コーパスを読み、変更前後を実測する。
- Manifest V3 の service worker / offscreen / content script の境界を崩さない。Web ページ由来の値は信頼しない。
- `background-security.js` と `offscreen-security.js` より前に `validation-utils.js` を読み込む。検証を高コストな OCR・音声合成処理の後段へ移さない。
- Service Worker の実行元は `background-bootstrap.js` / `background-playback.js` / `background-runtime.js` / `background-speech.js`。`background.js` は既存 VM テスト互換用の生成バンドルなので直接編集しない。変更後は `node tools/sync-background-bundle.mjs` で同期する。
- Offscreen の実行元は `offscreen-entry.js` / `offscreen-ocr.js` / `offscreen-audio.js`。`offscreen.js` は既存 VM テスト互換用の生成バンドルなので直接編集しない。変更後は `node tools/sync-offscreen-bundle.mjs` で同期する。
- `options.js` と `capture.js` より前に `runtime-messaging.js` を読み込む。更新直後の無効コンテキストを例外としてページへ漏らさない。
- 新しい実行時ファイルを追加した場合は、HTML / manifest / service worker の読み込み元だけでなく `tools/pack.ps1` の同梱一覧も更新する。
- 外部 URL のスクリプト、`eval`、`new Function`、外部 `importScripts` を追加しない。

## 変更時の確認

- 変更対象に既存回帰テストが無い場合は、可能なら先に挙動固定テストを追加する。
- 最低限 `node --check`、関連テスト、`node tools/security-audit.mjs` を実行する。
- PR では `check`、`architecture-contract`、`CodeQL`、`build-release-candidate` が成功していることを確認する。
- OCR・読み上げ品質へ触れた場合は CI だけで完了扱いにせず、既存ベンチマークまたは実機確認を行う。
- コメントは処理内容の言い換えではなく、制約や実測に基づく「なぜ」を残す。

## 責務の参照先

主要コンテキスト、読み込み順、変更時に見るテストは `docs/ARCHITECTURE.md` を参照する。
