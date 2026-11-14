/**
 * 文字幅の計測 (`TextMeasurer`) のブラウザ用の実装 (§4.7)。SVG の描画と同じ幅を返す。
 * キャンバス・書き出し・行分割は `canvasTextMeasurer` を使う。
 *
 * - フォントは描画と同じ `font-family` (`cssFont` / `cssFontFamily`) で指定する
 * - 速さのため canvas の `measureText` を使い、描画と幅が違う場合は見えない SVG の `<text>` の
 *   `getComputedTextLength` で測る: 絵文字を含む文字列 (Chromium の canvas は 16px の絵文字を 20px と測る)、
 *   canvas と SVG で幅が合わないフォント (Chromium の `system-ui` など。フォントごとに最初に測り比べる)
 * - 字間は足し算で扱う (Safari 15 の canvas は `letterSpacing` を持たない)。CSS / SVG の
 *   `letter-spacing` と同じく、書記素クラスタごとに付け、最後の文字の後にも付く
 * - ベースラインの位置を決めるため、フォントのアセント・ディセントも返す (`fontMetrics`)。編集欄と同じ
 *   HTML の行の箱から求めるので、編集欄の文字と描画の文字の上下の位置がそろう。契約 (`TextMeasurer`) に
 *   ない追加の口 (`text/metrics.ts`) で、持たない計測では既定の比率を使う
 */
import { forEachGrapheme, graphemeCount } from "../text/graphemes";
import { shapingUnits, type LineBreakOptions } from "../text/lineBreak";
import type { FontMetrics, MetricsTextMeasurer } from "../text/metrics";
import { cssFont, cssFontFamily } from "./buildNodeSvg";
import type { FontSpec } from "./types";

/** 字間の合計。書記素クラスタごとに付ける (CSS / SVG の `letter-spacing` と同じ単位)。 */
export function letterSpacingWidth(text: string, letterSpacing: number): number {
  if (letterSpacing === 0 || text === "") return 0;
  return graphemeCount(text) * letterSpacing;
}

/** コードポイントの数 (サロゲートペアを 1 文字と数える)。 */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // 上位サロゲートの次に下位サロゲートが続くなら 2 単位で 1 文字
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** jsdom などレイアウトのない環境か (canvas も SVG の計測も使わない)。 */
function isLayoutlessEnvironment(): boolean {
  return (
    typeof document === "undefined" ||
    typeof navigator === "undefined" ||
    /jsdom/i.test(navigator.userAgent)
  );
}

/** 計測に使う文書。レイアウトのない環境では null。 */
export function defaultMeasureDocument(): Document | null {
  return isLayoutlessEnvironment() ? null : document;
}

/**
 * canvas の 2D コンテキストを 1 つだけ作る。jsdom など canvas が使えない環境では null。
 * - canvas は html の直下につなぎ、`<html lang>` を引き継がせる。つながない canvas は言語を持たないので、
 *   `sans-serif` などの総称フォントと和文の代わりのフォントが、描画 (`lang="ja"` の文書の SVG) と違うものになる
 * - `textRendering` があれば `geometricPrecision` にする (Chromium の canvas は既定で字幅を丸め、
 *   SVG の描画より広く測る。Safari 15 は持たない)
 */
export function createMeasureContext(
  getDocument: () => Document | null = defaultMeasureDocument,
): () => CanvasRenderingContext2D | null {
  let context: CanvasRenderingContext2D | null | undefined;
  let doc: Document | null = null;
  return () => {
    if (context === undefined) {
      try {
        doc = getDocument();
        if (!doc) context = null;
        else {
          const canvas = doc.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          canvas.setAttribute("aria-hidden", "true");
          canvas.setAttribute("data-canvas-text-measure", "");
          canvas.setAttribute("style", HIDDEN_STYLE);
          attach(doc, canvas);
          context = canvas.getContext("2d");
          const styles = context as (CanvasRenderingContext2D & { textRendering?: string }) | null;
          if (styles && "textRendering" in styles) styles.textRendering = "geometricPrecision";
        }
      } catch {
        context = null;
      }
    }
    if (doc && context && !context.canvas.isConnected) attach(doc, context.canvas);
    return context;
  };
}

/** 文字の種類 (`scriptClasses` のビット)。canvas と描画の幅が合うかを、フォントとこの種類の組で見る。 */
export const LATIN = 1;
export const CJK = 2;
/** そのほかの文字 (ギリシャ・キリル・アラビア文字、記号など)。どのフォントで描かれるかが読めない */
export const OTHER = 4;
export const EMOJI = 8;

function isEmojiCode(code: number): boolean {
  return (
    code === 0x200d ||
    code === 0x20e3 ||
    code === 0xfe0f ||
    (code >= 0x2300 && code <= 0x23ff) ||
    (code >= 0x25a0 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff)
  );
}

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 文字列に含まれる文字の種類 (`LATIN` | `CJK` | `OTHER` | `EMOJI` のビットの和)。
 * 欧文はラテン文字と一般句読点 (U+0000〜U+024F、U+2000〜U+206F)。和文は CJK の記号・かな・漢字・
 * ハングル・全角形と、U+20000 以降の漢字。絵文字は U+1F000 以降、タグ文字、絵文字になりうる記号と
 * ZWJ・異体字セレクタ 16・キーキャップ。
 */
