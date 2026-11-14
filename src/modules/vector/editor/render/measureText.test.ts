import { afterEach, describe, expect, it, vi } from "vitest";
import { editorWidthOf, fontMetricsOf, lineBreakOptionsOf, lineEndTrimOf } from "../text/metrics";
import {
  AGREEMENT_PROBES,
  AGREEMENT_TOLERANCE,
  canvasTextMeasurer,
  CJK,
  createCanvasTextMeasurer,
  createDomFontMetrics,
  createLineBreakProbe,
  createLineEndTrimProbe,
  createMeasureContext,
  createSvgTextMeasure,
  EMOJI,
  KERNING_PROBE,
  LATIN,
  LINE_BREAK_PROBES,
  letterSpacingWidth,
  MAX_CACHED_TEXT_LENGTH,
  MAX_CACHED_TOTAL_LENGTH,
  mayContainEmoji,
  OTHER,
  scriptClasses,
  usesComplexTextPath,
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

/**
 * Range の getClientRects を差し替える (WKWebView の代わり)。jsdom が持っていれば戻せるように元を覚える。
 * `rectsOf` が null を返したら、getBoundingClientRect の矩形 1 つを返す。
 */
function stubClientRects(rectsOf: (range: Range) => DOMRect[] | null) {
  const original = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      return rectsOf(this) ?? [this.getBoundingClientRect()];
    },
  });
  return () => {
    if (original) Object.defineProperty(Range.prototype, "getClientRects", original);
    else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  };
}

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

  it("SVG で測れなかったときは、エンジンの判定と canvas と描画が合うかの判定を覚えず、次に確かめ直す", () => {
    const { ctx } = fakeContext();
    let available = false;
    const svg = vi.fn((text: string) =>
      available ? kernedWidth(text) - (text.includes("テ") ? 1 : 0) : null,
    );
    const measurer = createCanvasTextMeasurer({ getContext: () => ctx, measureWithSvg: svg });
    expect(measurer.measure("テキスト", font)).toBe(40);
    expect(measurer.pathInfo.svgMatchesDrawing).toBeNull();
    available = true;
    // 次の計測で確かめ直す: Chromium 型で、和文は canvas と描画が合わないので SVG で測る
    expect(measurer.measure("テキスト!", font)).toBe(49);
    expect(measurer.pathInfo.svgMatchesDrawing).toBe(true);
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

  it("描画と同じ font で測り、結果を覚える", () => {
    const { ctx, fonts } = fakeContext();
    const measurer = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: webkitSvg(),
    });
    const bold = { ...font, weight: 700, italic: true };
    expect(measurer.measure("AVab", bold)).toBe(38);
    expect(fonts).toContain('italic 700 16px "Hiragino Sans", sans-serif');
    const calls = vi.mocked(ctx.measureText).mock.calls.length;
    expect(measurer.measure("AVab", bold)).toBe(38);
    expect(vi.mocked(ctx.measureText).mock.calls.length).toBe(calls);
    expect(measurer.measure("", font)).toBe(0);
  });

  it("WebKit 型で字間があれば、1 文字ずつの幅の和に符号位置の数 × 字間を足す。複雑な組版の経路の文字を含めば全体をカーニングして測る", () => {
    const { ctx } = fakeContext();
    const measurer = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: webkitSvg(),
    });
    const spaced = { ...font, letterSpacing: 1.5 };
    // AV のカーニング (2) は入らない
    expect(measurer.measure("AVab", spaced)).toBe(40 + 4 * 1.5);
    // 異体字セレクタ (U+FE0F) を含む: 全体 (カーニングあり) + 符号位置 5 × 字間
    expect(measurer.measure("AVa\u2764\ufe0f", spaced)).toBe(
      kernedWidth("AVa\u2764\ufe0f") + 5 * 1.5,
    );
  });

  it("Chromium 型で canvas が letterSpacing を持たなければ、書記素クラスタごとに字間を足す", () => {
    const { ctx } = fakeContext();
    const measurer = createCanvasTextMeasurer({
      getContext: () => ctx,
      measureWithSvg: chromiumSvg(),
    });
    expect(measurer.measure("AVab", { ...font, letterSpacing: 1.5 })).toBe(38 + 4 * 1.5);
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

  it("編集欄の幅: Chromium 型は描画の幅。WebKit 型は組む単位ごとの和、字間があればカーニングなしで書記素ごとに字間", () => {
    // キャ の間を 3 詰めるフォント
    const kana = (text: string) => Array.from(text).length * 10 - (text.includes("キャ") ? 3 : 0);
    const { ctx: chromiumCtx } = fakeContext(
      (text) => kernedWidth(text) - (text.includes("キャ") ? 3 : 0),
    );
    const chromium = createCanvasTextMeasurer({
      getContext: () => chromiumCtx,
      measureWithSvg: chromiumSvg(),
      detectLineBreaks: () => ({ shapePerUnit: false }),
    });
    expect(editorWidthOf(chromium, "キャンプ", font)).toBe(37);
    const webkit = (shapePerUnit: boolean) =>
      createCanvasTextMeasurer({
        getContext: () =>
          fakeContext(
            (text) => kernedWidth(text) - (kana(text) < Array.from(text).length * 10 ? 3 : 0),
          ).ctx,
        measureWithSvg: webkitSvg(),
        detectLineBreaks: () => ({ shapePerUnit }),
      });
    // 小書きのかなの前でも区切って組む (キ + ャ + ン + プ)
    expect(editorWidthOf(webkit(true), "キャンプ", font)).toBe(40);
    expect(webkit(true).measure("キャンプ", font)).toBe(37);
    expect(editorWidthOf(webkit(false), "キャンプ", font)).toBe(37);
    // 字間 2: 書記素ごとの幅の和 + 書記素の数 × 字間 (ZWJ の並びも 1 つ)
    expect(
      editorWidthOf(webkit(true), "AV\ud83d\udc68\u200d\ud83d\udc69", {
        ...font,
        letterSpacing: 2,
      }),
    ).toBe(20 + kernedWidth("\ud83d\udc68\u200d\ud83d\udc69") + 3 * 2);
    expect(editorWidthOf({ measure: () => 7 }, "abc", font)).toBe(7);
  });

  it("行末の約物を詰める割合はエンジンから求めたものを返す", () => {
    const detect = vi.fn((_previous: string, last: string) => (last === "」" ? 0.5 : 0));
    const measurer = createCanvasTextMeasurer({
      getContext: () => null,
      detectLineEndTrim: detect,
    });
    expect(lineEndTrimOf(measurer, "あ", "」", font)).toBe(0.5);
    expect(detect).toHaveBeenCalledWith("あ", "」", font);
    expect(lineEndTrimOf({ measure: () => 1 }, "あ", "」", font)).toBe(0);
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

describe("usesComplexTextPath", () => {
  it("結合文字・異体字セレクタ・ZWJ・肌の色・旗・字形を組み合わせる文字を見つける", () => {
    expect(usesComplexTextPath("Hello 世界 Ελληνικά é")).toBe(false);
    expect(usesComplexTextPath("AVAV e\u0301")).toBe(true);
    expect(usesComplexTextPath("ka\u02e5")).toBe(true);
    expect(usesComplexTextPath("\ud83d\ude00")).toBe(false);
    expect(usesComplexTextPath("\u2764\ufe0f")).toBe(true);
    expect(usesComplexTextPath("\ud83d\udc4d\ud83c\udffd")).toBe(true);
    expect(usesComplexTextPath("\ud83c\uddef\ud83c\uddf5")).toBe(true);
    expect(usesComplexTextPath("a\u200db")).toBe(true);
    expect(usesComplexTextPath("か\u3099")).toBe(true);
    expect(usesComplexTextPath("\u0627\u0644")).toBe(true);
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
  function stubRangeTops(topOf: (text: string, offset: number) => number) {
    const calls: number[] = [];
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        calls.push(this.startOffset);
        return { top: topOf(this.startContainer.textContent ?? "", this.startOffset) } as DOMRect;
      },
    });
    return calls;
  }

  afterEach(() => {
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  /** 単位ごとの組みの確かめの span の幅。keep-all の span だけ `kept`、ふつうの span は `split`。 */
  function stubSpanWidths(split: number, kept: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const keepAll = this.getAttribute("style")?.includes("keep-all") === true;
      return { width: keepAll ? kept : split } as DOMRect;
    });
  }

  /** 確かめの文字列ごとの、1 行目の最後の文字の位置 */
  function firstLineEnds(ends: Record<keyof typeof LINE_BREAK_PROBES, number>) {
    const byText = new Map<string, number>(
      Object.entries(ends).map(([key, end]) => [
        LINE_BREAK_PROBES[key as keyof typeof LINE_BREAK_PROBES].text,
        end,
      ]),
    );
    return (text: string, offset: number) => (offset <= (byText.get(text) ?? 0) ? 0 : 20);
  }

  it("WebKit の折り返し: / の後、: と \\ の間で折り返し、- と数字の間では折り返さず、全角空白をぶら下げず、単位ごとに組む", () => {
    // WebKit は、折り返した直後の文字の範囲を前の行の末尾として返す (1 つ先まで 1 行目とする)
    stubRangeTops(
      firstLineEnds({
        breakAfterSolidus: 8,
        breakHyphenBeforeDigit: 3,
        breakBeforeAsciiPrefix: 5,
        ideographicSpaceHangs: 3,
      }),
    );
    stubSpanWidths(384, 379.2);
    expect(createLineBreakProbe(() => document)()).toEqual({
      breakAfterSolidus: true,
      breakHyphenBeforeDigit: false,
      breakBeforeAsciiPrefix: true,
      keepIdeographicSpace: true,
      shapePerUnit: true,
    });
    expect(document.querySelector("[data-canvas-text-measure]")).toBeNull();
  });

  it("Chromium の折り返し: / と \\ の前では単語ごと送り、- と数字の間で折り返し、全角空白をぶら下げ、行全体で組む", () => {
    stubRangeTops(
      firstLineEnds({
        breakAfterSolidus: 2,
        breakHyphenBeforeDigit: 5,
        breakBeforeAsciiPrefix: 2,
        ideographicSpaceHangs: 4,
      }),
    );
    stubSpanWidths(379.2, 379.2);
    expect(createLineBreakProbe(() => document)()).toEqual({
      breakAfterSolidus: false,
      breakHyphenBeforeDigit: true,
      breakBeforeAsciiPrefix: false,
      keepIdeographicSpace: false,
      shapePerUnit: false,
    });
  });

  it("単位ごとの組みは、かなをカーニングするフォントが見つかるまで候補を順に試す", () => {
    stubRangeTops((_, offset) => (offset <= 2 ? 0 : 20));
    const fonts: string[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const box = this.parentElement;
      const font = box?.style.font ?? "";
      if (!this.getAttribute("style")?.includes("keep-all")) fonts.push(font);
      // 3 つ目の候補 (Yu Gothic) で初めて違いが出る
      const kerns = font.includes("Yu Gothic");
      const keepAll = this.getAttribute("style")?.includes("keep-all") === true;
      return { width: kerns && keepAll ? 370 : 384 } as DOMRect;
    });
    expect(createLineBreakProbe(() => document)().shapePerUnit).toBe(true);
    expect(fonts).toHaveLength(3);
  });

  it("途中で例外が出たら確かめる要素を外し、既定の規則を返して覚えず、次に確かめ直す", () => {
    let fail = true;
    stubRangeTops((_text, offset) => {
      if (fail) throw new Error("layout");
      return offset <= 2 ? 0 : 20;
    });
    stubSpanWidths(379.2, 379.2);
    const probe = createLineBreakProbe(() => document);
    expect(probe()).toEqual({});
    expect(document.documentElement.querySelector("div[lang]")).toBeNull();
    fail = false;
    expect(probe()).toMatchObject({ breakAfterSolidus: false });
    expect(document.documentElement.querySelector("div[lang]")).toBeNull();
  });

  it("次の行へ送られた文字に前の行の幅 0 の矩形も返されても (WKWebView)、送られたとみなす", () => {
    // WebKit の折り返し。送られた文字の範囲は、1 行目の末尾の幅 0 の矩形と、2 行目の矩形を返す
    const ends = {
      breakAfterSolidus: 8,
      breakHyphenBeforeDigit: 3,
      breakBeforeAsciiPrefix: 5,
      ideographicSpaceHangs: 3,
    };
    stubRangeTops(firstLineEnds(ends));
    const restore = stubClientRects((range) => {
      const rect = range.getBoundingClientRect();
      return rect.top > 0
        ? [{ top: 0, width: 0 } as DOMRect, { top: rect.top, width: 8 } as DOMRect]
        : null;
    });
    try {
      stubSpanWidths(384, 379.2);
      expect(createLineBreakProbe(() => document)()).toEqual({
        breakAfterSolidus: true,
        breakHyphenBeforeDigit: false,
        breakBeforeAsciiPrefix: true,
        keepIdeographicSpace: true,
        shapePerUnit: true,
      });
    } finally {
      restore();
    }
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

describe("createLineEndTrimProbe (DOM のコード)", () => {
  afterEach(() => {
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });

  /**
   * Chromium の代わり: 1 文字 16 (UI スケール 1.25 で 20 に見える)。収まらない行の末尾の 」 と、」 の後の 、 を
   * 半分詰める。〛 とほかの読点は詰めない。詰めて入らなければ、約物は前の文字ごと次の行へ送られる。
   */
  function stubChromium(scale = 1.25) {
    const calls: string[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return { width: 100 * scale } as DOMRect;
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        const text = this.startContainer.textContent ?? "";
        const box = this.startContainer.parentElement as HTMLElement;
        calls.push(text);
        const chars = Array.from(text);
        const last = chars[3] as string;
        const squeezable = last === "\u300d" || (last === "\u3001" && chars[2] === "\u300d");
        const available = Number.parseFloat(box.style.width);
        const squeezed = available < 64 && squeezable && available >= 56;
        const onSecondLine = available < 64 && !squeezed;
        const lastWidth = squeezed ? 8 : 16;
        const { startOffset: from, endOffset: to } = this;
        if (from === 3) return { top: onSecondLine ? 20 : 0, width: lastWidth * scale } as DOMRect;
        if (from === 0 && to === 1) return { top: 0, width: 16 * scale } as DOMRect;
        return { top: 0, width: (48 + lastWidth) * scale } as DOMRect;
      },
    });
    return calls;
  }

  it("少しだけ狭い幅に置いて、1 行目に残った約物について行の縮んだ幅の割合を返す。前の文字と合わせて確かめる", () => {
    const calls = stubChromium();
    const probe = createLineEndTrimProbe(() => document);
    expect(probe("あ", "\u300d", font)).toBe(0.5);
    expect(probe("\u300d", "\u3001", font)).toBe(0.5);
    expect(probe("あ", "\u3001", font)).toBe(0);
    expect(probe("あ", "\u301b", font)).toBe(0);
    const box = document.querySelector<HTMLElement>("div[data-canvas-text-measure][lang]");
    expect(box?.parentElement).toBe(document.documentElement);
    expect(box?.getAttribute("lang")).toBe("ja");
    expect(box?.style.whiteSpace).toBe("pre-wrap");
    expect(box?.textContent).toBe("");
    // 前の文字が文字や数字なら 1 つの代表で確かめ、結果を覚える
    const count = calls.length;
    expect(probe("漢", "\u300d", font)).toBe(0.5);
    expect(probe("A", "\u300d", font)).toBe(0.5);
    expect(calls.length).toBe(count);
    probe("あ", "\u300d", { ...font, letterSpacing: 1 });
    expect(calls.length).toBeGreaterThan(count);
    expect(box?.style.letterSpacing).toBe("1px");
  });

  it("途中で例外が出たら 0 を返し、覚えずに次に確かめ直す。本文は空にする", () => {
    stubChromium();
    let fail = true;
    const original = Range.prototype.getBoundingClientRect;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        if (fail) throw new Error("layout");
        return original.call(this);
      },
    });
    const probe = createLineEndTrimProbe(() => document);
    expect(probe("あ", "\u300d", font)).toBe(0);
    expect(
      document.querySelector<HTMLElement>("div[data-canvas-text-measure][lang]")?.textContent,
    ).toBe("");
    fail = false;
    expect(probe("あ", "\u300d", font)).toBe(0.5);
  });

  /**
   * WKWebView の代わり: 詰めない。1 文字 16。狭めると約物は前の文字ごと 2 行目へ送られるが、送られた約物の
   * 範囲は 1 行目の末尾の幅 0 の矩形も返し、それを含めて囲む矩形の上端は 1 行目になる。
   */
  function stubWkWebView() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: 100 }) as DOMRect,
    );
    const moved = (range: Range) =>
      Number.parseFloat((range.startContainer.parentElement as HTMLElement).style.width) < 64;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        const { startOffset: from, endOffset: to } = this;
        if (from === 0 && to === 1) return { top: 0, width: 16 } as DOMRect;
        if (from === 3) return { top: 0, width: 16 } as DOMRect;
        // 送られた後の 1〜4 文字目を囲む矩形は、2 行にまたがって 1 行目の幅に縮んで見える
        return { top: 0, width: moved(this) ? 48.3 : 64 } as DOMRect;
      },
    });
    return stubClientRects((range) =>
      range.startOffset === 3 && moved(range)
        ? [{ top: 0, width: 0 } as DOMRect, { top: 20, width: 16 } as DOMRect]
        : null,
    );
  }

  it("送られた約物に前の行の幅 0 の矩形も返されても (WKWebView)、残ったと数えない", () => {
    const restore = stubWkWebView();
    try {
      const probe = createLineEndTrimProbe(() => document);
      expect(probe(" ", "\u300d", font)).toBe(0);
      expect(probe("\t", "\u3002", font)).toBe(0);
    } finally {
      restore();
    }
  });

  it("縮んだ幅が字の送りの半分を大きく超えるもの (測り違い) は採らない", () => {
    stubChromium();
    // 1 行目に残ったまま、行が 15 縮んだように見える
    const original = Range.prototype.getBoundingClientRect;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        const rect = original.call(this);
        const narrowed =
          Number.parseFloat((this.startContainer.parentElement as HTMLElement).style.width) < 64;
        if (narrowed && this.startOffset === 0 && this.endOffset === 4)
          return { top: 0, width: 49 * 1.25 } as DOMRect;
        if (narrowed && this.startOffset === 3) return { top: 0, width: 16 * 1.25 } as DOMRect;
        return rect;
      },
    });
    expect(createLineEndTrimProbe(() => document)("あ", "\u300d", font)).toBe(0);
  });

  it("測れなければ (レイアウトのない環境) 詰めない", () => {
    expect(createLineEndTrimProbe(() => document)("あ", "\u300d", font)).toBe(0);
    expect(createLineEndTrimProbe(() => null)("あ", "\u300d", font)).toBe(0);
  });
});

