// 選択範囲から「ページが持っている文字データ」を直接取り出す経路（Tier 0）。
//
// 通常のWebページでは、読み上げたい文字は最初からテキストとしてDOMに存在する。
// それを一度ピクセルへ落として画像認識で復元するのは、情報を捨ててから復元する
// のと同じで、精度・速度の両面で不利になる。ここでは選択矩形をDOMのRangeへ
// 逆引きして、文字を文字のまま取り出す。
//
// 取り出せない領域（画像内の文字・canvas描画・closedなShadow DOM・
// クロスオリジンiframe）だけが、従来のOCR経路へ回る。
//
// このファイルは chrome.* API を一切使わない純粋なDOM処理にしてある
// （拡張機能の外でも同じコードを実行して検証できるようにするため）。
//
// content.js と同じく、再注入で最上位の const が衝突しないよう全体を IIFE で包み、
// globalThis 経由でのみ公開する。
(() => {

// 選択範囲内でこの文字数を下回る場合はテキストが取れなかったとみなし、OCRへ回す。
// 「画像だけを選択した」場合に、周囲のわずかな文字だけを読み上げてしまうのを防ぐ。
const DOM_TEXT_MIN_CHARS = 8;

// 行矩形と選択矩形の重なりがこの割合以上なら、その行は丸ごと選択されたとみなす。
// これ未満かつ極小でもない場合のみ、文字単位の切り出しを行う（コストを局所化する）。
const DOM_TEXT_FULL_LINE_RATIO = 0.98;
const DOM_TEXT_EMPTY_LINE_RATIO = 0.02;

// 文字単位の切り出しを行う上限。これを超える長さのテキストノードが境界に
// かかった場合は、行単位の判定（重なり50%以上なら採用）で妥協する。
const DOM_TEXT_CHAR_CLIP_MAX = 600;

// クロスオリジンiframeが選択範囲のこの割合以上を占める場合、
// 中身を読めないためTier 0を諦めてOCRへ回す。
const DOM_TEXT_FOREIGN_FRAME_RATIO = 0.25;

// 画像が選択範囲を占める割合がこれ以上で、かつ文字の占める面積が
// 画像面積の 1/4 に満たない場合は「画像を読ませたい選択」とみなしてOCRへ回す。
// 実測した実サイト10件の最大は 42%（楽天）で、いずれもこの条件には該当しない。
const DOM_TEXT_IMAGE_DOMINANT_RATIO = 0.5;
const DOM_TEXT_IMAGE_VS_TEXT_RATIO = 4;

// 画像の代替テキストを読むのは、その画像がこの割合以上選択範囲に入っているときだけ。
const DOM_TEXT_LABEL_MIN_INSIDE_RATIO = 0.6;

// 読み上げ対象にしないタグ
const DOM_TEXT_SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "META", "LINK",
    "SVG", "CANVAS", "AUDIO", "VIDEO", "IFRAME", "OBJECT", "EMBED"
]);

// 段落の区切りとして扱うブロック要素。この境界で「間」を入れる。
const DOM_TEXT_BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "MAIN", "NAV",
    "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "TR", "DT", "DD",
    "BLOCKQUOTE", "PRE", "FIGCAPTION", "FIGURE", "FORM", "UL", "OL", "DL",
    "TABLE", "ADDRESS", "HR", "BR"
]);

// getComputedStyle はレイアウト情報の読み出しを伴い、テキストノードごとに
// 祖先を遡って呼ぶと無視できないコストになる。1回の抽出の間だけ結果を覚えておく
// （抽出中にページのスタイルが変わることは想定しない）。
let styleCache = null;
// 祖先の overflow による切り取り枠も同様に1回の抽出の間だけ覚えておく
let clipBoxCache = null;

