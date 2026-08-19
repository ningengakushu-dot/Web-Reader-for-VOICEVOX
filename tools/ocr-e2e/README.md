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

   `pad-ab` は認識入力の余白量（`head-pad20` / `head-pad30` / `head-pad45`）を、
   `gamma-ab` はグレースケール化のガンマ（`head-gamma15` / `head-gamma18`）を比べる計画。
   余白の方向別（縦書きの上下だけ／左右だけ）は `head-padtb45` / `head-padlr45`。
   いずれも 2026-08-18 の実測では悪化ゼロにならず不採用（docs/OCR-ACCURACY.md 参照）だが、
   再測できるよう残してある。

   `head-pitchmed`（列ピッチの基準を上位四分位→中央値）は 2026-08-18 に**採用**した変更の
   A/B 用。採用後の HEAD では `head` と同じ挙動になる。併せて測って不採用にした
   `head-votecount` / `head-pitchmed-vote`（物理セル数を候補の文字数と max で採る）も残してある。

   `head-norule`（罫線・枠線の除去だけを外す）は 2026-08-18 に**採用**した変更の A/B 用。
   `head-nofuse`（複数倍率の融合を丸ごと外す）は段の寄与を切り分けるための対照。

   **公開版との比較**は `baseline-main/`（`for f in constants.js ocr-image.js ocr-refine.js
   ocr-common.js; do git show "main:$f" > baseline-main/$f; done`）を
   `OCR_E2E_BASELINE` に指定して `baseline` バリアントで回す。
   公開版は**同梱の語彙辞書 `ocr-words.txt` を使う**ので、辞書を消したブランチで測るときは
   `git show main:ocr-words.txt > work/ocr-words.txt` を置いてから回すこと
   （harness の `fetch` shim が work/ → リポジトリ直下の順で読む）。置き忘れると
   ベースラインだけ辞書が無効になり、公開版を不当に低く見積もる。
   辞書そのものの寄与は `baseline-nodict`（辞書リランクだけを外した公開版）との差で測る
   （計画 `dict-ab`）。

   結果は `work/results_plan-*.json`（全文テキスト付き）。

### 縦書きプロポーショナル書体コーパス（gen-corpus-vpitch.mjs）

ＭＳ Ｐ明朝・ＭＳ Ｐゴシックの縦書きは1文字ぶんの送りが一定でない
（ＭＳ Ｐ明朝 24px で実測 15.3〜24px の17種類）。「列の長さ ÷ 文字数」で
余分な文字を消す段が誤作動しないかを測るためのコーパス（12入力）。

```powershell
$env:OCR_CHROMIUM = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node gen-corpus-vpitch.mjs
node make-plan.mjs vpitch      # baseline / head / head-noprune
```

### Web媒体コーパス（gen-corpus-web.mjs）

既存コーパスは**青空文庫の文学作品・縦書き明朝**にほぼ偏っており、この拡張の主用途である
「画面に映っているWeb文書」を一度も代表していなかった（2026-08-18まで）。

```powershell
$env:OCR_CHROMIUM = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node gen-corpus-web.mjs        # → work/corpus_web_*.png（24枚）+ work/corpus-web.json
node make-plan.mjs web-ab      # 公開版 → 本ブランチ
node harness.mjs work/plan-web-ab.json
node make-plan.mjs web-stage   # head / head-nofuse / head-noprune（段の寄与）
```

内訳は 記事本文 / 技術文書（URL・半角英数字）/ 箇条書き / 表 / UI小文字12px / 数値と単位が
密な文 / 見出しと本文のサイズ混在 / 日英混在 × 游ゴシック・既定サンセリフ・ＭＳ Ｐゴシック・
BIZ UDP・Noto Sans × 表示倍率 1/1.25/1.5 × 明暗・低コントラスト・狭い段。
本文はすべて自作なので著作物を含まない（画像は work/ なので git 管理外）。

GT には**CSSが描く箇条書きマーカー（`•` `1.`）も含める**。textContent には入らないが
画面には見えており、OCRは読むため、GTに入れないと正しい認識が「余剰」と数えられる。

「メイリオ」はブラウザ既定のサンセリフと画素まで一致して区別できないため、書体名を
指定しない「既定のサンセリフ」として測る（実利用で最も多い条件そのもの）。

### 誤りの「位置」と削除段の内訳を見る道具（work/、git管理外）

追加の認識をせずに既存の結果を読み直すもの:

- `probe-linepos.mjs <plan.json> <results.json> [--variant head]`
  誤りを「行内の相対位置」「行末からの距離」で集計し、帰無分布（全文字）と並べる。
  2026-08-18 はこれで「欠落の42.3%が行の切れ目」を見つけた。
- `dump-linegaps.mjs`（同じ引数）: 欠落の実例を前後の文脈つきで一覧する。

認識をやり直すもの（1入力あたり 10〜30 秒）:

- `probe-stage-text.mjs <plan.json> <input名>...` 主経路（精錬前）と最終テキストを並べ、
  消えた文字が認識由来か精錬段由来かを切り分ける。→ `work/stage-text.json`
- `probe-prune.mjs <plan.json> <input名>...` `pruneOcrLineInsertions` の判断
  （列の span・ピッチ・物理セル数・候補の文字列・削除案）を dump する。→ `work/prune-detail.json`
- `eval-pitch.mjs <prune-detail.json>...` その dump から、ピッチ推定方式
  （上位四分位／中央値／shorth）ごとの「削除対象になる列」を比べる。
- `probe-psm-web.mjs <画像>...` 素の Tesseract に同じ画像を PSM だけ変えて渡す。
  2026-08-18 はこれで「罫線表は SINGLE_BLOCK で確信度43・AUTOで83」を確かめた。
- `probe-derule.mjs <画像>...` 「文字の画より長い直線」を消した画像と原画を並べて認識する。
  罫線・枠線の除去を出荷コードへ入れる前の検証に使った。
- `probe-timing.mjs <画像>...` 1回のOCRで**何回の認識が走り、それぞれ何秒か**を出す
  （出荷コードに触れず Tesseract の呼び出しを包む）。2026-08-19 はこれで
  「スマホ画面の切り出しで6回・15.8秒、採用されるのは最初の2.17秒だけ」を突き止めた。

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
