# Web Reader for VOICEVOX

> **Webサイトのテキスト読み上げを、あなたの好きな声で。**
> VOICEVOXエンジンの力を借りて、ブラウザ上のテキストを滑らかに読み上げるChrome拡張機能です。
<img width="1280" height="800" alt="Web-Reader-for-VOICEVOX_1280" src="https://github.com/user-attachments/assets/3c9b676e-6856-4a6a-8f44-957c85c2306e" />


## 主な機能

- **スマートな読み上げ操作**
  - ページ上のテキストを選択し、右クリックメニューまたはショートカット（`Alt+Shift+U`）で即座に再生。
  - マウスのサイドボタンで上記ショートカットを設定しておくと楽です。
- **VOICEVOXキャラクター完全対応**
  - オプション画面から、お気に入りのキャラクターを簡単に選択。速度・ピッチ・抑揚・音量・文間の長さを自由に調整できます。
- **割り込み再生**
  - 再生中に別のテキストを選択して読み上げを指示すると、現在の再生を即座に停止して新しいテキストを読み上げます。
  - クレンジング機能：URLや不要な改行を自動で検出・整形してから読み上げます。
- **あらゆるサイトに対応**
  - Google Chrome最新の「Offscreen API」を採用。セキュリティ制限（CSP）の厳しいNotionや技術系ブログ等でも、安定した音声再生が可能です。
- **デザインを崩さない設計**
  - Webサイトのデザインに干渉しない「Shadow DOM」技術を採用。どんなサイトでもレイアウトを崩さず、安定して動作します。

## 動作要件（※重要）
- 本拡張機能を使用するには、別途「VOICEVOX」ソフトウェアのインストールと起動が必要です。
  1. 公式サイト（https://voicevox.hiroshiba.jp/）からVOICEVOXをインストールしてください。
  2. VOICEVOXを起動しておきます（デフォルト設定のままご使用ください）
  3. ブラウザでテキストを選択し、読み上げを開始してください。

## インストール方法

1. このリポジトリをダウンロードまたはクローンします。
2. Chromeで `chrome://extensions/` を開きます。
3. 右上の **「デベロッパーモード」** をONにします。
4. **「パッケージ化されていない拡張機能を読み込む」** を選択し、本プロジェクトのフォルダを指定します。

## プライバシーと安全性
   - 読み上げ対象のテキストデータは、ローカル環境で起動しているVOICEVOXエンジンとの通信に使用されます。


## 技術仕様

- **Manifest V3 準拠**: セキュリティとパフォーマンスに優れた最新仕様。
- **Service Worker**: バックグラウンドでの安定したAPI通信。
- **Offscreen API**: CSP制限を回避するための独立したオーディオ再生環境。
- **Audio Memory Safety**: 再生済みのBlob URLを即時解放し、ブラウザの負荷を最小限に抑制。
- **Visual Isolation**: Shadow DOM (mode: closed) を使用し、サイト側のCSS干渉を完全に遮断。

---

## 開発支援

このアプリを気に入っていただけた場合は、開発の支援をいただけると嬉しいです。

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=github)](https://github.com/sponsors/ningengakushu-dot)

## 利用規約・免責事項

本アプリを使用する前に、必ず以下のドキュメントをご確認ください。
本アプリを使用した時点で、これらに同意したものとみなされます。

- [利用規約](https://github.com/ningengakushu-dot/Web-Reader-for-VOICEVOX/blob/main/docs/TERMS.md)
- [プライバシーポリシー](https://github.com/ningengakushu-dot/Web-Reader-for-VOICEVOX/blob/main/docs/PRIVACY.md)

**【重要：自己責任の原則】**

- 本アプリは個人によって開発されたものであり、無償で提供されています。
- 本アプリの使用によって生じた、いかなる損害（PCの不具合、法的トラブル等）についても開発者は責任を負いません。すべて**利用者の自己責任**においてご利用ください。

**【ライセンス・権利関係】**
- ソースコードの利用はMIT Licenseに準じます。
- 音声の生成には[VOICEVOX](https://voicevox.hiroshiba.jp/)を使用しています。生成された音声の利用（動画への使用など）については、必ずVOICEVOXおよび各ボイスキャラクターの利用規約を遵守してください。
- **【重要】** 本ツールで生成した音声を公開する場合、必ず「VOICEVOX:（使用キャラクター名）」のようなクレジット表記が必要です。詳細は[利用規約](https://github.com/ningengakushu-dot/Web-Reader-for-VOICEVOX/blob/main/docs/TERMS.md)をご確認ください。