function cachedStyle(el) {
    if (!styleCache) {
        const view = el.ownerDocument.defaultView;
        return view ? view.getComputedStyle(el) : null;
    }
    let style = styleCache.get(el);
    if (style === undefined) {
        const view = el.ownerDocument.defaultView;
        style = view ? view.getComputedStyle(el) : null;
        styleCache.set(el, style);
    }
    return style;
}

// TreeWalker で現在のノードの部分木を飛ばして次へ進む。
// nextSibling() は次の兄弟が無いとき現在位置を動かさないため、
// そのまま nextNode() を呼ぶと飛ばしたはずの子へ降りてしまう。
function skipSubtree(walker) {
    const next = walker.nextSibling();
    if (next) return next;
    while (walker.parentNode()) {
        const sibling = walker.nextSibling();
        if (sibling) return sibling;
    }
    return null;
}

function rectIntersectionArea(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
}

function rectArea(r) {
    return Math.max(0, r.width) * Math.max(0, r.height);
}

// その要素が選択範囲に「しっかり入っている」か。
// 代替テキストは要素全体を表す文言なので、端に少し掛かっただけで採用すると
// 範囲外の内容を丸ごと読み上げることになる。
function isMostlyInside(box, sel, overlap) {
    const area = rectArea(box);
    if (area <= 0) return false;
    return overlap / area >= DOM_TEXT_LABEL_MIN_INSIDE_RATIO;
}

// フレームのオフセットを足して、最上位ビューポート座標へ変換する
function offsetRect(rect, offset) {
    if (!offset || (offset.x === 0 && offset.y === 0)) return rect;
    return {
        left: rect.left + offset.x,
        top: rect.top + offset.y,
        right: rect.right + offset.x,
        bottom: rect.bottom + offset.y,
        width: rect.width,
        height: rect.height
    };
}

// 画面には出さず支援技術にだけ読ませる「視覚的隠しテキスト」を見分ける。
// （例: Wikipedia のセクション開閉ボタンに付く「◯◯サブセクションを切り替えます」）
//
// 1px の箱に押し込めて overflow:hidden する／clip で潰す、という定型手法が使われる。
// これらはレイアウト上の矩形が通常サイズのまま残るため、行矩形の大きさでは判別できず、
// 祖先の指定を見る必要がある。本アプリは「画面で見えている範囲」を読み上げるため、
// 目に見えない補助ラベルは読まない（OCR経路の挙動とも揃う）。
function isVisuallyHiddenText(el) {
    let node = el;
    // 定型手法は数階層以内に収まるため、遡る範囲を限定してコストを抑える
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++, node = node.parentElement) {
        const style = cachedStyle(node);
        if (!style) return false;
        const clip = style.clip || "";
        if (/^rect\(\s*(0px,\s*){3}0px\s*\)$/.test(clip.replace(/\s+/g, " ").trim())) return true;
        const clipPath = style.clipPath || "";
        if (/inset\(\s*(50|100)%/.test(clipPath)) return true;
        if (style.overflow !== "visible") {
            const w = parseFloat(style.width);
            const h = parseFloat(style.height);
            if ((w > 0 && w <= 1) || (h > 0 && h <= 1)) return true;
        }
    }
    return false;
}

// 要素が視覚的に存在しているか。スクリーンリーダーが読まないものは読まない。
function isElementReadable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (DOM_TEXT_SKIP_TAGS.has(el.tagName)) return false;
    // aria-hidden の配下は支援技術から隠されている＝読み上げ対象外
    if (typeof el.closest === "function" && el.closest('[aria-hidden="true"]')) return false;
    // checkVisibility は display:none / visibility:hidden / opacity:0 /
    // content-visibility による非表示をまとめて判定できる（Chrome 125+）。
    if (typeof el.checkVisibility === "function") {
        return el.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
            contentVisibilityAuto: true
        });
    }
    const style = cachedStyle(el);
    if (!style) return true;
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.1;
}

