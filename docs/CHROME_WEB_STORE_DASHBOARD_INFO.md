# Chrome Web Store Developer Dashboard Info

このファイルは、Chrome Web Store デベロッパーダッシュボードの公開設定時に入力・参照するための情報をまとめています。

## 1. プライバシーに関する読み上げ (Privacy Read-me)
審査担当者がデータの取り扱いを確認するための説明文（英語併記を推奨）です。

### 英語 (Recommended)
This extension is designed to provide text-to-speech functionality using the locally installed VOICEVOX engine. All data processing is performed within the user's local environment. Specifically:
1. **No Data Collection**: The extension does not collect, store, or transmit any user data to external servers managed by the developer or any third parties.
2. **Local Processing Only**: Selected text for reading is sent only to the local VOICEVOX engine (`http://127.0.0.1:50021`) on the user's machine.
3. **Storage**: User settings (e.g., character ID, speech rate, icon position and size) are stored locally in the browser using `chrome.storage.local`.

### 日本語
この拡張機能は、ユーザーのローカル環境にインストールされたVOICEVOXエンジンを使用してテキスト読み上げ機能を提供します。
1. **データ収集なし**: 開発者や第三者のサーバーにユーザーデータを送信・保存することはありません。
2. **ローカル完結**: 読み上げ用のテキストは、ユーザーのPC内でのみ動作するVOICEVOXエンジン（デフォルト：127.0.0.1:50021）に送信されます。
3. **ストレージ**: 音声設定やアイコンの位置・サイズなどの設定値は、ブラウザのローカルストレージ（chrome.storage.local）にのみ保存されます。

---

## 2. 権限の使用理由 (Permission Justification)
ダッシュボードで必要になる場合がある説明です。

- **activeTab / scripting**: ユーザーが現在閲覧しているタブから選択されたテキストを取得するために必要です。
- **storage**: ユーザーが選択したキャラクターや読み上げ速度の設定を次回起動時も保持するために使用します。
- **contextMenus**: 右クリックメニューから読み上げを開始するエントリーを追加するために使用します。
- **host_permissions (http://127.0.0.1:50021/*)**: ローカルで起動しているVOICEVOXエンジンのAPIと通信するために不可欠です。

---

## 3. バージョン別 ストア更新テキスト (Version Update Text)
ダッシュボードの「公開用メモ」やストア掲載の更新内容として使用できます。

### v1.2.1

#### 日本語
ショートカットキーからの読み上げ起動の安定性を改善しました。あわせて、再生状態の通知を読み上げを要求したタブにのみ送るよう修正し、別タブ・別ウィンドウのアイコン表示が誤って切り替わる不具合を解消しました。ショートカットが効かない場合は `chrome://extensions/shortcuts` で割り当てをご確認ください。

#### English (Recommended)
Improved the stability of starting read-aloud via the keyboard shortcut. Playback status notifications are now sent only to the tab that requested playback, fixing an issue where the icon state could incorrectly change in other tabs or windows. If the shortcut does not work, please check the assignment at `chrome://extensions/shortcuts`.

---

## 4. プライバシーポリシーの連絡先
`PRIVACY.md` に記載されているURLと同じものを設定してください。
`https://github.com/ningengakushu-dot/Web-Reader-for-VOICEVOX/blob/main/docs/PRIVACY.md`
（※公開時はGitHubリポジトリの直リンクが便利です）
