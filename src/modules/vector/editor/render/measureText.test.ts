import { afterEach, describe, expect, it, vi } from "vitest";
import { fontMetricsOf, lineBreakOptionsOf } from "../text/metrics";
import {
  AGREEMENT_PROBES,
  AGREEMENT_TOLERANCE,
  canvasTextMeasurer,
  CJK,
  createCanvasTextMeasurer,
  createDomFontMetrics,
  createLineBreakProbe,
  createMeasureContext,
  createSvgTextMeasure,
  EMOJI,
  KERNING_PROBE,
  LATIN,
  letterSpacingWidth,
  MAX_CACHED_TEXT_LENGTH,
  MAX_CACHED_TOTAL_LENGTH,
  mayContainEmoji,
  OTHER,
  scriptClasses,
} from "./measureText";
import type { FontSpec } from "./types";

const font: FontSpec = {
  family: "Hiragino Sans",
  size: 16,
  weight: 400,
  italic: false,
  letterSpacing: 0,
};

const KERNED_PAIRS = ["AV", "VA", "WA", "To", "Yo"];

/** カーニングを含む幅 (1 文字 10、カーニングの組ごとに 2 狭い)。canvas の代わり。 */
function kernedWidth(text: string): number {
  let width = Array.from(text).length * 10;
  for (let i = 0; i + 1 < text.length; i++)
    if (KERNED_PAIRS.includes(text.slice(i, i + 2))) width -= 2;
  return width;
}

/** canvas の 2D コンテキストの代わり。設定したフォントを覚える。 */
function fakeContext(
  measure: (text: string) => number = kernedWidth,
  extra: Partial<TextMetrics> = {},
) {
  const fonts: string[] = [];
  const ctx = {
    set font(value: string) {
      fonts.push(value);
    },
    measureText: vi.fn((text: string) => ({ width: measure(text), ...extra })),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fonts };
}

/** Chromium の SVG の代わり: 描画と同じ幅 (カーニングを含む)。 */
const chromiumSvg = () => vi.fn((text: string) => kernedWidth(text));
/** WebKit の SVG の代わり: カーニングを含まない幅。 */
const webkitSvg = () => vi.fn((text: string) => Array.from(text).length * 10);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  for (const element of document.querySelectorAll("[data-canvas-text-measure]")) element.remove();
});

describe("letterSpacingWidth", () => {
  it("書記素クラスタごとに字間を足す (最後の文字の後にも付く)", () => {
    expect(letterSpacingWidth("abc", 2)).toBe(6);
    expect(letterSpacingWidth("👨\u200d👩\u200d👧か\u3099", 2)).toBe(4);
    expect(letterSpacingWidth("abc", 0)).toBe(0);
    expect(letterSpacingWidth("", 3)).toBe(0);
  });
});

describe("scriptClasses", () => {
  it("欧文・和文・絵文字・そのほかを見分ける", () => {
    expect(scriptClasses("Hello, world — …")).toBe(LATIN);
    expect(scriptClasses("テキスト、漢字。ＡＢＣ한국")).toBe(CJK);
    expect(scriptClasses("𠮷")).toBe(CJK);
    expect(scriptClasses("abc日本")).toBe(LATIN | CJK);
    expect(scriptClasses("👍🏽")).toBe(EMOJI);
    expect(scriptClasses("1\ufe0f\u20e3")).toBe(LATIN | EMOJI);
    expect(scriptClasses("●★")).toBe(EMOJI);
    expect(scriptClasses("Ελληνικά")).toBe(OTHER);
    expect(mayContainEmoji("abc 日本語")).toBe(false);
    expect(mayContainEmoji("🇯🇵")).toBe(true);
  });
});