// その要素が背景を塗っているか（＝後ろのものを実際に隠すか）。
function paintsBackground(el) {
    // 中身を描画する要素は無条件で隠すとみなす
    if (el.tagName === "IFRAME" || el.tagName === "IMG" || el.tagName === "VIDEO"
        || el.tagName === "CANVAS" || el.tagName === "OBJECT" || el.tagName === "EMBED") {
        return true;
    }
    const style = cachedStyle(el);
    if (!style) return true;
    if (style.backgroundImage && style.backgroundImage !== "none") return true;
    const match = /^rgba?\(([^)]+)\)/.exec(style.backgroundColor || "");
    if (!match) return false;
    const parts = match[1].split(",").map((v) => parseFloat(v));
    // rgb(...) は不透明、rgba(...) はアルファで判断する
    return parts.length < 4 || parts[3] > 0.05;
}

// その座標でテキストが実際に見えているかを、重なり全体をたどって判定する。
//
// 最前面の1要素だけを見る方法では判定を誤る。
// - カード全体をリンクにする実装（透明な <a> を重ねる手法）では、透明な要素が
//   最前面に来るため、見えている本文を「覆われている」と誤判定する。
// - 逆に、サンプル閲覧などのライトボックスでは、最前面が透明な当たり判定用の
//   要素だと「覆われていない」と誤判定し、その裏にある別の内容を読み上げてしまう
//   （実機で「Amazonの価格設定と割引について」が読み上げられた原因）。
//
// そこで、手前から順に要素をたどり、自分に到達する前に「背景を塗る要素」が
// あれば覆われているとみなす。透明な要素は何枚あっても素通しにする。
function isTopMostAt(el, x, y) {
    const root = el.getRootNode();
    // Shadow DOM 内の要素は、その ShadowRoot 側で判定しないと常にホストが返る
    const picker = root && typeof root.elementsFromPoint === "function" ? root : el.ownerDocument;
    let stack;
    try {
        stack = picker.elementsFromPoint(x, y);
    } catch (e) {
        return true; // 判定できない場合は読む側に倒す
    }
    if (!stack || !stack.length) return false;
    for (const node of stack) {
        // 自分（またはその祖先・子孫）に到達した＝手前に遮るものが無かった
        if (node === el || el.contains(node) || node.contains(el)) return true;
        if (paintsBackground(node)) return false;
    }
    // 重なりの中に自分が現れない＝別の階層に隠れている
    return false;
}

// テキストが実際に見えているかを、行ごとに複数点で確かめる。
//
// 折り返した複数行のテキストは、外接矩形の中心が行間の隙間や隣のカードに
// 当たることが多い。そこを1点だけ見て判定すると、覆われてもいないテキストを
// 大量に捨てることになる（実測: note・朝日・NHKの取りこぼしのほぼ全てがこれだった）。
// 行矩形ごとに幅方向の3点を見て、1つでも通れば見えているとみなす。
function isTextVisiblyOnTop(el, lineRects, sel, offset) {
    const ox = offset ? offset.x : 0;
    const oy = offset ? offset.y : 0;
    let checked = 0;
    for (const r of lineRects) {
        if (rectIntersectionArea(r, sel) <= 0) continue;
        // 選択範囲と重なっている部分の中でサンプリングする
        const left = Math.max(r.left, sel.left);
        const right = Math.min(r.right, sel.right);
        const top = Math.max(r.top, sel.top);
        const bottom = Math.min(r.bottom, sel.bottom);
        if (right - left < 1 || bottom - top < 1) continue;
        const cy = (top + bottom) / 2 - oy;
        for (const t of [0.25, 0.5, 0.75]) {
            const cx = left + (right - left) * t - ox;
            checked++;
            if (isTopMostAt(el, cx, cy)) return true;
        }
        // 行数が多い場合は先頭の数行だけで判断する（コスト抑制）
        if (checked >= 12) break;
    }
    // 一度も判定できなかった（範囲外など）場合は読む側に倒す
    return checked === 0;
}

