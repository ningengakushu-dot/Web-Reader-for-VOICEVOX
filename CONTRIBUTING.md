# Development workflow

## ブランチの役割

- `main`: Chrome Web Storeへ提出可能な本番ブランチ。利用者による実機確認が完了した変更だけを統合します。
- `develop`: 開発版の統合ブランチ。機能追加や不具合修正は、まずこのブランチへ統合します。
- `feature/*` / `fix/*`: 個別作業用ブランチ。原則として`develop`から作成し、`develop`へPull Requestを出します。

## リリース手順

1. 個別変更を`develop`へ統合し、自動テストとCodeQLを通します。
2. `develop`版をChromeへ読み込み、利用者が主要機能を実機確認します。
3. 実機確認で問題がない場合だけ、`develop`から`main`へのリリースPull Requestを作成します。
4. `main`へ統合後、`tools/pack.ps1`でChrome Web Store提出用ZIPを作成します。

自動検査の成功だけを理由に`main`へ統合しません。