describe("createMeasureContext", () => {
  /** canvas と html だけを持つ文書の代わり。 */
  function fakeDocument(context: { canvas?: unknown; textRendering?: string }) {
    const attributes = new Map<string, string>();
    const canvas = {
      width: 0,
      height: 0,
      isConnected: false,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getContext: () => context,
    };
    context.canvas = canvas;
    const appendChild = vi.fn((element: { isConnected: boolean }) => {
      element.isConnected = true;
    });
    const doc = {
      createElement: () => canvas,
      documentElement: { appendChild },
    } as unknown as Document;
    return { doc, canvas, attributes, appendChild };
  }

  it("canvas を html の直下に見えないように置き (言語を引き継ぐ)、textRendering があれば geometricPrecision にする", () => {
    const withRendering: { canvas?: unknown; textRendering?: string } = { textRendering: "auto" };
    const { doc, canvas, attributes, appendChild } = fakeDocument(withRendering);
    const getContext = createMeasureContext(() => doc);
    expect(getContext()).toBe(withRendering);
    expect(withRendering.textRendering).toBe("geometricPrecision");
    expect(appendChild).toHaveBeenCalledWith(canvas);
    expect(attributes.get("style")).toContain("visibility:hidden");
    expect(attributes.get("aria-hidden")).toBe("true");
    // 外されていたら置き直す
    canvas.isConnected = false;
    getContext();
    expect(appendChild).toHaveBeenCalledTimes(2);
    const without: { canvas?: unknown; textRendering?: string } = {};
    createMeasureContext(() => fakeDocument(without).doc)();
    expect("textRendering" in without).toBe(false);
    expect(createMeasureContext(() => null)()).toBeNull();
  });
});