describe("createCanvasTextMeasurer: 経路の選び方", () => {
  it("SVG のレイアウトの幅がカーニングを含まない (WebKit) なら、絵文字も含めてすべて canvas で測る", () => {
    const { ctx } = fakeContext();
    const svg = webkitSvg();
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    expect(measurer.measure("AVAV", font)).toBe(34);
    expect(measurer.measure("👍", font)).toBe(10);
    expect(measurer.measure("テキスト", font)).toBe(40);
    expect(measurer.measure("Ελληνικά", font)).toBe(80);
    expect(measurer.pathInfo.svgMatchesDrawing).toBe(false);
    // SVG は、カーニングを含むかを確かめる 1 回だけ
    expect(svg.mock.calls.map(([text]) => text)).toEqual([KERNING_PROBE]);
  });

  it("SVG のレイアウトの幅が描画と同じ (Chromium) なら、絵文字とそのほかの文字だけ SVG で測る", () => {
    const { ctx } = fakeContext();
    const svg = vi.fn((text: string) => (text === "👍" ? 16 : kernedWidth(text)));
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    expect(measurer.measure("👍", font)).toBe(16);
    expect(measurer.measure("Ελληνικά", font)).toBe(80);
    expect(measurer.pathInfo.svgMatchesDrawing).toBe(true);
    const before = svg.mock.calls.length;
    // 欧文と和文は、そのフォントで canvas と描画が合うので canvas で測る
    expect(measurer.measure("Hello AV", font)).toBe(78);
    expect(measurer.measure("テキスト", font)).toBe(40);
    const measured = svg.mock.calls.slice(before).map(([text]) => text);
    expect(measured).not.toContain("Hello AV");
    expect(measured).not.toContain("テキスト");
  });

  it("フォントと文字の種類の組ごとに、比べる文字列のどれか 1 つでも合わなければ、その種類を含む文字列を SVG で測る", () => {
    for (const cls of [LATIN, CJK] as const) {
      const probes = AGREEMENT_PROBES[cls];
      const lastProbe = probes[probes.length - 1] as string;
      expect(probes.length).toBeGreaterThan(1);
      const { ctx } = fakeContext();
      // 最後の比べる文字列だけ、描画が canvas より 1 狭い (代わりのフォントの違いなど)
      const svg = vi.fn((text: string) => kernedWidth(text) - (text === lastProbe ? 1 : 0));
      const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
      const latin = "Latin text";
      const cjk = "和文のテキスト";
      measurer.measure(latin, font);
      measurer.measure(cjk, font);
      const viaSvg = svg.mock.calls.map(([text]) => text);
      if (cls === LATIN) {
        expect(viaSvg).toContain(latin);
        expect(viaSvg).not.toContain(cjk);
      } else {
        expect(viaSvg).toContain(cjk);
        expect(viaSvg).not.toContain(latin);
      }
      // 別のフォントは別に確かめる (Times New Roman などのカーニングの確かめとは別)
      measurer.measure(latin, { ...font, family: "Other" });
    }
  });

  it("SVG の幅の 1/64 px の丸めの差は、合っているとみなす", () => {
    const { ctx } = fakeContext();
    const svg = vi.fn((text: string) => kernedWidth(text) + AGREEMENT_TOLERANCE / 2);
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    expect(measurer.measure("テキスト and text", font)).toBe(kernedWidth("テキスト and text"));
  });

  it("どのフォントもカーニングしなければ判定できないので、canvas だけで測る", () => {
    const { ctx } = fakeContext((text) => Array.from(text).length * 10);
    const svg = chromiumSvg();
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    expect(measurer.measure("👍", font)).toBe(10);
    expect(measurer.pathInfo.svgMatchesDrawing).toBe(false);
    expect(svg).not.toHaveBeenCalled();
  });

  it("SVG で測れなければ canvas、canvas もなければフォントサイズ × 0.6 を 1 文字の幅とみなす", () => {
    const { ctx } = fakeContext();
    const viaCanvas = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: () => null,
    });
    expect(viaCanvas.measure("👍", font)).toBe(10);
    const none = createCanvasTextMeasurer({ getContext: () => null, measureWithSvg: () => null });
    expect(none.measure("a👍🏽", font)).toBeCloseTo(19.2);
  });

  it("描画と同じ font で測り、字間を足し、結果を覚える", () => {
    const { ctx, fonts } = fakeContext();
    const measurer = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: webkitSvg(),
    });
    const bold = { ...font, weight: 700, italic: true };
    expect(measurer.measure("ab", { ...bold, letterSpacing: 1.5 })).toBe(23);
    expect(fonts).toContain('italic 700 16px "Hiragino Sans", sans-serif');
    const calls = vi.mocked(ctx.measureText).mock.calls.length;
    expect(measurer.measure("ab", bold)).toBe(20);
    expect(vi.mocked(ctx.measureText).mock.calls.length).toBe(calls);
    expect(measurer.measure("", font)).toBe(0);
  });
});