export function scriptClasses(text: string): number {
  let classes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x250 || (code >= 0x2000 && code <= 0x206f && code !== 0x200d)) classes |= LATIN;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 上位サロゲートで分かる: U+1F000〜U+1FFFF (絵文字、地域指示記号)、U+20000〜U+3FFFF (漢字)、U+E0000 (タグ)
      if (code >= 0xd83c && code <= 0xd83f) classes |= EMOJI;
      else if (code >= 0xd840 && code <= 0xd8bf) classes |= CJK;
      else if (code === 0xdb40) classes |= EMOJI;
      else classes |= OTHER;
      i++;
    } else if (isEmojiCode(code)) classes |= EMOJI;
    else if (isCjkCode(code)) classes |= CJK;
    else classes |= OTHER;
  }
  return classes;
}

/** 絵文字として描かれうる文字を含むか。 */
export function mayContainEmoji(text: string): boolean {
  return (scriptClasses(text) & EMOJI) !== 0;
}

/**
 * WebKit が複雑な組版の経路で組む文字を含むか: 字形を組み合わせる文字 (ヘブライ・アラビア・インドの文字、
 * ハングルの字母など)、結合文字 (U+0300〜、U+1DC0〜、記号用、かなの濁点)、声調の字母、ZWJ・ZWNJ、異体字セレクタ、
 * 絵文字の肌の色、旗 (地域指示記号)、タグ文字。WebKit の SVG は字間があると、この経路では文字列全体を
 * カーニングして組み、ほかの経路では 1 文字ずつ並べる。
 */
export function usesComplexTextPath(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // 結合のダイアクリティカルマーク (`e` + U+0301 など) と声調の字母
    if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x02e5 && code <= 0x02e9)) return true;
    if (code < 0x0591) continue;
    if (code <= 0x1cff) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        if (
          (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
          (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
          (cp >= 0xe0000 && cp <= 0xe01ef)
        )
          return true;
        i++;
      }
      continue;
    }
    if (
      (code >= 0x1dc0 && code <= 0x1dff) ||
      code === 0x200c ||
      code === 0x200d ||
      (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0x302a && code <= 0x302f) ||
      code === 0x3099 ||
      code === 0x309a ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    )
      return true;
  }
  return false;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/**
 * 計測用の要素を置く (画面の外、見えない、ポインターを受けない)。body ではなく html の直下に置き、
 * アプリの UI スケール (`body { zoom }`) の影響を受けないようにする。
 */
const HIDDEN_STYLE =
  "position:absolute;left:-10000px;top:-10000px;visibility:hidden;pointer-events:none;contain:layout style";

function attach(doc: Document, element: Element): void {
  if (!element.isConnected) doc.documentElement.appendChild(element);
}

/**
 * 見えない SVG の `<text>` で幅を測る (`getComputedTextLength`)。字間を含む。測れない環境では null を返す。
 * Chromium では描画と同じ幅 (カーニングを含む) を返すが、WebKit はカーニングを含まない値を返すので、
 * 使うかどうかは `createCanvasTextMeasurer` が実測で決める。描画 (`buildNodeShell`) と同じく
 * `text-rendering="geometricPrecision"` を付け、表示の倍率に関係なく指定のフォントサイズで組ませる。
 * 空白は描画 (`xml:space="preserve"`) と同じく保つ。属性は XML の名前空間に置かないと効かないので
 * `setAttributeNS` を使い、CSS の `white-space: pre` も付ける。測り終えたら本文を空にする。
 */
export function createSvgTextMeasure(
  getDocument: () => Document | null = defaultMeasureDocument,
): (text: string, font: FontSpec) => number | null {
  let element: SVGTextElement | null | undefined;
  let doc: Document | null = null;
  const ensure = (): SVGTextElement | null => {
    if (element === undefined) {
      try {
        doc = getDocument();
        if (!doc) element = null;
        else {
          const svg = doc.createElementNS(SVG_NS, "svg");
          svg.setAttribute("aria-hidden", "true");
          svg.setAttribute("data-canvas-text-measure", "");
          svg.setAttribute("style", `${HIDDEN_STYLE};width:0;height:0;overflow:hidden`);
          const text = doc.createElementNS(SVG_NS, "text") as SVGTextElement;
          text.setAttributeNS(XML_NS, "xml:space", "preserve");
          text.setAttribute("text-rendering", "geometricPrecision");
          text.setAttribute("style", "white-space:pre");
          svg.appendChild(text);
          element = typeof text.getComputedTextLength === "function" ? text : null;
        }
      } catch {
        element = null;
      }
    }
    const svg = element?.parentNode;
    if (doc && svg instanceof Element) attach(doc, svg);
    return element;
  };
  return (text, font) => {
    const target = ensure();
    if (!target) return null;
    target.setAttribute("font-family", cssFontFamily(font.family));
    target.setAttribute("font-size", String(font.size));
    target.setAttribute("font-weight", String(font.weight));
    target.setAttribute("font-style", font.italic ? "italic" : "normal");
    target.setAttribute("letter-spacing", String(font.letterSpacing));
    target.textContent = text;
    const width = target.getComputedTextLength();
    target.textContent = "";
    return Number.isFinite(width) ? width : null;
  };
}