// ルビの扱い。設定 ocrRemoveRuby=true は「ルビ優先読み」を意味する
// （OCR経路の実装と同じ意味。true なら本文の代わりに読み rt を読む）。
// 既定の false では本文（親文字）を読み、rt は読まない。
// OCR経路では文字サイズと行位置から推定していた区別が、DOMでは構造そのもの。
function rubyRoleOf(node) {
    let el = node.parentElement;
    while (el) {
        const tag = el.tagName;
        if (tag === "RT") return "reading";
        if (tag === "RP") return "paren";      // ルビ非対応ブラウザ向けの括弧。常に読まない
        if (tag === "RUBY") return "base";
        el = el.parentElement;
    }
    return null;
}

// 直近のブロック要素。ここが変わったら段落の切れ目とみなす。
function blockAncestorOf(node) {
    let el = node.parentElement;
    while (el) {
        if (DOM_TEXT_BLOCK_TAGS.has(el.tagName)) return el;
        el = el.parentElement;
    }
    return null;
}

// 祖先の overflow による切り取りを行矩形に反映する。
//
// 折りたたみ（max-height:0 + overflow:hidden）やカルーセルでは、画面に出ていない
// 文字の行矩形が、はみ出した位置＝別の内容の上に重なって返ってくる。そのまま扱うと
// 「画面に無い文章が読み上げられる」ことになるため、実際に見えている部分だけに絞る。
function clipRectsByAncestorOverflow(rects, el, offset) {
    // 同じ親を持つテキストノードが多数あるため、祖先の切り取り枠は覚えておく
    let boxes = clipBoxCache ? clipBoxCache.get(el) : null;
    if (!boxes) {
        boxes = [];
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
            const style = cachedStyle(node);
            if (style && style.overflow && style.overflow !== "visible") {
                boxes.push(offsetRect(node.getBoundingClientRect(), offset));
            }
        }
        if (clipBoxCache) clipBoxCache.set(el, boxes);
    }
    let clipped = rects;
    for (const box of boxes) {
        if (!clipped.length) break;
        clipped = clipped
            .map((r) => {
                const left = Math.max(r.left, box.left);
                const top = Math.max(r.top, box.top);
                const right = Math.min(r.right, box.right);
                const bottom = Math.min(r.bottom, box.bottom);
                return { left, top, right, bottom, width: right - left, height: bottom - top };
            })
            .filter((r) => r.width > 0.5 && r.height > 0.5);
    }
    return clipped;
}

// テキストノードのうち、選択矩形に入っている部分だけを取り出す。
// 行矩形との重なりで粗く判定し、境界にかかった行だけ文字単位で切り出す。
function clipTextNode(node, sel, offset, doc) {
    const empty = { text: "", lineRects: [] };
    const value = node.nodeValue;
    if (!value || !value.trim()) return empty;

    const range = doc.createRange();
    range.selectNodeContents(node);
    const rawRects = Array.from(range.getClientRects())
        .map((r) => offsetRect(r, offset))
        .filter((r) => rectArea(r) > 0);
    if (!rawRects.length) return empty;

    // 祖先の overflow で切り取られて画面に出ていない部分を落とす。
    // これをしないと、折りたたみやカルーセルの中の見えない文字が
    // 別の内容の上に重なった矩形として拾われてしまう。
    const lineRects = clipRectsByAncestorOverflow(rawRects, node.parentElement, offset);
    if (!lineRects.length) return empty;

    let fullyInside = 0;
    let partial = false;
    for (const r of lineRects) {
        const ratio = rectIntersectionArea(r, sel) / rectArea(r);
        if (ratio >= DOM_TEXT_FULL_LINE_RATIO) fullyInside++;
        else if (ratio > DOM_TEXT_EMPTY_LINE_RATIO) partial = true;
    }

    // 全ての行が完全に入っている → そのまま
    if (fullyInside === lineRects.length) return { text: value, lineRects };
    // どの行も掠っていない → 対象外
    if (!fullyInside && !partial) return empty;

    // 境界にかかっている。長すぎる場合は行単位の判定で妥協する
    if (value.length > DOM_TEXT_CHAR_CLIP_MAX) {
        let inside = 0;
        for (const r of lineRects) {
            if (rectIntersectionArea(r, sel) / rectArea(r) >= 0.5) inside++;
        }
        return inside >= lineRects.length / 2 ? { text: value, lineRects } : empty;
    }

    // 文字単位で切り出す。文字の中心が選択範囲に入っているものだけを残す。
    let out = "";
    for (let i = 0; i < value.length; i++) {
        try {
            range.setStart(node, i);
            range.setEnd(node, i + 1);
        } catch (e) {
            break;
        }
        const r = offsetRect(range.getBoundingClientRect(), offset);
        if (rectArea(r) === 0) {
            // 改行・折り返し位置の空白等。前後が採用されていれば残す
            if (out) out += value[i];
            continue;
        }
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        if (cx >= sel.left && cx <= sel.right && cy >= sel.top && cy <= sel.bottom) {
            out += value[i];
        }
    }
    return { text: out, lineRects };
}