describe("createCanvasTextMeasurer: 覚える量とアセント・ディセント", () => {
  it("長い文字列は覚えず、覚える量は文字列の合計の長さで抑える", () => {
    const { ctx } = fakeContext();
    const measurer = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: webkitSvg(),
    });
    const long = "a".repeat(MAX_CACHED_TEXT_LENGTH + 1);
    measurer.measure("x", font);
    const before = measurer.cachedLength;
    measurer.measure(long, font);
    measurer.measure(long, font);
    expect(measurer.cachedLength).toBe(before);
    expect(vi.mocked(ctx.measureText).mock.calls.filter(([text]) => text === long)).toHaveLength(2);
    const piece = "b".repeat(MAX_CACHED_TEXT_LENGTH - 6);
    const count = Math.ceil((MAX_CACHED_TOTAL_LENGTH * 1.5) / piece.length);
    for (let i = 0; i < count; i++) measurer.measure(`${i}`.padStart(6, "0") + piece, font);
    expect(measurer.cachedLength).toBeLessThanOrEqual(MAX_CACHED_TOTAL_LENGTH);
    expect(measurer.cachedLength).toBeGreaterThan(0);
  });

  it("アセントとディセントは編集欄と同じ HTML の行の箱から求め、だめなら canvas の fontBoundingBox", () => {
    const withBoundingBox = () =>
      fakeContext(kernedWidth, { fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 3 }).ctx;
    const fromDom = createCanvasTextMeasurer({
      getContext: withBoundingBox,
      measureWithSvg: webkitSvg(),
      measureFontMetrics: () => ({ ascent: 15, descent: 4 }),
    });
    expect(fontMetricsOf(fromDom, font)).toEqual({ ascent: 15, descent: 4 });
    const fromCanvas = createCanvasTextMeasurer({
      getContext: withBoundingBox,
      measureWithSvg: webkitSvg(),
      measureFontMetrics: () => null,
    });
    expect(fontMetricsOf(fromCanvas, font)).toEqual({ ascent: 14, descent: 3 });
    const without = createCanvasTextMeasurer({
      getContext: () => fakeContext().ctx,
      measureWithSvg: webkitSvg(),
      measureFontMetrics: () => null,
    });
    expect(fontMetricsOf(without, font)).toBeNull();
    expect(fontMetricsOf({ measure: () => 1 }, font)).toBeNull();
  });

  it("折り返しの規則はエンジンから求めたものを返す", () => {
    const measurer = createCanvasTextMeasurer({
      getContext: () => null,
      detectLineBreaks: () => ({ breakAfterSolidus: true }),
    });
    expect(lineBreakOptionsOf(measurer)).toEqual({ breakAfterSolidus: true });
    expect(lineBreakOptionsOf({ measure: () => 1 })).toEqual({});
  });

  it("jsdom では canvas と SVG を使わずに測り、計測用の要素を置かない", () => {
    expect(canvasTextMeasurer.measure("abc", font)).toBeCloseTo(28.8);
    expect(canvasTextMeasurer.measure("👍", font)).toBeCloseTo(9.6);
    expect(fontMetricsOf(canvasTextMeasurer, font)).toBeNull();
    expect(lineBreakOptionsOf(canvasTextMeasurer)).toEqual({});
    expect(document.querySelector("[data-canvas-text-measure]")).toBeNull();
  });
});

describe("createSvgTextMeasure (DOM のコード)", () => {
  it("見えない SVG の text を html の直下に置き、空白を保つ設定と描画と同じフォントで測り、測り終えたら空にする", () => {
    const seen: string[] = [];
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value(this: SVGElement) {
        seen.push(this.textContent ?? "");
        return (this.textContent ?? "").length * 8;
      },
    });
    try {
      const measure = createSvgTextMeasure(() => document);
      expect(measure("😀   😀", { ...font, weight: 700, italic: true })).toBe(7 * 8);
      const svg = document.querySelector("svg[data-canvas-text-measure]");
      expect(svg?.parentElement).toBe(document.documentElement);
      const text = svg?.querySelector("text");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("style")).toContain("visibility:hidden");
      // xml:space は XML の名前空間に置く (名前空間なしの属性は効かない)
      expect(text?.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space")).toBe(
        "preserve",
      );
      expect(text?.getAttribute("style")).toContain("white-space:pre");
      expect(text?.getAttribute("font-family")).toBe('"Hiragino Sans", sans-serif');
      expect(text?.getAttribute("font-size")).toBe("16");
      expect(text?.getAttribute("font-weight")).toBe("700");
      expect(text?.getAttribute("font-style")).toBe("italic");
      expect(seen).toEqual(["😀   😀"]);
      // 本文を残さない
      expect(text?.textContent).toBe("");
      // 外されていたら置き直す
      svg?.remove();
      expect(measure("ab", font)).toBe(16);
      expect(document.querySelector("svg[data-canvas-text-measure]")).not.toBeNull();
    } finally {
      delete (SVGElement.prototype as { getComputedTextLength?: unknown }).getComputedTextLength;
    }
  });

  it("getComputedTextLength がなければ null を返す", () => {
    expect(createSvgTextMeasure(() => document)("ab", font)).toBeNull();
    expect(createSvgTextMeasure(() => null)("ab", font)).toBeNull();
  });
});