/**
 * フォントのアセントとディセントを、HTML の行の箱から求める (編集欄の `<textarea>` と同じ組版)。
 * インラインの要素の内容の箱 (アセント + ディセント) と、高さ 0 のインラインブロックで示したベースラインを測る。
 * 要素は html の直下に置き、さらに幅 100px の物差しで割って、UI スケール (`zoom`) に関係なく CSS px で返す。
 * 測れない環境では null。
 */
export function createDomFontMetrics(
  getDocument: () => Document | null = defaultMeasureDocument,
): (font: FontSpec) => FontMetrics | null {
  let parts:
    | {
        doc: Document;
        box: HTMLElement;
        text: HTMLElement;
        marker: HTMLElement;
        ruler: HTMLElement;
      }
    | null
    | undefined;
  const ensure = () => {
    if (parts === undefined) {
      try {
        const doc = getDocument();
        if (!doc) parts = null;
        else {
          const box = doc.createElement("div");
          box.setAttribute("aria-hidden", "true");
          box.setAttribute("data-canvas-text-measure", "");
          box.setAttribute("style", `${HIDDEN_STYLE};white-space:pre;line-height:normal`);
          const text = doc.createElement("span");
          text.textContent = "x";
          const marker = doc.createElement("span");
          marker.setAttribute("style", "display:inline-block;width:0;height:0");
          const ruler = doc.createElement("div");
          ruler.setAttribute("style", "width:100px;height:0");
          box.append(text, marker, ruler);
          parts = { doc, box, text, marker, ruler };
        }
      } catch {
        parts = null;
      }
    }
    if (parts) attach(parts.doc, parts.box);
    return parts;
  };
  return (font) => {
    const current = ensure();
    if (!current) return null;
    current.box.style.font = cssFont(font);
    current.box.style.lineHeight = "normal";
    const scale = current.ruler.getBoundingClientRect().width / 100;
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const content = current.text.getBoundingClientRect();
    const baseline = current.marker.getBoundingClientRect().top;
    const ascent = (baseline - content.top) / scale;
    const descent = (content.bottom - baseline) / scale;
    if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent + descent <= 0) return null;
    return { ascent, descent };
  };
}

/** かなの並び (ヒラギノなどはかなの組をカーニングする)。単位ごとに組むと、単位をまたぐ分だけ広くなる。 */
export const UNIT_SHAPING_PROBE = "テキストテキストテキストテキスト";
export const UNIT_SHAPING_PROBE_FAMILIES = [
  "Hiragino Sans",
  "Hiragino Kaku Gothic ProN",
  "Yu Gothic",
  "Meiryo",
  "sans-serif",
] as const;

/**
 * かなの並びを、ふつうと `word-break: keep-all` (和文の間で折り返さない = 単位に分けない) で組んだ幅を比べ、
 * 違えば HTML は折り返せる単位ごとに組んでいる (WebKit)。かなをカーニングするフォント (ヒラギノなど) が
 * 見つからなければ、違いが出ないので決めない (行全体で判定する)。
 */
function shapesPerUnit(doc: Document): boolean {
  const box = doc.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.setAttribute("lang", "ja");
  box.setAttribute(
    "style",
    `${HIDDEN_STYLE};white-space:pre-wrap;overflow-wrap:break-word;line-break:strict`,
  );
  const normal = doc.createElement("span");
  const kept = doc.createElement("span");
  normal.textContent = UNIT_SHAPING_PROBE;
  kept.textContent = UNIT_SHAPING_PROBE;
  kept.setAttribute("style", "word-break:keep-all");
  box.append(normal, doc.createElement("br"), kept);
  attach(doc, box);
  try {
    for (const family of UNIT_SHAPING_PROBE_FAMILIES) {
      box.style.font = `32px ${cssFontFamily(family)}`;
      const split = normal.getBoundingClientRect().width;
      const whole = kept.getBoundingClientRect().width;
      if (split > 0 && whole > 0 && Math.abs(split - whole) > 0.5) return true;
    }
    return false;
  } finally {
    box.remove();
  }
}

/**
 * 範囲の、幅のある矩形。WKWebView は、次の行へ送られた文字の範囲にも、前の行の末尾の幅 0 の矩形を
 * 返すので、それを数えない。幅のある矩形がなければ (幅 0 の文字、矩形を返さない環境) 範囲を囲む矩形。
 */
function visibleRects(range: Range): DOMRect[] {
  const list = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  const rects = list.filter((rect) => rect.width > 0);
  return rects.length > 0 ? rects : [range.getBoundingClientRect()];
}

