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

// round2-ab: 「認識入力の余白付与」と「全票 base 以上の漢字多数一致」の A/B。
// 33入力（既存9 + AAあり明朝24）を baseline → head → head-nopad → head-noconseq の順に
// 逐次で回し、2案それぞれの寄与を切り分ける。
// round2-tight: 同じ33入力を「インク境界ぴったり（余白0px）」に切り詰めた入力で
// baseline → head。実利用の「タイトな選択」（文字が選択枠に接する）を模す。
// コーパス画像はどれも四辺に 12〜36px の余白があり、従来はこの条件を一度も測っていなかった。
// round2-extra: 余白付与が効くタイト入力で 決定性（head×2）・実運用予算（head-prod）・
// 予算逼迫（12秒/9秒）を確認し、余白付き入力で baseline-prod / head-prod の待ち時間を比べる。
if (mode === "round2-ab" || mode === "round2-tight" || mode === "round2-extra") {
    const minchoFile = join(workDir, "corpus-mincho.json");
    if (existsSync(minchoFile)) {
        const mincho = JSON.parse(readFileSync(minchoFile, "utf8"));
        for (const item of (Array.isArray(mincho) ? mincho : [])) {
            if (!item || !item.name || !item.file || !item.gt || inputs[item.name]) continue;
            inputs[item.name] = { file: item.file, gt: item.gt };
        }
    }
    const names = Object.keys(inputs).filter((name) => inputs[name].gt);
    if (mode === "round2-ab") {
        for (const name of names) {
            for (const variant of ["baseline", "head", "head-nopad", "head-noconseq"]) {
                runs.push({ input: name, variant });
            }
        }
    } else if (mode === "round2-tight") {
        for (const name of names) {
            const tightName = `${name}_tight0`;
            inputs[tightName] = { ...inputs[name], tight: 0 };
            for (const variant of ["baseline", "head"]) runs.push({ input: tightName, variant });
        }
    } else {
        for (const name of ["melos_h_gothic_13", "neko_v_mincho_13"]) {
            if (!inputs[name]) continue;
            const tightName = `${name}_tight0`;
            inputs[tightName] = { ...inputs[name], tight: 0 };
            for (const variant of ["head", "head", "head-prod", "head-budget12", "head-budget9"]) {
                runs.push({ input: tightName, variant });
            }
        }
        for (const name of ["rashomon_v_mincho_14", "melos_v_mincho_16_dark", "yumin_neko_v_16_dsf15",
            "yumin_neko_v_19_dsf1", "kakushin_p1", "ms_body"]) {
            if (!inputs[name]) continue;
            for (const variant of ["baseline-prod", "head-prod"]) runs.push({ input: name, variant });
        }
    }
}

// page: gen-corpus-page.mjs で作る「小説1ページ（40万px超・縦書き明朝20px・ルビ付き）」を
// baseline / head で回す。全体（余白あり）・インク境界ぴったり・部分選択（右端5列・
// 上端/下端の半欠け）を含む。方向判定（全体比較の上限・パッチ）の回帰確認用。
if (mode === "page") {
    const pageFile = join(workDir, "corpus-page.json");
    if (!existsSync(pageFile)) throw new Error(`missing ${pageFile}: run gen-corpus-page.mjs first`);
    const pages = JSON.parse(readFileSync(pageFile, "utf8"));
    for (const item of pages) {
        inputs[item.name] = { file: item.file, gt: item.gt };
        inputs[`${item.name}_tight0`] = { file: item.file, gt: item.gt, tight: 0 };
        for (const name of [item.name, `${item.name}_tight0`]) {
            for (const variant of ["baseline", "head"]) runs.push({ input: name, variant });
        }
    }
    const first = pages[0];
    if (first) {
        inputs.page_part_right5 = { file: first.file,
            crop: { left: first.width - 5 * 31 - 12, top: 0, width: 5 * 31 + 12, height: first.height } };
        inputs.page_part_bottomcut = { file: first.file,
            crop: { left: 0, top: 0, width: first.width, height: first.height - 14 } };
        inputs.page_part_topcut = { file: first.file,
            crop: { left: 0, top: 14, width: first.width, height: first.height - 14 } };
        for (const name of ["page_part_right5", "page_part_bottomcut", "page_part_topcut"]) {
            for (const variant of ["baseline", "head"]) runs.push({ input: name, variant });
        }
    }
}

