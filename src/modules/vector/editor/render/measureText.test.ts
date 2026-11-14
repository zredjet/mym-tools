import { afterEach, describe, expect, it, vi } from "vitest";
import { fontMetricsOf } from "../text/metrics";
import {
  canvasTextMeasurer,
  createCanvasTextMeasurer,
  createDomFontMetrics,
  createMeasureContext,
  createSvgTextMeasure,
  letterSpacingWidth,
  MAX_CACHED_TEXT_LENGTH,
  MAX_CACHED_TOTAL_LENGTH,
  mayContainEmoji,
} from "./measureText";
import type { FontSpec } from "./types";

const font: FontSpec = {
  family: "Hiragino Sans",
  size: 16,
  weight: 400,
  italic: false,
  letterSpacing: 0,
};

/** canvas の 2D コンテキストの代わり。1 文字 (UTF-16) の幅を 10 とし、設定したフォントを覚える。 */
function fakeContext(metrics: Partial<TextMetrics> = {}) {
  const fonts: string[] = [];
  const ctx = {
    set font(value: string) {
      fonts.push(value);
    },
    measureText: vi.fn((text: string) => ({ width: text.length * 10, ...metrics })),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fonts };
}

/** SVG での計測の代わり。canvas と同じ幅 (1 文字 10) を返すので、どのフォントも canvas で測る。 */
const agreeingSvg = () => vi.fn((text: string) => text.length * 10);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("letterSpacingWidth", () => {
  it("書記素クラスタごとに字間を足す (最後の文字の後にも付く)", () => {
    expect(letterSpacingWidth("abc", 2)).toBe(6);
    expect(letterSpacingWidth("👨\u200d👩\u200d👧か\u3099", 2)).toBe(4);
    expect(letterSpacingWidth("abc", 0)).toBe(0);
    expect(letterSpacingWidth("", 3)).toBe(0);
  });
});

describe("mayContainEmoji", () => {
  it("絵文字として描かれうる文字を見つける", () => {
    expect(mayContainEmoji("abc 日本語、。")).toBe(false);
    expect(mayContainEmoji("👍")).toBe(true);
    expect(mayContainEmoji("🇯🇵")).toBe(true);
    expect(mayContainEmoji("✅")).toBe(true);
    expect(mayContainEmoji("●")).toBe(true);
    expect(mayContainEmoji("1\ufe0f\u20e3")).toBe(true);
    expect(mayContainEmoji("𠮷")).toBe(false);
  });
});