/**
 * 折り返しの規則を確かめる文字列。`text` を幅 `width` (フォント `font`) に置き、`index` の文字が 1 行目に
 * 残るかを見る。`index` は行頭に来ない文字にする (WebKit は、折り返した直後の文字の範囲を前の行の末尾として返す)。
 * - `/` の後: `aaaa/` が 1 行目に残れば `/` の後で折り返す (WebKit)。残らなければ単語ごと次の行へ (Chromium)
 * - `-` の後の数字: `11-` が 1 行目に残れば折り返す (Chromium)
 * - 前置の記号: `a:` が 1 行目に残れば `:` の後、`\` の前で折り返す (WebKit)
 * - 全角空白: ぶら下がれば `ああああ` と全角空白が 1 行目に残る (Chromium)。ぶら下がらなければ、4 つめの `あ` と
 *   全角空白が次の行へ送られる (WebKit)
 */
export const LINE_BREAK_PROBES = {
  breakAfterSolidus: { text: "xx aaaa/bbbb", width: "8.5ch", font: "16px monospace", index: 7 },
  breakHyphenBeforeDigit: { text: "xx 11-22", width: "6.5ch", font: "16px monospace", index: 4 },
  breakBeforeAsciiPrefix: { text: "xx a:\\bbb", width: "7.5ch", font: "16px monospace", index: 4 },
  ideographicSpaceHangs: {
    text: "ああああ\u3000い",
    width: "4.5em",
    font: "16px sans-serif",
    index: 4,
  },
} as const;

/**
 * エンジンによって違う折り返しの規則を、編集欄と同じ CSS の要素で 1 回だけ確かめる。測れない環境では既定 (空)。
 * どれも、狭い幅に置いた文字列のある文字が 1 行目に残るかで見る (`LINE_BREAK_PROBES`)。
 * 単位ごとの組み (`shapePerUnit`) は `shapesPerUnit` で見る。確かめる要素は終わったら (途中で例外が出ても)
 * 外す。例外が出たら結果を覚えず、次に呼ばれたときに確かめ直す (それまでは既定の規則)。
 */
export function createLineBreakProbe(
  getDocument: () => Document | null = defaultMeasureDocument,
): () => LineBreakOptions {
  let result: LineBreakOptions | undefined;
  return () => {
    if (result !== undefined) return result;
    let box: HTMLElement | null = null;
    try {
      const doc = getDocument();
      if (!doc) {
        result = {};
        return result;
      }
      const current = doc.createElement("div");
      box = current;
      current.setAttribute("aria-hidden", "true");
      current.setAttribute("lang", "ja");
      current.setAttribute(
        "style",
        `${HIDDEN_STYLE};line-height:20px;white-space:pre-wrap;` +
          "overflow-wrap:break-word;word-break:normal;line-break:strict",
      );
      attach(doc, current);
      const range = doc.createRange();
      /** 確かめる文字が 1 行目に残るか。行が分かれない (レイアウトのない環境) なら null */
      const staysOnFirstLine = (
        probe: (typeof LINE_BREAK_PROBES)[keyof typeof LINE_BREAK_PROBES],
      ) => {
        current.style.font = probe.font;
        current.style.width = probe.width;
        current.textContent = probe.text;
        const text = current.firstChild as Text;
        const topOf = (index: number) => {
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const rects = visibleRects(range);
          return (rects[rects.length - 1] as DOMRect).top;
        };
        const first = topOf(0);
        // 行が分かれたかは最後の文字で見る
        if (!(topOf(probe.text.length - 1) > first)) return null;
        return topOf(probe.index) === first;
      };
      const solidus = staysOnFirstLine(LINE_BREAK_PROBES.breakAfterSolidus);
      // 行が分かれていない (レイアウトのない環境) なら決めない
      result =
        solidus === null
          ? {}
          : {
              breakAfterSolidus: solidus,
              breakHyphenBeforeDigit:
                staysOnFirstLine(LINE_BREAK_PROBES.breakHyphenBeforeDigit) === true,
              breakBeforeAsciiPrefix:
                staysOnFirstLine(LINE_BREAK_PROBES.breakBeforeAsciiPrefix) === true,
              keepIdeographicSpace:
                staysOnFirstLine(LINE_BREAK_PROBES.ideographicSpaceHangs) === false,
              shapePerUnit: shapesPerUnit(doc),
            };
      return result;
    } catch {
      // 確かめられなければ、今回は既定の規則で、次に確かめ直す
      return {};
    } finally {
      box?.remove();
    }
  };
}

/** 前の文字が文字や数字なら、行末で詰めるかに関わらないので 1 つの代表で確かめる。 */
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;

