# OCR辞書データの出典とライセンス

本拡張機能に同梱している次のファイルは、画面OCR読み上げの精度向上のために使用する辞書データです。

- `ocr-words.txt` — 語彙リランキング用の語集合。OCRの誤認識で意味の通らない熟語（非語）になったとき、複数倍率の認識結果の中から「辞書に載っている語」を選んで補正するために使用します。

## 出典

このデータは **SudachiDict** から抽出・加工して作成した派生物です。

- SudachiDict: https://github.com/WorksApplications/SudachiDict
- Copyright (c) 2017–2024 Works Applications Co., Ltd.
- ライセンス: **Apache License, Version 2.0**

## 加工内容（Apache License 2.0 に基づく変更の明示）

原データ（small_lex.csv）から次の変換を行っています。オリジナルの語義・文法情報・読み等は含めていません。

- `ocr-words.txt`: 表層形のうち「2〜4字・漢字を含む内容語（名詞・動詞・形容詞・副詞・連体詞、ただし固有名詞を除く）」で、出現コストが一定未満（高頻度）のものを抽出し、重複を除いて改行区切りで格納。

## 帰属表示（Apache License 2.0 第4条に基づく）

```
SudachiDict
Copyright (c) 2017-2024 Works Applications Co., Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

なお、SudachiDict は形態素解析器 Sudachi 用の辞書であり、UniDic および IPAdic を源流とする
語彙情報を含みます。詳細な出典表示は上流リポジトリ（https://github.com/WorksApplications/SudachiDict）
の記載に従います。

## ライセンス全文

Apache License 2.0 の全文はリポジトリ直下の `LICENSE-APACHE-2.0` に同梱しています。
オンライン版: https://www.apache.org/licenses/LICENSE-2.0