// real-ab: 既存33入力 + 生成した小説1ページ + （あれば）実書籍ページ画像
// work/user-page-180262.jpg を baseline → head で回す全入力A/B。実書籍ページは
// 柱（ページ上部の書名）とページ番号を含み、合成コーパスでは再現できない条件を測る。
// 実書籍ページのGTは著作物のため work/user-page-gt.json（git管理外）に置き、
// 存在するときだけ計画へ加える（kakushin.png / MS.png と同じ扱い）。
if (mode === "real-ab") {
    for (const file of ["corpus-mincho.json", "corpus-page.json"]) {
        const path = join(workDir, file);
        if (!existsSync(path)) continue;
        for (const item of JSON.parse(readFileSync(path, "utf8"))) {
            if (!item?.name || !item.file || !item.gt || inputs[item.name]) continue;
            inputs[item.name] = { file: item.file, gt: item.gt };
        }
    }
    const userPage = join(workDir, "user-page-180262.jpg");
    const userGtFile = join(workDir, "user-page-gt.json");
    if (existsSync(userPage) && existsSync(userGtFile)) {
        const gts = JSON.parse(readFileSync(userGtFile, "utf8"));
        // 全体（柱・ページ番号を含む）と、報告された選択（右9列）の等倍・0.83倍
        inputs.userpage_full = { file: userPage, gt: gts.full };
        // 柱・ノンブルは読み上げ対象外なので、本文だけを正解にした同じ入力も測る
        inputs.userpage_body = { file: userPage, gt: gts.body };
        inputs.userpage_cols9 = { file: userPage, gt: gts.cols9,
            crop: { left: 402, top: 66, width: 356, height: 1036 } };
        inputs.userpage_cols9_083 = { file: userPage, gt: gts.cols9,
            crop: { left: 402, top: 66, width: 356, height: 1036 }, scale: 0.83 };
    }
    for (const name of Object.keys(inputs)) {
        if (!inputs[name].gt) continue;
        for (const variant of ["baseline", "head"]) runs.push({ input: name, variant });
    }
}

// pad-ab: 認識入力の余白付与の量（OCR_INPUT_PAD_PX）を 10/20/30/45 で比べる。
// 縦書きでは「列の先頭・末尾の文字」が不安定（実測: 段落頭の「が欠落、列末の文字が
// 化ける）で、これが画像端との距離に依存するかを切り分ける。
if (mode === "pad-ab" || mode === "pad-full") {
    for (const file of ["corpus-mincho.json", "corpus-page.json"]) {
        const path = join(workDir, file);
        if (!existsSync(path)) continue;
        for (const item of JSON.parse(readFileSync(path, "utf8"))) {
            if (!item?.name || !item.file || !item.gt || inputs[item.name]) continue;
            inputs[item.name] = { file: item.file, gt: item.gt };
        }
    }
    const userPage = join(workDir, "user-page-180262.jpg");
    const userGtFile = join(workDir, "user-page-gt.json");
    if (existsSync(userPage) && existsSync(userGtFile)) {
        const gts = JSON.parse(readFileSync(userGtFile, "utf8"));
        inputs.userpage_full = { file: userPage, gt: gts.full };
        inputs.userpage_body = { file: userPage, gt: gts.body };
        inputs.userpage_cols9 = { file: userPage, gt: gts.cols9,
            crop: { left: 402, top: 66, width: 356, height: 1036 } };
        inputs.userpage_cols9_083 = { file: userPage, gt: gts.cols9,
            crop: { left: 402, top: 66, width: 356, height: 1036 }, scale: 0.83 };
    }
    const variants = mode === "pad-ab"
        ? ["head", "head-pad20", "head-pad30", "head-pad45"] : ["head", "head-pad20"];
    // 余白ゼロ（本文が画像端に接する）入力を中心に据える。既存コーパスは四辺に
    // 12〜36px の余白があるため、*_tight0（インク境界で切り詰め）も足して測る。
    const tightNames = ["rashomon_v_mincho_14", "neko_v_mincho_13", "yumin_rashomon_v_16_dsf1"];
    for (const name of tightNames) {
        if (inputs[name]) inputs[`${name}_tight0`] = { ...inputs[name], tight: 0 };
    }
    const subset = mode === "pad-ab"
        ? ["page_yumin_20_flush", "page_yumin_16_dsf125_flush", "userpage_cols9", "userpage_body",
            "page_yumin_20_ruby", "page_noto_20_ruby",
            ...tightNames.map((name) => `${name}_tight0`),
            "yumin_rashomon_v_16_dsf1", "msgo_rashomon_v_16_dsf1", "kakushin_p1", "ms_body"]
        : Object.keys(inputs).filter((name) => inputs[name].gt);
    for (const name of subset) {
        if (!inputs[name]?.gt) continue;
        for (const variant of variants) runs.push({ input: name, variant });
    }
}

