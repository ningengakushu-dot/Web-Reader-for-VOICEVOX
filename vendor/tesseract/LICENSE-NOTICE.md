# 同梱サードパーティ資産のライセンス表記

このディレクトリ (`vendor/tesseract/`) には、OCR機能のために以下のサードパーティ製ソフトウェア・データが同梱されています。
いずれも Apache License 2.0 の下で配布されています。

## 1. tesseract.js

- バージョン: 6.0.1
- ライセンス: Apache License 2.0
- 入手元: https://www.npmjs.com/package/tesseract.js
- リポジトリ: https://github.com/naptha/tesseract.js
- 同梱ファイル: `tesseract.min.js`, `worker.min.js`,
  `tesseract.min.js.LICENSE.txt`, `worker.min.js.LICENSE.txt`
  (npm パッケージ内 `dist/` からそのままコピー)

## 2. tesseract.js-core

- バージョン: 6.1.2
- ライセンス: Apache License 2.0
- 入手元: https://www.npmjs.com/package/tesseract.js-core
- リポジトリ: https://github.com/naptha/tesseract.js-core
- 同梱ファイル: `core/tesseract-core-lstm.wasm.js`, `core/tesseract-core-simd-lstm.wasm.js`
  (LSTMエンジン専用の自己完結型ビルド。wasmバイナリはBase64埋め込み済みのため、
  別途 `.wasm` ファイルの配置は不要)

## 3. tessdata_best (jpn.traineddata / jpn_vert.traineddata)

- ライセンス: Apache License 2.0
- 入手元: https://github.com/tesseract-ocr/tessdata_best
- 同梱ファイル: `lang/jpn.traineddata`（横書き用）, `lang/jpn_vert.traineddata`（縦書き用）
  (いずれも直接ダウンロードしたもの。gzip圧縮はしていない生データ。
  高精度版。tessdata_fast は小さい文字の濁点・半濁点の誤認識が多かったため
  best を採用)

---

上記の同梱物はいずれも Apache License 2.0 の下で配布されています。ライセンス全文は、
このディレクトリの `LICENSE`（Apache License 2.0 全文）に同梱しています。オンライン版:
https://www.apache.org/licenses/LICENSE-2.0

また、tesseract.js の webpack ビルド出力が先頭バナーで参照する推移的依存のライセンス一覧
（`tesseract.min.js.LICENSE.txt`, `worker.min.js.LICENSE.txt`）も、上流 npm パッケージ
tesseract.js 6.0.1 の `dist/` からそのまま同梱しています。