// 画像は認識せず、著者が書いた代替テキストを読む。
// alt が空文字の画像は「装飾用」と明示されたものなので読まない（HTML仕様）。
function imageAltOf(el) {
    if (el.tagName === "IMG") {
        const role = el.getAttribute("role");
        if (role === "presentation" || role === "none") return "";
        const label = el.getAttribute("aria-label");
        if (label && label.trim()) return label.trim();
        // alt 属性が存在しない場合と空文字は区別する（空文字＝装飾用）
        if (el.hasAttribute("alt")) return el.getAttribute("alt").trim();
        return "";
    }
    const label = el.getAttribute("aria-label");
    return label && label.trim() ? label.trim() : "";
}

/**
 * 1つの文書（トップ文書・同一オリジンiframe・open な Shadow Root）を走査して、
 * 選択矩形に入っているテキスト断片を収集する。
 * 座標は全て最上位ビューポート基準に揃える（offset で補正）。
 */
function collectFromDocument(root, doc, sel, offset, options, out) {
    const win = doc.defaultView;
    if (!win) return;

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
            if (node.nodeType === 1) {
                if (DOM_TEXT_SKIP_TAGS.has(node.tagName)) {
                    // iframe と canvas は「読めない領域」として面積だけ記録する
                    if (node.tagName === "IFRAME" || node.tagName === "CANVAS"
                        || node.tagName === "VIDEO" || node.tagName === "SVG") {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
            return node.nodeValue && node.nodeValue.trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
        }
    });

    let node = walker.currentNode && walker.currentNode.nodeType === 3 ? walker.currentNode : walker.nextNode();
    // TreeWalker は root 自身から始まるため、明示的に先頭へ進める
    if (node === root) node = walker.nextNode();

    while (node) {
        if (node.nodeType === 1) {
            const el = node;

            // open な Shadow Root は中へ潜る。closed なものは読めない（OCR行き）。
            if (el.shadowRoot) {
                collectFromDocument(el.shadowRoot, doc, sel, offset, options, out);
            }

            // 矩形の取得はレイアウト計算を伴うため、必要な要素だけで行う。
            // 通常の要素は素通りさせ、テキストノード側の行矩形だけで判定する。
            const isMedia = el.tagName === "IFRAME" || el.tagName === "IMG"
                || el.tagName === "CANVAS" || el.tagName === "SVG" || el.tagName === "VIDEO";
            if (!isMedia) {
                node = walker.nextNode();
                continue;
            }
            const box = offsetRect(el.getBoundingClientRect(), offset);
            const overlap = rectIntersectionArea(box, sel);

            if (el.tagName === "IFRAME") {
                if (overlap > 0) {
                    let inner = null;
                    try {
                        inner = el.contentDocument;
                    } catch (e) {
                        inner = null; // クロスオリジン
                    }
                    if (inner && inner.body) {
                        // 同一オリジンなら中身をそのまま辿れる。
                        // 枠線とパディングの分だけ内側の原点がずれる。
                        const cs = cachedStyle(el) || win.getComputedStyle(el);
                        const childOffset = {
                            x: box.left + parseFloat(cs.borderLeftWidth || 0) + parseFloat(cs.paddingLeft || 0),
                            y: box.top + parseFloat(cs.borderTopWidth || 0) + parseFloat(cs.paddingTop || 0)
                        };
                        collectFromDocument(inner.body, inner, sel, childOffset, options, out);
                    } else if (isElementReadable(el) !== false) {
                        out.foreignArea += overlap;
                    }
                }
                node = skipSubtree(walker);
                continue;
            }

            if (overlap > 0 && (el.tagName === "CANVAS" || el.tagName === "SVG" || el.tagName === "VIDEO")) {
                // 中身が文字かどうかは分からないので、代替テキストの有無に関わらず
                // 「文字として取り出せていない面積」として数える。
                out.opaqueArea += overlap;
                if (isMostlyInside(box, sel, overlap)) {
                    const label = imageAltOf(el);
                    if (label) out.units.push({ text: label, rect: box, kind: "label" });
                }
                node = skipSubtree(walker);
                continue;
            }

            // 「選択範囲にかからない部分木をまとめて飛ばす」最適化は入れない。
            // 親要素の矩形には、浮動要素や絶対配置の子孫が含まれないことがあり
            // （実測: Wikipedia の infobox が丸ごと落ちた）、安全に飛ばせないため。
            if (el.tagName === "IMG" && overlap > 0) {
                if (isElementReadable(el)) {
                    // 代替テキストの有無に関わらず、画像は「文字として取り出せていない
                    // 面積」として数える。代替テキストがあっても、それが画像の中身を
                    // 表しているとは限らないため（広告バナー等）。
                    out.opaqueArea += overlap;
                    // 代替テキストを読むのは、その画像が選択範囲にしっかり入っている
                    // ときだけにする。端に少し掛かっただけの隣の広告の文言を丸ごと
                    // 読み上げてしまう事故を防ぐ。
                    if (isMostlyInside(box, sel, overlap)) {
                        const alt = imageAltOf(el);
                        if (alt) out.units.push({ text: alt, rect: box, kind: "alt" });
                    }
                }
                node = skipSubtree(walker);
                continue;
            }

            node = walker.nextNode();
            continue;
        }

        // --- テキストノード ---
        const parent = node.parentElement;
        if (!parent || !isElementReadable(parent) || isVisuallyHiddenText(parent)) {
            node = walker.nextNode();
            continue;
        }

        const role = rubyRoleOf(node);
        const skipRuby = role === "paren"
            || (options.removeRuby ? role === "base" : role === "reading");
        if (skipRuby) {
            node = walker.nextNode();
            continue;
        }

        const clipped = clipTextNode(node, sel, offset, doc);
        if (clipped.text && clipped.text.trim()
            && isTextVisiblyOnTop(parent, clipped.lineRects, sel, offset)) {
            for (const r of clipped.lineRects) out.textArea += rectIntersectionArea(r, sel);
            out.units.push({
                text: clipped.text,
                rect: clipped.lineRects[0],
                kind: "text",
                block: blockAncestorOf(node)
            });
        }
        node = walker.nextNode();
    }
}

