# Git / GitHub 運用

- `main` は検証済みの安定版、`develop` は次の統合対象とする。どちらも変更はPRで取り込む。
- 作業開始時にremoteをfetchし、最新の `origin/develop` から用途の分かる作業ブランチを作る。AI作業は原則 `codex/` を使う。
- PRは問題と変更後の挙動、検証結果、残る制約を記載する。レビュー指摘は修正と検証を終えてから解決済みにする。
- `check`、`architecture-contract`、`CodeQL`、`build-release-candidate` が成功した最新コミットを、通常のマージコミットで `develop` へ統合する。保護ルールを迂回しない。
- `develop` から `main` へのPRで統合差分を確認する。重要な未解決指摘がなく、必要な実機・ベンチマーク確認とCIが完了してから、ユーザーが承認した範囲を統合する。
- `main` への統合とChromeウェブストアへの公開は別作業。公開手順とタグ付け時期は `docs/STORE-SUBMISSION-1.4.4.md` に従う。
- 統合後は `main` を `develop` に反映し、両ブランチの内容を一致させる。ローカルの更新はfast-forwardで行う。
- 不要な作業ブランチは統合済みであることを確認して削除し、remote-tracking refをpruneする。未統合ブランチ、未コミット変更、作業中worktreeは保持する。