// gamma-ab: グレースケール化のガンマ（暗部の持ち上げ）を 1.0/1.5/1.8 で比べる。
// 太字・余白ゼロの新規ページ入力も同時に測り、報告された条件の再現を確認する。
if (mode === "gamma-ab") {
    for (const file of ["corpus-mincho.json", "corpus-page.json"]) {
        const path = join(workDir, file);
        if (!existsSync(path)) continue;
        for (const item of JSON.parse(readFileSync(path, "utf8"))) {
            if (!item?.name || !item.file || !item.gt || inputs[item.name]) continue;
            inputs[item.name] = { file: item.file, gt: item.gt };
        }
    }
    const userPage = join(workDir, "user-page-180262.jpg");
    const userGtFile = join(workDir, "user-page-gt.json");
    if (existsSync(userPage) && existsSync(userGtFile)) {
        const gts = JSON.parse(readFileSync(userGtFile, "utf8"));
        inputs.userpage_cols9 = { file: userPage, gt: gts.cols9,
            crop: { left: 402, top: 66, width: 356, height: 1036 } };
        inputs.userpage_body = { file: userPage, gt: gts.body };
    }
    const subset = ["userpage_cols9", "userpage_body",
        "page_yumin_20_ruby", "page_yumin_16_dsf125_ruby", "page_noto_20_ruby",
        "page_yumin_20_bold", "page_noto_20_bold",
        "page_yumin_20_flush", "page_yumin_16_dsf125_flush", "page_yumin_18_hheading",
        "rashomon_v_mincho_14", "neko_v_mincho_13", "melos_h_gothic_13",
        "yumin_rashomon_v_16_dsf1", "msgo_rashomon_v_16_dsf1", "kakushin_p1", "ms_body"];
    for (const name of subset) {
        if (!inputs[name]?.gt) continue;
        for (const variant of ["head", "head-gamma15", "head-gamma18"]) {
            runs.push({ input: name, variant });
        }
    }
}

// 1計画が100ランを超えるときは分割して書き出す（結果は最後にまとめて書かれるため、
// 長い計画は途中で止まると全損する。README の注意も参照）。
const MAX_RUNS_PER_PLAN = 100;
if (runs.length <= MAX_RUNS_PER_PLAN) {
    const planFile = join(workDir, `plan-${mode}.json`);
    writeFileSync(planFile, JSON.stringify({ inputs, runs }, null, 1));
    console.log(`${planFile}: ${runs.length} runs`);
} else {
    const parts = Math.ceil(runs.length / MAX_RUNS_PER_PLAN);
    const size = Math.ceil(runs.length / parts);
    for (let part = 0; part < parts; part++) {
        const chunk = runs.slice(part * size, (part + 1) * size);
        const planFile = join(workDir, `plan-${mode}-${part + 1}.json`);
        writeFileSync(planFile, JSON.stringify({ inputs, runs: chunk }, null, 1));
        console.log(`${planFile}: ${chunk.length} runs`);
    }
}