describe("createDomFontMetrics (DOM のコード)", () => {
  it("内容の箱とベースラインの印から求め、物差しで割って UI スケール (zoom) に関係なくする", () => {
    // zoom 1.25 の画面: 長さがすべて 1.25 倍で返る
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const style = this.getAttribute("style") ?? "";
      if (style.includes("width:100px")) return { width: 125 } as DOMRect;
      if (style.includes("inline-block")) return { top: 117.5 } as DOMRect;
      return { top: 100, bottom: 122.5 } as DOMRect;
    });
    const metrics = createDomFontMetrics(() => document);
    expect(metrics({ ...font, weight: 700 })).toEqual({ ascent: 14, descent: 4 });
    const box = document.querySelector<HTMLElement>("div[data-canvas-text-measure]");
    expect(box?.parentElement).toBe(document.documentElement);
    expect(box?.style.font).toContain("Hiragino Sans");
    expect(box?.style.lineHeight).toBe("normal");
    expect(box?.getAttribute("aria-hidden")).toBe("true");
  });

  it("測れなければ null", () => {
    expect(createDomFontMetrics(() => document)(font)).toBeNull(); // jsdom は大きさ 0
    expect(createDomFontMetrics(() => null)(font)).toBeNull();
  });
});

describe("createLineBreakProbe (DOM のコード)", () => {
  /** jsdom の Range は getBoundingClientRect を持たないので、文字の位置ごとの行の上端を返すものを置く。 */
  function stubRangeTops(topOf: (offset: number) => number) {
    const calls: number[] = [];
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        calls.push(this.startOffset);
        return { top: topOf(this.startOffset) } as DOMRect;
      },
    });
    return calls;
  }

  afterEach(() => {
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  it("`aaaa/` が 1 行目に残れば (WebKit)、/ の後で折り返す", () => {
    // WebKit は、折り返した直後の文字の範囲を前の行の末尾として返す
    stubRangeTops((offset) => (offset <= 8 ? 0 : 20));
    expect(createLineBreakProbe(() => document)()).toEqual({ breakAfterSolidus: true });
    expect(document.querySelector("[data-canvas-text-measure]")).toBeNull();
  });

  it("単語ごと次の行へ送られれば (Chromium)、/ の後で折り返さない", () => {
    stubRangeTops((offset) => (offset <= 2 ? 0 : 20));
    expect(createLineBreakProbe(() => document)()).toEqual({ breakAfterSolidus: false });
  });

  it("行が分かれていなければ (レイアウトがない) 決めない。結果は 1 回だけ求める", () => {
    const calls = stubRangeTops(() => 0);
    const probe = createLineBreakProbe(() => document);
    expect(probe()).toEqual({});
    const count = calls.length;
    expect(probe()).toEqual({});
    expect(calls.length).toBe(count);
    expect(createLineBreakProbe(() => null)()).toEqual({});
  });
});

describe("createMeasureContext", () => {
  it("textRendering があれば geometricPrecision にする (なければ足さない)", () => {
    const withRendering = { textRendering: "auto" };
    const fakeDocument = (context: object) =>
      ({ createElement: () => ({ getContext: () => context }) }) as unknown as Document;
    expect(createMeasureContext(() => fakeDocument(withRendering))()).toBe(withRendering);
    expect(withRendering.textRendering).toBe("geometricPrecision");
    const without = {};
    createMeasureContext(() => fakeDocument(without))();
    expect("textRendering" in without).toBe(false);
    expect(createMeasureContext(() => null)()).toBeNull();
  });
});