describe("createCanvasTextMeasurer", () => {
  it("canvas と SVG の幅が合うフォントは、描画と同じ font で canvas を使い、字間を足し、結果を覚える", () => {
    const { ctx, fonts } = fakeContext();
    const svg = agreeingSvg();
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    const bold = { ...font, weight: 700, italic: true };
    expect(measurer.measure("ab", { ...bold, letterSpacing: 1.5 })).toBe(23);
    expect(fonts).toEqual(['italic 700 16px "Hiragino Sans", sans-serif']);
    const svgCalls = svg.mock.calls.length; // フォントごとの最初の比較
    expect(measurer.measure("ab", bold)).toBe(20);
    expect(measurer.measure("cd", bold)).toBe(20);
    expect(svg.mock.calls.length).toBe(svgCalls);
    expect(measurer.measure("", font)).toBe(0);
  });

  it("絵文字を含む文字列は SVG で測る (canvas は描画と幅が違う)", () => {
    const { ctx } = fakeContext();
    const svg = vi.fn((text: string) => (text === "👍" ? 16 : text.length * 10));
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    expect(measurer.measure("👍", font)).toBe(16);
    expect(svg).toHaveBeenCalledWith("👍", font);
  });

  it("canvas と SVG の幅が合わないフォントは、すべて SVG で測る", () => {
    const { ctx } = fakeContext();
    // system-ui の欧文だけ canvas と描画で幅が違う、という PC の代わり
    const svg = vi.fn((text: string, spec: FontSpec) =>
      spec.family === "system-ui" ? text.length * 9 : text.length * 10,
    );
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    expect(measurer.measure("abc", { ...font, family: "system-ui" })).toBe(27);
    expect(measurer.measure("abc", font)).toBe(30);
    expect(svg.mock.calls.some(([text]) => text === "abc")).toBe(true);
  });

  it("SVG で測れなければ canvas、canvas もなければフォントサイズ × 0.6 を 1 文字の幅とみなす", () => {
    const { ctx } = fakeContext();
    const viaCanvas = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: () => null,
    });
    expect(viaCanvas.measure("👍", font)).toBe(20);
    const none = createCanvasTextMeasurer({ getContext: () => null, measureWithSvg: () => null });
    expect(none.measure("a👍🏽", font)).toBeCloseTo(19.2);
  });

  it("長い文字列は覚えず、覚える量は文字列の合計の長さで抑える", () => {
    const { ctx } = fakeContext();
    const measurer = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: agreeingSvg(),
    });
    const long = "a".repeat(MAX_CACHED_TEXT_LENGTH + 1);
    measurer.measure("x", font);
    const before = measurer.cachedLength;
    measurer.measure(long, font);
    measurer.measure(long, font);
    expect(measurer.cachedLength).toBe(before);
    expect(vi.mocked(ctx.measureText).mock.calls.filter(([text]) => text === long)).toHaveLength(2);
    // 覚えられる長さの文字列を合計の上限を超えるまで測っても、上限を超えて覚えない
    const piece = "b".repeat(MAX_CACHED_TEXT_LENGTH - 6);
    const count = Math.ceil((MAX_CACHED_TOTAL_LENGTH * 1.5) / piece.length);
    for (let i = 0; i < count; i++) measurer.measure(`${i}`.padStart(6, "0") + piece, font);
    expect(measurer.cachedLength).toBeLessThanOrEqual(MAX_CACHED_TOTAL_LENGTH);
    expect(measurer.cachedLength).toBeGreaterThan(0);
  });

  it("アセントとディセントは編集欄と同じ HTML の行の箱から求め、だめなら canvas の fontBoundingBox", () => {
    const fromDom = createCanvasTextMeasurer({
      getContext: () => fakeContext({ fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 3 }).ctx,
      measureWithSvg: agreeingSvg(),
      measureFontMetrics: () => ({ ascent: 15, descent: 4 }),
    });
    expect(fontMetricsOf(fromDom, font)).toEqual({ ascent: 15, descent: 4 });
    const fromCanvas = createCanvasTextMeasurer({
      getContext: () => fakeContext({ fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 3 }).ctx,
      measureWithSvg: agreeingSvg(),
      measureFontMetrics: () => null,
    });
    expect(fontMetricsOf(fromCanvas, font)).toEqual({ ascent: 14, descent: 3 });
    const without = createCanvasTextMeasurer({
      getContext: () => fakeContext().ctx,
      measureWithSvg: agreeingSvg(),
      measureFontMetrics: () => null,
    });
    expect(fontMetricsOf(without, font)).toBeNull();
    expect(fontMetricsOf({ measure: () => 1 }, font)).toBeNull();
  });

  it("jsdom では canvas と SVG を使わずに測る", () => {
    expect(canvasTextMeasurer.measure("abc", font)).toBeCloseTo(28.8);
    expect(canvasTextMeasurer.measure("👍", font)).toBeCloseTo(9.6);
    expect(fontMetricsOf(canvasTextMeasurer, font)).toBeNull();
    expect(document.querySelector("[data-canvas-text-measure]")).toBeNull();
  });
});

describe("createSvgTextMeasure (DOM のコード)", () => {
  it("見えない SVG の text を body に置き、空白を保つ設定と描画と同じフォントで測る", () => {
    const lengths: string[] = [];
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value(this: SVGElement) {
        lengths.push(this.textContent ?? "");
        return (this.textContent ?? "").length * 8;
      },
    });
    try {
      const measure = createSvgTextMeasure(() => document);
      expect(measure("😀   😀", { ...font, weight: 700, italic: true })).toBe(5 * 8 + 2 * 8);
      const svg = document.querySelector("svg[data-canvas-text-measure]");
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
      expect(lengths).toEqual(["😀   😀"]);
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
  it("内容の箱とベースラインの印からアセントとディセントを求める", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const isMarker = this.getAttribute("style")?.includes("inline-block") === true;
      return (isMarker ? { top: 114 } : { top: 100, bottom: 118 }) as DOMRect;
    });
    const metrics = createDomFontMetrics(() => document);
    expect(metrics({ ...font, weight: 700 })).toEqual({ ascent: 14, descent: 4 });
    const box = document.querySelector<HTMLElement>("div[data-canvas-text-measure]");
    expect(box?.style.font).toContain("Hiragino Sans");
    expect(box?.style.lineHeight).toBe("normal");
    expect(box?.getAttribute("aria-hidden")).toBe("true");
  });

  it("測れなければ null", () => {
    expect(createDomFontMetrics(() => document)(font)).toBeNull(); // jsdom は大きさ 0
    expect(createDomFontMetrics(() => null)(font)).toBeNull();
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