/**
 * 行末の約物を詰める割合 (`MetricsTextMeasurer.lineEndTrim`) を、編集欄と同じ CSS の要素で、フォント・字間・
 * 末尾の 2 文字の組ごとに確かめる (Chromium の `text-spacing-trim`。詰めるかは字と、その前の文字で変わる。
 * たとえば `〛` は詰めず、`」` の後の `、` は詰める)。`ああ` + 前の文字 + 約物 + `い` を、行の幅より少しだけ
 * 狭い幅に置き、約物が 1 行目に残れば、行の縮んだ幅を約物の幅で割った値を返す。残ったかは幅のある矩形で
 * 見る (`visibleRects`)。縮んだ幅が字の送りの半分を超えるものは採らない。測れない環境では 0。
 * 確かめた要素の本文は終わったら空にする。例外が出たら結果を覚えず、次に確かめ直す。
 */
export function createLineEndTrimProbe(
  getDocument: () => Document | null = defaultMeasureDocument,
): (previous: string, last: string, font: FontSpec) => number {
  let parts: { doc: Document; box: HTMLElement; ruler: HTMLElement } | null | undefined;
  const results = new Map<string, number>();
  const ensure = () => {
    if (parts === undefined) {
      try {
        const doc = getDocument();
        if (!doc) parts = null;
        else {
          const box = doc.createElement("div");
          box.setAttribute("aria-hidden", "true");
          box.setAttribute("data-canvas-text-measure", "");
          box.setAttribute("lang", "ja");
          box.setAttribute(
            "style",
            `${HIDDEN_STYLE};line-height:normal;white-space:pre-wrap;` +
              "overflow-wrap:break-word;word-break:normal;line-break:strict",
          );
          const ruler = doc.createElement("div");
          ruler.setAttribute("style", `${HIDDEN_STYLE};width:100px;height:0`);
          ruler.setAttribute("aria-hidden", "true");
          ruler.setAttribute("data-canvas-text-measure", "");
          parts = { doc, box, ruler };
        }
      } catch {
        parts = null;
      }
    }
    if (parts) {
      attach(parts.doc, parts.box);
      attach(parts.doc, parts.ruler);
    }
    return parts;
  };
  return (previous, last, font) => {
    const before = previous === "" || LETTER_OR_DIGIT.test(previous) ? "あ" : previous;
    const key = `${cssFont(font)}\u0001${font.letterSpacing}\u0001${before}\u0001${last}`;
    const cached = results.get(key);
    if (cached !== undefined) return cached;
    let result = 0;
    const current = ensure();
    try {
      const scale = current ? current.ruler.getBoundingClientRect().width / 100 : 0;
      if (current && Number.isFinite(scale) && scale > 0) {
        const { doc, box } = current;
        box.style.font = cssFont(font);
        box.style.letterSpacing = `${font.letterSpacing}px`;
        box.style.width = "100000px";
        box.textContent = `ああ${before}${last}い`;
        const text = box.firstChild as Text;
        const range = doc.createRange();
        const select = (from: number, to: number) => {
          range.setStart(text, from);
          range.setEnd(text, to);
          return range;
        };
        const start = 2 + before.length;
        const end = start + last.length;
        const full = select(0, end).getBoundingClientRect().width;
        const charWidth = select(start, end).getBoundingClientRect().width;
        if (charWidth > 0) {
          // 詰めずには収まらない、少しだけ狭い幅
          box.style.width = `${(full - Math.min(1, charWidth / 4)) / scale}px`;
          const firstTop = (visibleRects(select(0, 1))[0] as DOMRect).top;
          const stays = visibleRects(select(start, end)).every((rect) => rect.top === firstTop);
          if (stays) {
            const shrink = (full - select(0, end).getBoundingClientRect().width) / scale;
            // 詰めるのは字の送り (字間を除く) の半分まで。それより縮んだように見えたら測り違いとして採らない
            const advance = charWidth / scale - font.letterSpacing;
            if (shrink > 0.01 * (charWidth / scale) && shrink <= advance * 0.55 + 0.05)
              result = shrink / (charWidth / scale);
          }
        }
      }
    } catch {
      return 0;
    } finally {
      if (current) current.box.textContent = "";
    }
    if (results.size >= FONT_TABLE_LIMIT) results.clear();
    results.set(key, result);
    return result;
  };
}

/** 覚えておく文字列の長さの上限 (UTF-16 の単位)。長い 1 行や、折り返す前の長い単語は覚えない。 */
export const MAX_CACHED_TEXT_LENGTH = 256;
/** 覚えておく文字列の合計の長さの上限。超えたら全部捨てる。 */
export const MAX_CACHED_TOTAL_LENGTH = 1_000_000;

/** フォントごとに、文字列から幅を引く表。キーの文字列の合計の長さで上限を持つ。 */
class WidthCache {
  private readonly byFont = new Map<string, Map<string, number>>();
  private total = 0;

  get(font: string, text: string): number | undefined {
    return this.byFont.get(font)?.get(text);
  }

  set(font: string, text: string, width: number): void {
    if (text.length > MAX_CACHED_TEXT_LENGTH) return;
    if (this.total + text.length + font.length > MAX_CACHED_TOTAL_LENGTH) this.clear();
    let table = this.byFont.get(font);
    if (!table) {
      table = new Map();
      this.byFont.set(font, table);
      this.total += font.length;
    }
    if (!table.has(text)) this.total += text.length;
    table.set(text, width);
  }