// 収集した断片を、段落の切れ目を保ったまま1つのテキストへ組み立てる。
// 並び順は文書順（＝著者が意図した順序であり、スクリーンリーダーが読む順序）。
function joinTextUnits(units) {
    const parts = [];
    let prevBlock = null;
    let prevKey = null;
    for (const unit of units) {
        // HTMLの字下げによる改行や連続空白は文章としての意味を持たないので潰す。
        // 段落の「間」はブロック要素の境界だけで表す。
        const text = unit.text.replace(/\s+/g, " ");
        if (!text.trim()) continue;
        // 同じ文言が連続する場合は1回だけ読む。
        // 画像の代替テキストとリンクの文字列が同一のカード（ニュース一覧で頻出）や、
        // 支援技術向けに同じ見出しを重複して持つページで、二度読みになるのを防ぐ。
        const key = text.replace(/\s/g, "");
        if (key.length >= 4 && key === prevKey) continue;
        prevKey = key;
        if (parts.length && unit.block !== prevBlock) parts.push("\n");
        parts.push(text);
        prevBlock = unit.block !== undefined ? unit.block : null;
    }
    return parts.join("")
        // 日本語の文字どうしの間に入った空白は組版上の区切りでしかないため取り除く
        // （読み上げでは不自然な間として現れてしまう）
        .replace(/([\u3000-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]) +(?=[\u3000-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F])/g, "$1")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

/**
 * 選択矩形（ビューポートCSS座標）からページのテキストを取り出す。
 *
 * @returns {{ok: boolean, text: string, chars: number, reason: string, stats: object}}
 *   ok=false のときは OCR 経路へ回すべきことを示し、reason にその理由が入る。
 */
function collectRegionText(rect, options = {}) {
    const started = Date.now();
    const sel = {
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        width: rect.width,
        height: rect.height
    };
    const selArea = rectArea(sel);
    const out = { units: [], foreignArea: 0, opaqueArea: 0, textArea: 0 };
    styleCache = new Map();
    clipBoxCache = new Map();

    try {
        collectFromDocument(document.body || document.documentElement, document, sel, null, options, out);
    } catch (err) {
        styleCache = null;
        clipBoxCache = null;
        return {
            ok: false,
            text: "",
            chars: 0,
            reason: `抽出中のエラー: ${err.message}`,
            stats: { ms: Date.now() - started }
        };
    }

    styleCache = null;
    clipBoxCache = null;
    const text = joinTextUnits(out.units);
    const chars = text.replace(/\s/g, "").length;
    // 画像同士が重なると面積が二重に積まれるため、選択範囲を超えないよう抑える
    const opaqueArea = Math.min(out.opaqueArea, selArea);
    const stats = {
        ms: Date.now() - started,
        units: out.units.length,
        chars,
        foreignRatio: selArea > 0 ? out.foreignArea / selArea : 0,
        opaqueRatio: selArea > 0 ? opaqueArea / selArea : 0,
        textRatio: selArea > 0 ? Math.min(out.textArea, selArea) / selArea : 0
    };

    // クロスオリジンiframeが選択範囲の大部分を占めるなら、
    // 取れた分だけを読むと内容が欠けるので、画面全体をOCRした方が正しい。
    if (stats.foreignRatio >= DOM_TEXT_FOREIGN_FRAME_RATIO) {
        return { ok: false, text, chars, reason: "別オリジンのフレームが範囲の大半を占める", stats };
    }
    if (chars < DOM_TEXT_MIN_CHARS) {
        return { ok: false, text, chars, reason: "テキストが見つからない（画像・canvas等）", stats };
    }
    // 選択範囲の大半が画像で、文字はその周りに少しあるだけ（キャプションや
    // 見出しだけ）の場合は、画像の中の文字こそが読みたいものと考えられる。
    // ページ内テキストだけを読むと肝心の中身を飛ばすため、OCRへ回す。
    if (stats.opaqueRatio >= DOM_TEXT_IMAGE_DOMINANT_RATIO
        && out.textArea * DOM_TEXT_IMAGE_VS_TEXT_RATIO < opaqueArea) {
        return { ok: false, text, chars, reason: "選択範囲の大半が画像", stats };
    }
    return { ok: true, text, chars, reason: "", stats };
}

// 拡張機能内（content script）と検証用スクリプトの両方から使えるように公開する
globalThis.VVRadioDomText = { collectRegionText, DOM_TEXT_MIN_CHARS };

})();
