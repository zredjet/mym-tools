/**
 * 文字幅の計測 (`TextMeasurer`) のブラウザ用の実装。canvas の `measureText` を使う (§4.7)。
 * キャンバス・書き出し・行分割は `canvasTextMeasurer` を使う。
 *
 * - フォントは描画と同じ `font-family` (`cssFont` / `cssFontFamily`) で指定する
 * - 絵文字を含む文字列は、canvas と描画 (SVG / HTML) で幅が違う (Chromium の canvas は 16px の絵文字を
 *   20px と測るが、描画は 16px) ので、見えない SVG の `<text>` の `getComputedTextLength` で測る
 * - 字間は足し算で扱う (Safari 15 の canvas は `letterSpacing` を持たない)。CSS / SVG の
 *   `letter-spacing` と同じく、書記素クラスタごとに付け、最後の文字の後にも付く
 * - ベースラインの位置を決めるため、フォントのアセント・ディセントも返す (`fontMetrics`)。
 *   CSS の行の箱と同じ値 (`fontBoundingBoxAscent` / `Descent`) なので、編集欄の文字と描画の文字の
 *   上下の位置がそろう。契約 (`TextMeasurer`) にない追加の口 (`text/metrics.ts`) で、持たない計測では
 *   既定の比率を使う
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

/** canvas の 2D コンテキストを 1 つだけ作る。jsdom など canvas が使えない環境では null。 */
export function createMeasureContext(): () => CanvasRenderingContext2D | null {
  let context: CanvasRenderingContext2D | null | undefined;
  return () => {
    if (context === undefined) {
      try {
        context =
          typeof document === "undefined" ||
          typeof navigator === "undefined" ||
          /jsdom/i.test(navigator.userAgent)
            ? null
            : document.createElement("canvas").getContext("2d");
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

/**
 * 見えない SVG の `<text>` で幅を測る (描画と同じ組版)。jsdom など測れない環境では null を返す。
 * 要素は最初に使うときに body に置き、外されていたら置き直す。
 */
export function createSvgTextMeasure(): (text: string, font: FontSpec) => number | null {
  let element: SVGTextElement | null | undefined;
  const ensure = (): SVGTextElement | null => {
    if (element === undefined) {
      try {
        if (
          typeof document === "undefined" ||
          typeof navigator === "undefined" ||
          /jsdom/i.test(navigator.userAgent)
        )
          element = null;
        else {
          const ns = "http://www.w3.org/2000/svg";
          const svg = document.createElementNS(ns, "svg");
          svg.setAttribute("aria-hidden", "true");
          svg.setAttribute("data-canvas-text-measure", "");
          svg.style.cssText =
            "position:absolute;left:-10000px;top:-10000px;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
          const text = document.createElementNS(ns, "text");
          text.setAttribute("xml:space", "preserve");
          svg.appendChild(text);
          element = typeof text.getComputedTextLength === "function" ? text : null;
        }
      } catch {
        element = null;
      }
    }
    if (element && !element.isConnected && element.ownerSVGElement)
      document.body.appendChild(element.ownerSVGElement);
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

const CACHE_LIMIT = 20_000;

/**
 * canvas の `measureText` で測る (絵文字を含む文字列は SVG で測る)。結果はフォントと文字列の組で覚えておく
 * (上限を超えたら捨てる)。canvas が使えない環境 (jsdom) では、フォントサイズ × 0.6 を 1 文字の幅とみなす。
 */
export function createCanvasTextMeasurer(
  getContext: () => CanvasRenderingContext2D | null = createMeasureContext(),
  measureWithSvg: (text: string, font: FontSpec) => number | null = createSvgTextMeasure(),
): MetricsTextMeasurer {
  const widths = new Map<string, number>();
  const metrics = new Map<string, FontMetrics | null>();
  // `ctx.font` は読み返すと書き方が変わる (正規化される) ので、最後に設定した文字列を覚えて比べる
  let currentFont = "";
  const applyFont = (ctx: CanvasRenderingContext2D, fontString: string) => {
    if (currentFont === fontString) return;
    ctx.font = fontString;
    currentFont = fontString;
  };

  return {
    measure(text: string, font: FontSpec): number {
      const spacing = letterSpacingWidth(text, font.letterSpacing);
      if (text === "") return 0;
      const fontString = cssFont(font);
      const key = `${fontString}\u0000${text}`;
      const cached = widths.get(key);
      if (cached !== undefined) return cached + spacing;
      let width = mayContainEmoji(text) ? measureWithSvg(text, font) : null;
      if (width === null) {
        const ctx = getContext();
        if (ctx) {
          applyFont(ctx, fontString);
          width = ctx.measureText(text).width;
        } else {
          width = graphemeCount(text) * font.size * 0.6;
        }
      }
      if (widths.size >= CACHE_LIMIT) widths.clear();
      widths.set(key, width);
      return width + spacing;
    },

    fontMetrics(font: FontSpec): FontMetrics | null {
      const fontString = cssFont(font);
      if (metrics.has(fontString)) return metrics.get(fontString) ?? null;
      const ctx = getContext();
      let result: FontMetrics | null = null;
      if (ctx) {
        applyFont(ctx, fontString);
        const measured = ctx.measureText("x");
        const ascent = measured.fontBoundingBoxAscent;
        const descent = measured.fontBoundingBoxDescent;
        // 古い WebView は値を持たない (undefined)。そのときは既定の比率に任せる
        if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0)
          result = { ascent, descent };
      }
      if (metrics.size >= CACHE_LIMIT) metrics.clear();
      metrics.set(fontString, result);
      return result;
    },
  };
}

/** キャンバスが使う計測。 */
export const canvasTextMeasurer: MetricsTextMeasurer = createCanvasTextMeasurer();