  clear(): void {
    this.byFont.clear();
    this.total = 0;
  }

  /** 覚えている文字列の合計の長さ (テスト用) */
  get size(): number {
    return this.total;
  }
}

/**
 * SVG のレイアウトの幅 (`getComputedTextLength`) がカーニングを含むかを確かめる文字列とフォント。
 * カーニングするフォントが 1 つ見つかればよい (macOS と Windows のどちらかに必ずある)。
 */
export const KERNING_PROBE = "AVAVAVAV WAWAWA ToToTo YoYoYo";
export const KERNING_PROBE_FAMILIES = [
  "Times New Roman",
  "Helvetica",
  "Arial",
  "Georgia",
  "serif",
  "sans-serif",
] as const;

/**
 * canvas と描画の幅が合うかを確かめる文字列。文字の種類ごとに複数持ち、どれか 1 つでも合わなければ、
 * そのフォントのその種類の文字を含む文字列は SVG で測る (代わりのフォントの選び方が canvas と描画で違う、など)。
 */
export const AGREEMENT_PROBES: Readonly<Record<typeof LATIN | typeof CJK, readonly string[]>> = {
  [LATIN]: [
    "Ta To AV WA Yo ff fi fl",
    "Hello, world! 0123456789 (a)[b]{c}",
    "“quotes” ‘s’ — – … ¥€£ äöüé",
  ],
  [CJK]: ["テキスト、「かな」。漢字", "(「かぎ」)【括弧】ー〜…", "ＡＢＣ１２３ｶﾀｶﾅ 한국어"],
};

/**
 * canvas と SVG の幅が合うとみなす差 (px)。Chromium の SVG の幅は 1/64 px に丸まるので、その分を見込む。
 * 代わりのフォントが違うときの差は 1 文字で 0.5 px を超える。
 */
export const AGREEMENT_TOLERANCE = 0.05;
const FONT_TABLE_LIMIT = 1_000;

export interface CanvasMeasurerOptions {
  getContext?: () => CanvasRenderingContext2D | null;
  measureWithSvg?: (text: string, font: FontSpec) => number | null;
  measureFontMetrics?: (font: FontSpec) => FontMetrics | null;
  detectLineBreaks?: () => LineBreakOptions;
  detectLineEndTrim?: (previous: string, last: string, font: FontSpec) => number;
}

/** 計測の経路を選ぶ規則 (テストと検証のために公開する)。 */
export interface MeasurePathInfo {
  /** SVG のレイアウトの幅が描画と同じ (カーニングを含む) か。null はまだ確かめていない */
  svgMatchesDrawing: boolean | null;
}

/**
 * ブラウザでの計測 (§4.7)。SVG の `<text>` が実際に描かれる幅 (字間を含む) と同じ値を返す。
 *
 * どのエンジンでも、まず canvas の `measureText` で測る (速い)。canvas は `<html lang>` を引き継ぐよう文書に
 * つなぎ、描画は `text-rendering="geometricPrecision"` で表示の倍率に関係なく組ませる (どちらも実測で必要)。
 *
 * エンジンの違いは名前で決めず、SVG のレイアウトの幅 (`getComputedTextLength`) がカーニングを含むかを最初に
 * 1 回だけ確かめて決める (`KERNING_PROBE`。カーニングした幅としない幅の、どちらに近いか)。
 *
 * - 含む (Chromium): canvas は絵文字の幅と、代わりのフォントの選び方が描画と違うことがあるので、絵文字と
 *   そのほかの文字 (`EMOJI` / `OTHER`) を含む文字列と、そのフォントで canvas と SVG の幅が `AGREEMENT_PROBES`
 *   のどれかで合わない種類 (`LATIN` / `CJK`) の文字を含む文字列は、SVG のレイアウトの幅 (Chromium では描画と
 *   同じ) で測る。字間は canvas の `letterSpacing` に任せる (合字を解くのも描画と同じ)
 * - 含まない (WebKit): SVG では測らない (canvas は描画と一致する)。ただし字間が 0 でないと、WebKit の SVG は
 *   1 文字ずつ並べて描く (カーニングを入れず、字間は符号位置ごとに付く) ので、書記素ごとの canvas の幅の和に
 *   符号位置の数 × 字間を足す。編集欄も字間のある間はカーニングを切る (`letterSpacingDropsKerning`)
 *
 * 結果はフォントと字間と文字列の組で覚える。長い文字列は覚えず、覚える量は文字列の合計の長さで抑える。
 * canvas が使えない環境 (jsdom) では、フォントサイズ × 0.6 を 1 文字の幅とみなし、書記素ごとに字間を足す。
 */
