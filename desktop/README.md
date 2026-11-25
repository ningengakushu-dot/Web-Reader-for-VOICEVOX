# Windows 版 VOICEVOX Local Reader

Windows x64 用のポータブルアプリ。Electron を同梱し、既存の `background-speech.js` を同じ JavaScript エンジン上で直接読み込む。配布フォルダーの EXE から起動でき、利用者が別途用意するのはローカルの VOICEVOX のみ。開発用の Node.js、Chrome 拡張のインストールは不要。

Windows 専用の入口・設定ファイル・中断可能な HTTP クライアントをメインプロセスに置く。画面はローカル資材だけを読み込み、音声の再生・解放を担当する。テキスト整形と分割は develop の正本をそのまま配布する。他アプリの選択文字の取得、グローバルショートカット、画面範囲 OCR は後続候補。
