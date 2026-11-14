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
import { graphemeCount } from "../text/graphemes";
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
 * `textRendering` があれば `geometricPrecision` にする (Chromium の canvas は既定で字幅を丸め、
 * SVG の描画より広く測る。Safari 15 は持たない)。
 */
export function createMeasureContext(
  getDocument: () => Document | null = defaultMeasureDocument,
): () => CanvasRenderingContext2D | null {
  let context: CanvasRenderingContext2D | null | undefined;
  return () => {
    if (context === undefined) {
      try {
        const doc = getDocument();
        context = doc ? doc.createElement("canvas").getContext("2d") : null;
        const styles = context as (CanvasRenderingContext2D & { textRendering?: string }) | null;
        if (styles && "textRendering" in styles) styles.textRendering = "geometricPrecision";
      } catch {
        context = null;
      }
    }
    return context;
  };
}

/**
 * 絵文字として描かれうる文字を含むか。canvas の幅が描画と違うので、SVG で測る。
 * 記号 (U+2300〜U+23FF、U+25A0〜U+27BF、U+2B00〜U+2BFF)、U+1F000 以降、異体字セレクタ 16 (U+FE0F)、
 * ZWJ (U+200D)、囲みのキーキャップ (U+20E3)、タグ文字を見る。
 */
export function mayContainEmoji(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x200d) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      // U+10000 以降。U+1F000 以降 (絵文字、地域指示記号) と U+E0000 台 (タグ) は上位サロゲートで分かる
      if (code === 0xd83c || code === 0xd83d || code === 0xd83e || code === 0xdb40) return true;
      i++;
      continue;
    }
    if (
      code === 0x200d ||
      code === 0x20e3 ||
      code === 0xfe0f ||
      (code >= 0x2300 && code <= 0x23ff) ||
      (code >= 0x25a0 && code <= 0x27bf) ||
      (code >= 0x2b00 && code <= 0x2bff)
    )
      return true;
  }
  return false;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** 計測用の要素を置く (画面の外、見えない、ポインターを受けない)。 */
const HIDDEN_STYLE =
  "position:absolute;left:-10000px;top:-10000px;visibility:hidden;pointer-events:none;contain:layout style";

/**
 * 見えない SVG の `<text>` で幅を測る (描画と同じ組版)。測れない環境では null を返す。
 * 空白は描画 (`xml:space="preserve"`) と同じく保つ。属性は XML の名前空間に置かないと効かないので
 * `setAttributeNS` を使い、CSS の `white-space: pre` も付ける。
 * 要素は最初に使うときに body に置き、外されていたら置き直す。
 */
export function createSvgTextMeasure(
  getDocument: () => Document | null = defaultMeasureDocument,
): (text: string, font: FontSpec) => number | null {
  let element: SVGTextElement | null | undefined;
  const ensure = (): SVGTextElement | null => {
    if (element === undefined) {
      try {
        const doc = getDocument();
        if (!doc) element = null;
        else {
          const svg = doc.createElementNS(SVG_NS, "svg");
          svg.setAttribute("aria-hidden", "true");
          svg.setAttribute("data-canvas-text-measure", "");
          svg.setAttribute("style", `${HIDDEN_STYLE};width:0;height:0;overflow:hidden`);
          const text = doc.createElementNS(SVG_NS, "text") as SVGTextElement;
          text.setAttributeNS(XML_NS, "xml:space", "preserve");
          text.setAttribute("style", "white-space:pre");
          svg.appendChild(text);
          element = typeof text.getComputedTextLength === "function" ? text : null;
        }
      } catch {
        element = null;
      }
    }
    const svg = element?.ownerSVGElement ?? element?.parentNode;
    if (element && !element.isConnected && svg) element.ownerDocument.body.appendChild(svg);
    return element;
  };
  return (text, font) => {
    const target = ensure();
    if (!target) return null;
    target.setAttribute("font-family", cssFontFamily(font.family));
    target.setAttribute("font-size", String(font.size));
    target.setAttribute("font-weight", String(font.weight));
    target.setAttribute("font-style", font.italic ? "italic" : "normal");
    target.textContent = text;
    const width = target.getComputedTextLength();
    return Number.isFinite(width) ? width : null;
  };
}

/**
 * フォントのアセントとディセントを、HTML の行の箱から求める (編集欄の `<textarea>` と同じ組版)。
 * インラインの要素の内容の箱 (アセント + ディセント) と、高さ 0 のインラインブロックで示したベースラインを測る。
 * 測れない環境では null。
 */
export function createDomFontMetrics(
  getDocument: () => Document | null = defaultMeasureDocument,
): (font: FontSpec) => FontMetrics | null {
  let parts: { box: HTMLElement; text: HTMLElement; marker: HTMLElement } | null | undefined;
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
          box.append(text, marker);
          parts = { box, text, marker };
        }
      } catch {
        parts = null;
      }
    }
    if (parts && !parts.box.isConnected) parts.box.ownerDocument.body.appendChild(parts.box);
    return parts;
  };
  return (font) => {
    const current = ensure();
    if (!current) return null;
    current.box.style.font = cssFont(font);
    current.box.style.lineHeight = "normal";
    const content = current.text.getBoundingClientRect();
    const baseline = current.marker.getBoundingClientRect().top;
    const ascent = baseline - content.top;
    const descent = content.bottom - baseline;
    if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent + descent <= 0) return null;
    return { ascent, descent };
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