export function createCanvasTextMeasurer(
  options: CanvasMeasurerOptions = {},
): MetricsTextMeasurer & {
  /** 覚えている文字列の合計の長さ (テスト用) */
  readonly cachedLength: number;
  /** 経路の選び方の状態 (テストと検証用) */
  readonly pathInfo: MeasurePathInfo;
} {
  const getContext = options.getContext ?? createMeasureContext();
  const measureWithSvg = options.measureWithSvg ?? createSvgTextMeasure();
  const measureFontMetrics = options.measureFontMetrics ?? createDomFontMetrics();
  const detectLineBreaks = options.detectLineBreaks ?? createLineBreakProbe();
  const detectLineEndTrim = options.detectLineEndTrim ?? createLineEndTrimProbe();
  const widths = new WidthCache();
  const metrics = new Map<string, FontMetrics | null>();
  /** フォントごとに、確かめた文字の種類と、canvas と描画が合わない種類 (ビットの和) */
  const agreement = new Map<string, { checked: number; disagreeing: number }>();
  let svgMatchesDrawing: boolean | null = null;
  // 行分割は 1 つのノードで同じ FontSpec を何度も渡すので、font の文字列を組み立て直さない
  const fontStrings = new WeakMap<FontSpec, string>();
  const fontStringOf = (font: FontSpec) => {
    let value = fontStrings.get(font);
    if (value === undefined) {
      value = cssFont(font);
      fontStrings.set(font, value);
    }
    return value;
  };
  // `ctx.font` は読み返すと書き方が変わる (正規化される) ので、最後に設定した値を覚えて比べる
  let currentFont = "";
  let currentSpacing = 0;
  const applyFont = (ctx: CanvasRenderingContext2D, fontString: string, spacing: number) => {
    if (currentFont !== fontString) {
      ctx.font = fontString;
      currentFont = fontString;
    }
    if (currentSpacing !== spacing) {
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spacing}px`;
      currentSpacing = spacing;
    }
  };
  /** canvas で測る。`spacing` は canvas の `letterSpacing` を持つときだけ渡す。 */
  const canvasWidth = (text: string, fontString: string, spacing = 0): number | null => {
    const ctx = getContext();
    if (!ctx) return null;
    applyFont(ctx, fontString, spacing);
    return ctx.measureText(text).width;
  };
  const canvasHasSpacing = () => {
    const ctx = getContext();
    return ctx !== null && "letterSpacing" in ctx;
  };
  /** 字間なしの canvas の幅 (覚える)。 */
  const plainWidth = (text: string, fontString: string): number | null => {
    const cached = widths.get(fontString, text);
    if (cached !== undefined) return cached;
    const width = canvasWidth(text, fontString);
    if (width !== null) widths.set(fontString, text, width);
    return width;
  };

  /**
   * SVG のレイアウトの幅が描画と同じか (カーニングを含むか)。最初に 1 回だけ確かめる。canvas か SVG で
   * 測れなかったときは覚えず (今回は含まないとみなす)、次に確かめ直す。
   */
  const svgIsDrawing = (): boolean => {
    if (svgMatchesDrawing !== null) return svgMatchesDrawing;
    for (const family of KERNING_PROBE_FAMILIES) {
      const font: FontSpec = { family, size: 32, weight: 400, italic: false, letterSpacing: 0 };
      const fontString = cssFont(font);
      const kerned = canvasWidth(KERNING_PROBE, fontString);
      if (kerned === null) return false;
      let separate = 0;
      for (const char of KERNING_PROBE) separate += canvasWidth(char, fontString) ?? 0;
      if (separate - kerned < 1) continue; // このフォントはカーニングしない
      const viaSvg = measureWithSvg(KERNING_PROBE, font);
      if (viaSvg === null) return false;
      // 許容差ではなく、カーニングした幅としない幅のどちらに近いかで決める (描画の丸めの違いに左右されない)
      svgMatchesDrawing = Math.abs(viaSvg - kerned) < Math.abs(viaSvg - separate);
      return svgMatchesDrawing;
    }
    // カーニングするフォントがない: 決められないので canvas だけで測る
    svgMatchesDrawing = false;
    return svgMatchesDrawing;
  };

  /** そのフォントで、canvas と描画が合わない文字の種類。種類ごとに最初に使うときに比べる (字間なし)。 */
  const disagreeingClasses = (font: FontSpec, fontString: string, classes: number): number => {
    let entry = agreement.get(fontString);
    if (!entry) {
      if (agreement.size >= FONT_TABLE_LIMIT) agreement.clear();
      entry = { checked: 0, disagreeing: 0 };
      agreement.set(fontString, entry);
    }
    const plain = font.letterSpacing === 0 ? font : { ...font, letterSpacing: 0 };
    for (const cls of [LATIN, CJK] as const) {
      if ((classes & cls) === 0 || (entry.checked & cls) !== 0) continue;
      // 測れなかったら覚えず (今回は合うとみなす)、次に確かめ直す
      let measured = true;
      for (const probe of AGREEMENT_PROBES[cls]) {
        const viaSvg = measureWithSvg(probe, plain);
        const viaCanvas = canvasWidth(probe, fontString);
        if (viaSvg === null || viaCanvas === null) {
          measured = false;
          break;
        }
        if (Math.abs(viaSvg - viaCanvas) > AGREEMENT_TOLERANCE) {
          entry.disagreeing |= cls;
          break;
        }
      }
      if (measured) entry.checked |= cls;
    }
    return entry.disagreeing;
  };

  /** 描画と同じ幅を得るために SVG で測るか (Chromium 型だけ)。 */
  const needsSvg = (text: string, font: FontSpec, fontString: string): boolean => {
    const classes = scriptClasses(text);
    if ((classes & (EMOJI | OTHER)) !== 0) return true;
    return (disagreeingClasses(font, fontString, classes) & classes) !== 0;
  };

  /** 描画の幅 (字間を含む)。測れなければ null。 */
  const drawnWidth = (text: string, font: FontSpec, fontString: string): number | null => {
    const spacing = font.letterSpacing;
    if (svgIsDrawing()) {
      if (needsSvg(text, font, fontString)) {
        const viaSvg = measureWithSvg(text, font);
        if (viaSvg !== null) return viaSvg;
      }
      if (spacing === 0) return plainWidth(text, fontString);
      if (canvasHasSpacing()) return canvasWidth(text, fontString, spacing);
      const plain = plainWidth(text, fontString);
      return plain === null ? null : plain + graphemeCount(text) * spacing;
    }
    if (spacing === 0) return plainWidth(text, fontString);
    // WebKit 型: 字間は符号位置ごとに付く。複雑な組版の経路の文字を含めば全体をカーニングして組み、
    // 含まなければ 1 文字ずつ並べる (カーニングなし)
    const sum = usesComplexTextPath(text)
      ? plainWidth(text, fontString)
      : graphemeSum(text, fontString);
    return sum === null ? null : sum + codePointLength(text) * spacing;
  };

  /** 書記素クラスタごとの、字間なしの canvas の幅の和 (カーニングを入れない幅)。 */
  const graphemeSum = (text: string, fontString: string): number | null => {
    let sum: number | null = 0;
    forEachGrapheme(text, (grapheme) => {
      const width = sum === null ? null : plainWidth(grapheme, fontString);
      sum = width === null || sum === null ? null : sum + width;
    });
    return sum;
  };

  const measure = (text: string, font: FontSpec): number => {
    if (text === "") return 0;
    const fontString = fontStringOf(font);
    const spacing = font.letterSpacing;
    const key = spacing === 0 ? fontString : `${fontString}\u0001${spacing}`;
    const cached = widths.get(key, text);
    if (cached !== undefined) return cached;
    const width =
      drawnWidth(text, font, fontString) ??
      graphemeCount(text) * font.size * 0.6 + letterSpacingWidth(text, spacing);
    widths.set(key, text, width);
    return width;
  };

  return {
    measure,

    editorWidth(text: string, font: FontSpec): number {
      if (text === "" || svgIsDrawing()) return measure(text, font);
      // WebKit 型。字間があると編集欄はカーニングを切る (`letterSpacingDropsKerning`)。字間は書記素ごと
      if (font.letterSpacing !== 0) {
        const sum = graphemeSum(text, fontStringOf(font));
        if (sum !== null) return sum + graphemeCount(text) * font.letterSpacing;
        return measure(text, font);
      }
      // HTML は組む単位ごとに組み、単位をまたぐカーニングを入れない
      const lineBreaks = detectLineBreaks();
      if (!lineBreaks.shapePerUnit) return measure(text, font);
      let width = 0;
      for (const unit of shapingUnits(text, lineBreaks)) width += measure(unit, font);
      return width;
    },

    lineEndTrim(previous: string, last: string, font: FontSpec): number {
      return detectLineEndTrim(previous, last, font);
    },

    fontMetrics(font: FontSpec): FontMetrics | null {
      const fontString = fontStringOf(font);
      if (metrics.has(fontString)) return metrics.get(fontString) ?? null;
      // 編集欄と同じ HTML の行の箱から求める。測れなければ canvas の fontBoundingBox
      let result = measureFontMetrics(font);
      const ctx = result ? null : getContext();
      if (ctx) {
        applyFont(ctx, fontString, currentSpacing);
        const measured = ctx.measureText("x");
        const ascent = measured.fontBoundingBoxAscent;
        const descent = measured.fontBoundingBoxDescent;
        // 古い WebView は値を持たない (undefined)。そのときは既定の比率に任せる
        if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0)
          result = { ascent, descent };
      }
      if (metrics.size >= FONT_TABLE_LIMIT) metrics.clear();
      metrics.set(fontString, result);
      return result;
    },

    lineBreakOptions(): LineBreakOptions {
      return detectLineBreaks();
    },

    letterSpacingDropsKerning(): boolean {
      return !svgIsDrawing();
    },

    get cachedLength() {
      return widths.size;
    },

    get pathInfo() {
      return { svgMatchesDrawing };
    },
  };
}

/** キャンバスが使う計測。 */
export const canvasTextMeasurer: MetricsTextMeasurer = createCanvasTextMeasurer();
