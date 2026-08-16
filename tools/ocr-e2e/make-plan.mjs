// 測定計画の生成。inputs(画像+GT)と runs(入力×バリアントの逐次リスト)を組み立てる。
// 使い方: node make-plan.mjs <main|smoke|extra|mincho> [作業ディレクトリ]
// mincho は gen-corpus-mincho.mjs で作る AAあり明朝コーパス（corpus-mincho.json）を
// 既存9入力と一緒に head で1周する計画（ベースライン取得用）。
// 事前に gen-corpus.mjs でコーパスを生成し、kakushin.png / MS.png を作業ディレクトリへ
// ダウンロードしておく（URLは docs/OCR-ACCURACY.md とプロジェクトmemoryを参照）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || "main";
const workDir = resolve(process.argv[3] || resolve(here, "work"));
const corpus = JSON.parse(readFileSync(join(workDir, "corpus.json"), "utf8"));

// 過去実測(docs/OCR-ACCURACY.md, 2026-07-19以降)と同一のGT。一貫して同じ文字列を使う。
const KAKUSHIN_GT = "違う。最初から美香は間違っていた。根本的なところで思い違いをしていた。直通の部屋が密室かどうかは、大した問題ではない。直通の家全体が、密室だった。それこそが、不幸の始まりであり、一連の出来事の核心だった。";
const MS_GT = "親譲りの無鉄砲で小供の時から損ばかりしている。小学校に居る時分学校の二階から飛び降りて一週間ほど腰を抜かした事がある。なぜそんな無闇をしたと聞く人があるかも知れぬ。別段深い理由でもない。新築の二階から首を出していたら、同級生の一人が冗談に、いくら威張っても、そこから飛び降りる事は出来まい。弱虫やーい。と囃したからである。小使に負ぶさって帰って来た時、おやじが大きな眼をして二階ぐらいから飛び降りて腰を抜かす奴があるかと云ったから、この次は抜かさずに飛んで見せますと答えた。（青空文庫より）";

const inputs = {};
for (const item of corpus) {
    inputs[item.name] = { file: item.file, gt: item.gt };
}
const kakushin = join(workDir, "kakushin.png");
const ms = join(workDir, "MS.png");
if (existsSync(kakushin)) {
    inputs.kakushin_p1 = { file: kakushin, gt: KAKUSHIN_GT,
        crop: { left: 997, top: 45, width: 148, height: 690 } };
    inputs.kakushin_p1_075 = { file: kakushin, gt: KAKUSHIN_GT,
        crop: { left: 997, top: 45, width: 148, height: 690 }, scale: 0.75 };
    inputs.kakushin_full = { file: kakushin };
}
if (existsSync(ms)) {
    inputs.ms_body = { file: ms, gt: MS_GT,
        crop: { left: 300, top: 20, width: 668, height: 830 } };
}

// 既存9入力（GT付き）。mincho 計画ではこれを従来どおり head で回して比較の土台にする。
const existingNames = Object.keys(inputs).filter((name) => inputs[name].gt);

// AAあり明朝コーパス（mincho モードのときだけ inputs へ加える。
// main/extra の計画を変えないため他モードでは読み込まない）。
const minchoNames = [];
if (mode === "mincho") {
    const minchoFile = join(workDir, "corpus-mincho.json");
    if (!existsSync(minchoFile)) {
        throw new Error(`missing ${minchoFile}: run gen-corpus-mincho.mjs first`);
    }
    for (const item of JSON.parse(readFileSync(minchoFile, "utf8"))) {
        inputs[item.name] = { file: item.file, gt: item.gt };
        minchoNames.push(item.name);
    }
}

let runs = [];
if (mode === "smoke") {
    runs = [{ input: corpus[0].name, variant: "head" }];
} else if (mode === "main") {
    // 逐次: 入力ごとに baseline → head（GT付き入力のみ）
    for (const name of Object.keys(inputs)) {
        if (!inputs[name].gt) continue;
        for (const variant of ["baseline", "head"]) runs.push({ input: name, variant });
    }
} else if (mode === "extra") {
    // 決定性(同一バリアント2回) / 候補上限(cap50k vs inf) / 予算逼迫(9s/12s/prod)
    const small = corpus.find((c) => c.px <= 14)?.name || corpus[0].name;
    runs = [
        { input: small, variant: "head" },
        { input: small, variant: "head" },
        { input: small, variant: "head-prod" },
        { input: small, variant: "head-budget12" },
        { input: small, variant: "head-budget9" }
    ];
    if (inputs.kakushin_full) {
        runs.push({ input: "kakushin_full", variant: "head" },
            { input: "kakushin_full", variant: "head-nocap" });
    }
} else if (mode === "mincho") {
    // AAあり明朝コーパスのベースライン取得。既存9入力 → 新コーパス全枚を
    // head（予算60秒固定）で1回ずつ。必ず逐次実行し、他の重い処理と並行させない。
    for (const name of existingNames) runs.push({ input: name, variant: "head" });
    for (const name of minchoNames) runs.push({ input: name, variant: "head" });
}
// mincho-ab: 「整列一致による余剰文字の削除段」のA/B（文字数膨張ゲートは実測で悪化し不採用）。
// 既存のGT付き入力（合成コーパス + kakushin + MS）に加え、AAあり明朝コーパス
// work/corpus-mincho.json があれば入力へ足す（無ければ存在チェックで飛ばす）。
// 入力ごとに baseline → head → head-noprune を逐次で回し、削除段の寄与を切り分ける
// （並行実行は時間予算の回数化を通じて測定を汚染する）。
if (mode === "mincho-ab") {
    const minchoFile = join(workDir, "corpus-mincho.json");
    if (existsSync(minchoFile)) {
        const mincho = JSON.parse(readFileSync(minchoFile, "utf8"));
        for (const item of (Array.isArray(mincho) ? mincho : [])) {
            if (!item || !item.name || !item.file || !item.gt || inputs[item.name]) continue;
            inputs[item.name] = { file: item.file, gt: item.gt };
        }
    }
    for (const name of Object.keys(inputs)) {
        if (!inputs[name].gt) continue;
        for (const variant of ["baseline", "head", "head-noprune"]) {
            runs.push({ input: name, variant });
        }
    }
}

const planFile = join(workDir, `plan-${mode}.json`);
writeFileSync(planFile, JSON.stringify({ inputs, runs }, null, 1));
console.log(`${planFile}: ${runs.length} runs`);