/** canvas と SVG の幅が合うかを確かめる文字列 (カーニングの組、かな、句読点、数字、system-ui の欧文)。 */
const AGREEMENT_PROBES = [
  "Ta To AV WA Yo ff fi",
  "テキスト、「かな」。漢字",
  "Hello, world! 0123456789",
];
/** canvas と SVG の幅の差がこれ以下なら一致とみなす (px)。 */
const AGREEMENT_EPSILON = 0.01;
const FONT_TABLE_LIMIT = 1_000;

export interface CanvasMeasurerOptions {
  getContext?: () => CanvasRenderingContext2D | null;
  measureWithSvg?: (text: string, font: FontSpec) => number | null;
  measureFontMetrics?: (font: FontSpec) => FontMetrics | null;
}

/**
 * ブラウザでの計測 (§4.7)。SVG の描画と同じ幅を返す。
 *
 * - 速さのため canvas の `measureText` を使う。ただし、フォントごとに最初に canvas と SVG で決まった文字列を
 *   測り比べ、違えば (Chromium の `system-ui` など) そのフォントは SVG で測る
 * - 絵文字を含む文字列はいつも SVG で測る (canvas は絵文字の幅が描画と違う)
 * - 結果はフォントと文字列の組で覚える。長い文字列は覚えず、覚える量は文字列の合計の長さで抑える
 * - canvas が使えない環境 (jsdom) では、フォントサイズ × 0.6 を 1 文字の幅とみなす
 */
export function createCanvasTextMeasurer(
  options: CanvasMeasurerOptions = {},
): MetricsTextMeasurer & {
  /** 覚えている文字列の合計の長さ (テスト用) */
  readonly cachedLength: number;
} {
  const getContext = options.getContext ?? createMeasureContext();
  const measureWithSvg = options.measureWithSvg ?? createSvgTextMeasure();
  const measureFontMetrics = options.measureFontMetrics ?? createDomFontMetrics();
  const widths = new WidthCache();
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
  const metrics = new Map<string, FontMetrics | null>();
  /** フォントごとに、SVG で測るか */
  const svgFonts = new Map<string, boolean>();
  // `ctx.font` は読み返すと書き方が変わる (正規化される) ので、最後に設定した文字列を覚えて比べる
  let currentFont = "";
  const applyFont = (ctx: CanvasRenderingContext2D, fontString: string) => {
    if (currentFont === fontString) return;
    ctx.font = fontString;
    currentFont = fontString;
  };
  const canvasWidth = (text: string, fontString: string): number | null => {
    const ctx = getContext();
    if (!ctx) return null;
    applyFont(ctx, fontString);
    return ctx.measureText(text).width;
  };
  const prefersSvg = (font: FontSpec, fontString: string): boolean => {
    let result = svgFonts.get(fontString);
    if (result === undefined) {
      result = false;
      for (const probe of AGREEMENT_PROBES) {
        const viaSvg = measureWithSvg(probe, font);
        if (viaSvg === null) break; // SVG で測れなければ canvas を使う
        const viaCanvas = canvasWidth(probe, fontString);
        if (viaCanvas === null || Math.abs(viaCanvas - viaSvg) > AGREEMENT_EPSILON) {
          result = true;
          break;
        }
      }
      if (svgFonts.size >= FONT_TABLE_LIMIT) svgFonts.clear();
      svgFonts.set(fontString, result);
    }
    return result;
  };

  return {
    measure(text: string, font: FontSpec): number {
      const spacing = letterSpacingWidth(text, font.letterSpacing);
      if (text === "") return 0;
      const fontString = fontStringOf(font);
      const cached = widths.get(fontString, text);
      if (cached !== undefined) return cached + spacing;
      let width =
        mayContainEmoji(text) || prefersSvg(font, fontString) ? measureWithSvg(text, font) : null;
      width ??= canvasWidth(text, fontString);
      width ??= graphemeCount(text) * font.size * 0.6;
      widths.set(fontString, text, width);
      return width + spacing;
    },

    fontMetrics(font: FontSpec): FontMetrics | null {
      const fontString = fontStringOf(font);
      if (metrics.has(fontString)) return metrics.get(fontString) ?? null;
      // 編集欄と同じ HTML の行の箱から求める。測れなければ canvas の fontBoundingBox
      let result = measureFontMetrics(font);
      const ctx = result ? null : getContext();
      if (ctx) {
        applyFont(ctx, fontString);
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

    get cachedLength() {
      return widths.size;
    },
  };
}

/** キャンバスが使う計測。 */
export const canvasTextMeasurer: MetricsTextMeasurer = createCanvasTextMeasurer();
