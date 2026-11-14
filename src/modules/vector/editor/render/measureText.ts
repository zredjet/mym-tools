/**
 * 文字幅の計測 (`TextMeasurer`) のブラウザ用の実装。canvas の `measureText` を使う。
 * 「テキスト」のセッションが差し替えられるよう、この小さなファイルに閉じる。
 * キャンバスは `canvasTextMeasurer` を使う。
 */
import { cssFont } from "./buildNodeSvg";
import type { FontSpec, TextMeasurer } from "./types";

/** 字間は 1 文字 (コードポイント) ごとに足す (CSS / SVG の `letter-spacing` と同じく最後の文字の後にも付く)。 */
export function letterSpacingWidth(text: string, letterSpacing: number): number {
  if (letterSpacing === 0 || text === "") return 0;
  return codePointLength(text) * letterSpacing;
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

const CACHE_LIMIT = 10_000;

/**
 * canvas の `measureText` で測る。結果はフォントと文字列の組で覚えておく (上限を超えたら捨てる)。
 * canvas が使えない環境 (jsdom) では、フォントサイズ × 0.6 を 1 文字の幅とみなす。
 */
export function createCanvasTextMeasurer(): TextMeasurer {
  let context: CanvasRenderingContext2D | null | undefined;
  const cache = new Map<string, number>();

  const getContext = () => {
    if (context === undefined) {
      try {
        context =
          typeof document === "undefined" || /jsdom/i.test(navigator.userAgent)
            ? null
            : document.createElement("canvas").getContext("2d");
      } catch {
        context = null;
      }
    }
    return context;
  };

  return {
    measure(text: string, font: FontSpec): number {
      const fontString = cssFont(font);
      const key = `${fontString}\u0000${text}`;
      const cached = cache.get(key);
      const spacing = letterSpacingWidth(text, font.letterSpacing);
      if (cached !== undefined) return cached + spacing;
      const ctx = getContext();
      let width: number;
      if (ctx) {
        ctx.font = fontString;
        width = ctx.measureText(text).width;
      } else {
        width = codePointLength(text) * font.size * 0.6;
      }
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(key, width);
      return width + spacing;
    },
  };
}

/** キャンバスが使う計測。 */
export const canvasTextMeasurer: TextMeasurer = createCanvasTextMeasurer();
