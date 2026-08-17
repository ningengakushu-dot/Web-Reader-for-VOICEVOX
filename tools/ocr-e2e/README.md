# OCR 実機相当回帰ハーネス（tools/ocr-e2e）

出荷ソース（`constants.js` / `ocr-image.js` / `ocr-refine.js` / `ocr-common.js`）を
**そのまま** Node の vm で実行し、同梱 traineddata で認識して CER を測る。
OCR 精度に関わる変更は、合成テストの pass ではなくこのハーネスの実測で効果を示すこと
（CLAUDE.md / AGENTS.md の必須ルール）。2026-08-14 の再計測で使用した実装そのもの。

配布物には含めない（`tools/pack.ps1` は allowlist 方式のため自動混入しない）。

## セットアップ

```powershell
cd tools/ocr-e2e
npm install
```

## 手順

1. **コーパス生成**（Playwright の Chromium などを指定）:

   ```powershell
   $env:OCR_CHROMIUM = "C:\...\chrome.exe"
   node gen-corpus.mjs            # → work/ に6画像 + corpus.json
   ```

1b. **AAあり明朝コーパスの生成**（実ユーザー条件の再現。任意）:

   ```powershell
   $env:OCR_CHROMIUM = "C:\Program Files\Google\Chrome\Application\chrome.exe"
   node gen-corpus-mincho.mjs     # → work/ に24画像 + corpus-mincho.json
   ```

   既存コーパスの明朝は「ＭＳ 明朝 13〜16px」で、この帯の MS 書体は埋め込みビットマップが
   使われるため **AAが付かない**（輝度2階調）。実利用の明朝（游明朝 / BIZ UD明朝 /
   Noto Serif JP、16〜24px、表示スケール1.25〜1.5）を再現するのがこのコーパス。
   `document.fonts.check` は存在しない書体名でも true を返す（実測）ので信用せず、
   架空フォント / serif / sans-serif の3対照とのピクセル一致でフォールバックを検出する
   （結果は `work/corpus-mincho-fontcheck.json`）。

2. **実画像の配置**（任意・推奨）: `work/kakushin.png` と `work/MS.png` を置くと
   過去実測と同じ crop/GT の入力が計画へ追加される（URL はプロジェクト memory /
   docs/OCR-ACCURACY.md の 2026-07 記録を参照）。kakushin 0.75x の CER が
   **0.98%** になればハーネスの忠実性が確認できる（2026-07-22 実測と一致）。

3. **比較基準の用意**（baseline バリアントを使う場合）:

   ```bash
   mkdir -p baseline
   for f in constants.js ocr-image.js ocr-refine.js ocr-common.js; do
     git show "origin/develop:$f" > "baseline/$f"
   done
   ```

4. **計画生成と実行**:

   ```powershell
   node make-plan.mjs main        # baseline vs head の全入力比較
   node harness.mjs work/plan-main.json
   node make-plan.mjs extra       # 決定性 / 候補上限 / 予算逼迫
   node harness.mjs work/plan-extra.json
   node make-plan.mjs mincho      # 既存9入力 + AAあり明朝24枚を head で1周
   node harness.mjs work/plan-mincho.json
   node make-plan.mjs mincho-ab   # 同33入力を baseline / head / head-noprune で A/B
   node harness.mjs work/plan-mincho-ab.json
   node make-plan.mjs round2-ab   # 同33入力を baseline / head / head-nopad / head-noconseq で A/B
   node harness.mjs work/plan-round2-ab-1.json   # 100ラン超は自動で分割される
   node harness.mjs work/plan-round2-ab-2.json
   node make-plan.mjs round2-tight  # 同33入力をインク境界ぴったりに切り詰めた入力（*_tight0）で baseline / head
   node harness.mjs work/plan-round2-tight.json
   node gen-corpus-page.mjs         # 小説1ページ（40万px超・縦書き明朝20px・ルビ付き）4枚 → work/corpus-page.json
   node make-plan.mjs page          # 全体 / タイト / 部分選択（右端5列・上下の半欠け）を baseline / head
   node harness.mjs work/plan-page.json
   node make-plan.mjs real-ab       # 既存33入力 + 生成ページ + 実書籍ページを baseline / head で全入力A/B
   node harness.mjs work/plan-real-ab.json
   ```

   `real-ab` の実書籍ページ（柱・ページ番号つき縦書き。合成コーパスには無い条件）は、
   画像 `work/user-page-180262.jpg` と GT `work/user-page-gt.json`（キー `full` / `body` /
   `cols9`）が置かれているときだけ計画へ加わる。**画像とGTは著作物なのでリポジトリには
   入れない**（kakushin.png / MS.png と同じ扱い。出典URLは docs/OCR-ACCURACY.md の
   2026-08-18 の節を参照）。

   入力に `tight: <margin px>` を付けると、取り込み後にインク境界＋margin で切り詰める
   （実利用の「文字が選択枠に接するタイトな選択」の再現。コーパス画像は四辺に 12〜36px の
   余白があるので、余白付与 `padOcrCanvas` の効果はこの入力でしか測れない）。

   比較基準の場所は環境変数 `OCR_E2E_BASELINE` で差し替えられる（例: 直前のコミットと
   比べるなら `git show "HEAD:$f" > baseline-head/$f` を4ファイル分作り、そのディレクトリを
   指定する）。1計画が100ランを超えるときは `runs` を分割して1プロセスずつ回す
   （結果は最後にまとめて書き出されるため、途中で止まると全損する）。
   `head-nobinar`（二値化段OFF）・`baseline-prod` / `head-prod`（実運用予算での待ち時間比較）・
   `head-nopad`（認識入力の余白付与OFF）・`head-noconseq`（「全票が元寸以上」の漢字多数一致OFF）
   のバリアントもある。

   結果は `work/results_plan-*.json`（全文テキスト付き）。

## 測定の規律（過去の失敗から）

- **必ず逐次実行**。並行実行や同時の重負荷は `refinesLeft`（時間予算の回数化）を
  通じて出力を変え、A/B を汚染する。
- CER 比較バリアントは予算を 60 秒に固定してある（精錬段数の負荷依存を排除）。
  予算そのものの挙動は `head-prod` / `head-budget12` / `head-budget9` で別途測る。
- 比較前に括弧の全角半角を正規化する（読み上げに影響しない差で置換誤りが埋まるため）。
- before/after で出力が異なる場合は、**差分を1件ずつ文字レベルで説明**してから採否を
  判断する（`results_*.json` の text を突き合わせる）。
- **入力の取り込みは等倍では画素完全**（2026-08-16 修正）。`@napi-rs/canvas` は
  `imageSmoothingQuality="high"` だと 1:1 の `drawImage` でも再標本化し、2値ビットマップ
  描画のコーパスで輝度階調が 2 → 33 に増えていた。出荷 `cropToOcrCanvas`（品質指定なしの
  等寸 `drawImage`）は実測で画素完全なので、`loadInputCanvas` は `scale===1` のとき
  `imageSmoothingEnabled=false` にして一致させる。`scale≠1`（低解像度キャプチャの再現）は
  従来どおり高品質補間。**この修正で 2026-08-14 以前の数値とは直接比較できない**
  （ベースラインは取り直すこと）。
