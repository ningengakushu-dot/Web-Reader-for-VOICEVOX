// 読み上げ品質の実エンジン検証に使う多様なテキストコーパス（tools/reading-corpus-check.mjs 用）。
// 一般公開後に想定される入力: Web ページ・画像・PDF から選択／OCR で取得した文章。
// path は取得経路（整形の入口）を表す:
//   selection = テキスト選択（content.js cleanMessage: URL 置換・改行は空白）
//   dom       = 範囲読み上げのページ内テキスト（改行を残す）
//   ocr       = OCR 生テキスト（ocr-common.js normalizeOcrText → cleanForSpeech）
// OCR の生テキストは tools/reading-corpus-ocr.json（Chrome で描画した Web レイアウトを
// 出荷コードで実際に OCR した結果。2026-08-16 採取）から読み込む。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const MAIL = `締切になってしまう前にお早めに応募依頼を進めていただければと思っております。
------------------------------
◆フェンリル株式会社／【リモート可／大阪】UXコンサルタント◆「Sleipnir」開発企業◆土日祝休・フレックス
https://doda.jp/DodaFront/View/JobSearchDetail/j_jid__3010000000/
〜スマホに入っているそのアプリ、フェンリルがつくっているかもしれません〜
■世界シリーズ累計5,000万超ダウンロードのWebブラウザ「Sleipnir」を自社プロダクトとして保有
■iPhone向けアプリケーション開発に関わり、600件以上の実績あり
■所属するクリエイター／技術者の技術書出版、技術フォーラムにスピーカーとして登壇、フロアを利用した最新トレンドの勉強会の一般開放など、高い専門性を持つ社員多数
------------------------------`;

export const CORPUS = [
    // --- 1. 日本語・英数字・記号・URL・日付・時刻・単位の混在 ---
    { name: "news_mixed", path: "selection", text:
        "新型センサー、国内工場に導入相次ぐ\n2026/08/16 12:34\n国内の製造業で新型センサーの導入が進んでいる。ある調査によれば、対象企業のうち42%が今年度中に導入を予定しており、前年比で15km圏内の関連工場に波及しているという。背景には、OpenAIが提供する解析技術との連携があるとされる。現場担当者は「iPhone 17と同じセンサー規格を採用したことで、既存機器との互換性が保たれた」と説明する。（担当者への取材による、数値は概算）" },
    { name: "ec_product", path: "dom", text:
        "ワイヤレスイヤホン XR-200\n価格：¥12,800（税込）\n重量：1.2kg\nサイズ：150×75×8 mm\n発売日：2026年9月1日\n連続再生：約8時間（ケース併用で最大32時間）\nBluetooth 5.3 / IPX4 / USB-C\n★★★★☆ 4.3（1,234件のレビュー）\n在庫あり ― 通常2〜3営業日で発送\nhttps://shop.example.com/items/xr-200?ref=top" },
    { name: "event_notice", path: "selection", text:
        "【開催日時】2026年8月16日(金) 10:00〜11:30（受付開始 9:45）\n【会場】〒100-0001 東京都千代田区千代田1-1 ○○ビル 3F\n【参加費】無料 ※事前登録制\n【定員】50名（先着順）\n【お問い合わせ】TEL: 03-1234-5678 / E-mail: info@example.co.jp\n詳細・お申し込みは www.example.co.jp/event/2026 まで" },
    { name: "recipe", path: "dom", text:
        "材料（2人分）\n鶏もも肉 250g\n玉ねぎ 1/2個\n醤油 大さじ2\nみりん 大さじ1\n砂糖 小さじ1\n作り方\n1. 鶏肉を一口大に切る。\n2. フライパンに油を熱し、中火で3〜4分焼く。\n3. 調味料を加え、180℃のオーブンで15分。\nカロリー：約450kcal／塩分：2.1g" },
    { name: "timetable", path: "dom", text:
        "上り 平日ダイヤ\n6:05 6:21 6:38 6:52\n7:03 7:15 7:27 7:39 7:51\n8:02 8:14 8:26\n※△印は当駅始発、◇印は快速" },

    // --- 2. 改行・箇条書き・表・見出し ---
    { name: "article_headings", path: "dom", text:
        "在宅ワークの生産性を上げる5つの工夫\n在宅勤務が広がる中で、自宅でも集中力を保ちながら効率よく作業を進めたいという声が増えている。特別な道具がなくても、日々の習慣を少し見直すだけで作業効率は大きく変わる。\nここでは、すぐに実践できる工夫をいくつか紹介する。\n・作業開始前に今日やることを3つだけ書き出す\n・25分作業したら5分休むリズムを作る\n・通知はまとめて1時間おきに確認する\n・朝9時から会議はZoomで開始、資料はPDF2部を事前共有する" },
    { name: "table_cells", path: "dom", text:
        "品名\n数量\n単価\n備考\nコピー用紙A4\n3\n480円\nType-A在庫あり\n段ボール箱\n12\n210円\n耐荷重20kg\n米(こしひかり)\n2\n3,980円\n5kg×2袋\n工具セットNo.5\n1\n7,150円\nMade in Japan" },
    { name: "toc", path: "dom", text:
        "第1章 はじめに ・・・・・・・・・・ 3\n第2章 導入 ・・・・・・・・・・・・ 12\n第3章 基本操作 ・・・・・・・・・・ 27\n第4章 応用編 ・・・・・・・・・・・ 45\n第5章 トラブルシューティング ・・・ 61\n第6章 付録 ・・・・・・・・・・・・ 78" },
    { name: "wiki_citations", path: "selection", text:
        "富士山（ふじさん）は、静岡県と山梨県にまたがる活火山である[1]。標高3,776.12 m、日本最高峰（剣ヶ峰）[注 1]の独立峰で、その優美な風貌は日本国外でも日本の象徴として広く知られている[2][3]。\n\n目次\n1 概要\n2 地理\n2.1 位置\n2.2 標高\n3 歴史\n脚注\n^ 国土地理院「日本の主な山岳標高」2014年4月1日閲覧。" },
    { name: "menu_breadcrumb", path: "dom", text:
        "ホーム > 製品情報 > ワイヤレスイヤホン > XR-200\nログイン | 新規登録 | カート(0)\nこのサイトはCookieを使用しています。閲覧を続けることで同意したものとみなします。 [同意する]\n© 2026 Example Inc. All rights reserved." },

    // --- 3. OCR特有の誤認識・不要な空白・改行（実OCR結果は JSON から追加） ---
    { name: "ocr_noise_synthetic", path: "ocr", text:
        "うわー|ー|1||っ、と 叫 ん だ 。\n株 式 会 社 サ ンプ ブル の 佐藤 で す 。\n429% が 今年 度 中 に\nhttps:/ が example.com/meeting?a=1\n価格 : \\12,800 (税込 )\n10:0011:30" },

    // --- 4. 長文・短文・句読点が少ない ---
    { name: "mail_report", path: "ocr", text: MAIL },
    { name: "long_no_punct", path: "selection", text:
        "本製品は高い耐久性と優れた操作性を兼ね備えておりさまざまな現場でご利用いただけるよう設計されておりますので屋内外を問わず幅広い用途に対応し長期間にわたって安定した性能を発揮しますまた専用アプリケーションと連携することでより高度な設定や管理が可能となり業務の効率化にも貢献します".repeat(2) },
    { name: "short_lines", path: "dom", text: "はい\nいいえ\nOK\nNG\n了解\n未定\n保留\n完了\n次へ\n戻る\n" },
    { name: "novel_dialogue", path: "selection", text:
        "「おい、待てよ」と彼は言った。「どこへ行くんだ？」\n「……知らない」\n彼女は振り返らなかった。ただ、遠くで汽笛が鳴った。長い、長い汽笛だった。それは午後三時ちょうどのことで、駅前の時計台の針が重なった瞬間、彼はようやく自分が取り返しのつかないことをしてしまったのだと悟った――いや、悟ったつもりになっただけかもしれない、と後になって思う。" },

    // --- 5. 特殊文字・想定外の入力 ---
    { name: "special_chars", path: "selection", text:
        "絵文字🎉と記号→←↑↓、丸数字①②③、単位㎡㎏℃、株式会社の㈱、罫線┌─┬─┐│├┼┤└┴┘、数式 x² + y² = r²、√2 ≒ 1.414、a ≠ b、∞、♪♡、〒100-0001、全角ＡＢＣ１２３、半角ｶﾀｶﾅ ｷｬﾝﾍﾟｰﾝ、ゼロ幅​文字­混入﻿テスト、制御 文字混入。" },
    { name: "symbol_lines", path: "dom", text: "==============================\n本文です。\n******************************\n・・・・・・・・・・\n！！！！！\n次の本文です。\n──────────" },
    { name: "fullwidth_ascii", path: "selection", text: "ＶＯＩＣＥＶＯＸ　Ｗｅｂ　Ｒｅａｄｅｒ　ｖ１．４．３　（２０２６年８月）　ＵＲＬ：ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ" },

    // --- 6. 読み上げ対象として不自然・不要な文字列 ---
    { name: "urls_emails_hashes", path: "selection", text:
        "参考リンク: https://ja.wikipedia.org/wiki/%E5%AF%8C%E5%A3%AB%E5%B1%B1 と https://example.com/very/long/path?query=1&other=2#section\nメール: taro.yamada@example.co.jp\nコミット: b3f9c2a1e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9\nトークン: SGVsbG8gV29ybGQhIFRoaXMgaXMgYmFzZTY0IGVuY29kZWQgdGV4dC4=\n注文番号: 1234567890123456\n電話: 0120-123-456" },
    // エンジンの制約を突く塊: 間（句読点・空白）の無いままアクセント句が49を超えると
    // audio_query が 500 になる／以降が欠落する（実測: 16進60字・英文60語・和文276字）
    { name: "limit_hash_nospace", path: "selection", text: "sha256: " + "b3f9c2a1e4d5".repeat(20) + " を確認してください。" },
    { name: "limit_english_nopunct", path: "selection", text: "the quick brown fox jumps over the lazy dog ".repeat(10).trim() },
    { name: "limit_jp_hex_mixed", path: "selection", text: "東京都内の会社で働きながら副業として在宅で行える仕事を探している方に向けた求人情報です".repeat(3) + "b3f9c2a1e4d5".repeat(5) + "以上です" },
    { name: "limit_base64_digits", path: "selection", text: "SGVsbG8gV29ybGQhIFRoaXMgaXMgYmFzZTY0IGVuY29kZWQgdGV4dC4=".repeat(5) + "\n" + "1234567890".repeat(8) + "\n" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(4) },
    { name: "code_block", path: "dom", text:
        "npm install foo\nconst x = 10;\nif (a && b) { return; }\nfor (let i = 0; i < 10; i++) console.log(i);\n上記は依存パッケージの導入例と、簡単な条件分岐のサンプルコードである。" },
    { name: "tweet", path: "selection", text: "新機能リリースしました🎉 #VOICEVOX #読み上げ @example_dev さんありがとうございます！！ 詳細はこちら→ https://t.co/abc123XYZ  (1/3)" },
    { name: "legal", path: "selection", text:
        "第３条（利用登録）\n１．利用者は、本サービスの利用にあたり、当社所定の方法により利用登録を行うものとします。\n２．当社は、前項の登録申請者に以下の事由があると判断した場合、登録を承認しないことがあります。\n（１）虚偽の事項を届け出た場合\n（２）本規約に違反したことがある者からの申請である場合" },
    { name: "paper_refs", path: "selection", text:
        "本研究では，深層学習を用いた音声合成手法を提案する．提案手法は従来法[1,2]と比較して MOS が 0.32 向上した（p < 0.01）．\n[1] A. Smith et al., \"Neural TTS,\" Proc. ICASSP, pp. 123-127, 2024.\n[2] 山田太郎, 鈴木花子: 音声合成の高速化, 情報処理学会論文誌, Vol.65, No.3, pp.1-10 (2024)." },
    { name: "english_paragraph", path: "selection", text:
        "The quarterly report shows a steady increase in customer engagement across all major regions this year. Our support team responded to more than three thousand tickets within the first week alone, which is a new record for the department. Several product managers have already started reviewing the feedback in detail to plan the next release cycle. We expect the momentum to continue into the following quarter as new features roll out gradually.\n来月にはこの内容を日本語でも共有する予定です。" },
    { name: "review_stars", path: "dom", text: "★★★★★ 最高です！\n2026年8月10日 by ユーザーA\n音質がとても良く、装着感も抜群でした。バッテリーも1日持ちます。\n★★☆☆☆ 期待外れ\n2026年8月3日 by ユーザーB\n接続が不安定で、何度もペアリングし直す必要がありました…。" }
];

// 実際に OCR して得た生テキスト（Web レイアウト 8 種 + 小さい文字 2 種）
const ocrRaw = JSON.parse(readFileSync(resolve(here, "reading-corpus-ocr.json"), "utf8"));
for (const item of ocrRaw) {
    CORPUS.push({ name: `ocr_${item.id}`, path: "ocr", text: item.raw, original: item.original });
}
