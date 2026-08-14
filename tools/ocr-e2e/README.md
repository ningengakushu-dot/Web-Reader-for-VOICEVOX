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
   ```

   結果は `work/results_plan-*.json`（全文テキスト付き）。

## 測定の規律（過去の失敗から）

- **必ず逐次実行**。並行実行や同時の重負荷は `refinesLeft`（時間予算の回数化）を
  通じて出力を変え、A/B を汚染する。
- CER 比較バリアントは予算を 60 秒に固定してある（精錬段数の負荷依存を排除）。
  予算そのものの挙動は `head-prod` / `head-budget12` / `head-budget9` で別途測る。
- 比較前に括弧の全角半角を正規化する（読み上げに影響しない差で置換誤りが埋まるため）。
- before/after で出力が異なる場合は、**差分を1件ずつ文字レベルで説明**してから採否を
  判断する（`results_*.json` の text を突き合わせる）。
