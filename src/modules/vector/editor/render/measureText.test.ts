import { describe, expect, it, vi } from "vitest";
import { fontMetricsOf } from "../text/metrics";
import {
  canvasTextMeasurer,
  createCanvasTextMeasurer,
  letterSpacingWidth,
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

describe("letterSpacingWidth", () => {
  it("書記素クラスタごとに字間を足す (最後の文字の後にも付く)", () => {
    expect(letterSpacingWidth("abc", 2)).toBe(6);
    expect(letterSpacingWidth("👨‍👩‍👧が", 2)).toBe(4);
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
    expect(mayContainEmoji("1️⃣")).toBe(true);
    expect(mayContainEmoji("𠮷")).toBe(false);
  });
});

describe("createCanvasTextMeasurer", () => {
  it("描画と同じ font で canvas の measureText を使い、字間を足し、結果を覚える", () => {
    const { ctx, fonts } = fakeContext();
    const measurer = createCanvasTextMeasurer(
      () => ctx,
      () => null,
    );
    expect(measurer.measure("ab", { ...font, letterSpacing: 1.5, weight: 700, italic: true })).toBe(
      23,
    );
    expect(fonts).toEqual(['italic 700 16px "Hiragino Sans", sans-serif']);
    expect(measurer.measure("ab", { ...font, letterSpacing: 0, weight: 700, italic: true })).toBe(
      20,
    );
    expect(ctx.measureText).toHaveBeenCalledTimes(1);
    expect(measurer.measure("", font)).toBe(0);
  });

  it("絵文字を含む文字列は SVG で測る (canvas は描画と幅が違う)", () => {
    const { ctx } = fakeContext();
    const svg = vi.fn(() => 16);
    const measurer = createCanvasTextMeasurer(() => ctx, svg);
    expect(measurer.measure("👍", font)).toBe(16);
    expect(svg).toHaveBeenCalledWith("👍", font);
    expect(measurer.measure("ab", font)).toBe(20);
    expect(svg).toHaveBeenCalledTimes(1);
  });

  it("SVG で測れなければ canvas で測る", () => {
    const { ctx } = fakeContext();
    const measurer = createCanvasTextMeasurer(
      () => ctx,
      () => null,
    );
    expect(measurer.measure("👍", font)).toBe(20);
  });

  it("canvas がなければフォントサイズ × 0.6 を 1 文字の幅とみなす", () => {
    const measurer = createCanvasTextMeasurer(
      () => null,
      () => null,
    );
    expect(measurer.measure("a👍🏽", font)).toBeCloseTo(19.2);
  });

  it("アセントとディセントは fontBoundingBox から求める。持たない WebView では null", () => {
    const withMetrics = createCanvasTextMeasurer(
      () => fakeContext({ fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 3 }).ctx,
      () => null,
    );
    expect(fontMetricsOf(withMetrics, font)).toEqual({ ascent: 14, descent: 3 });
    const without = createCanvasTextMeasurer(
      () => fakeContext().ctx,
      () => null,
    );
    expect(fontMetricsOf(without, font)).toBeNull();
    expect(fontMetricsOf({ measure: () => 1 }, font)).toBeNull();
  });

  it("jsdom では canvas と SVG を使わずに測る", () => {
    expect(canvasTextMeasurer.measure("abc", font)).toBeCloseTo(28.8);
    expect(canvasTextMeasurer.measure("👍", font)).toBeCloseTo(9.6);
    expect(fontMetricsOf(canvasTextMeasurer, font)).toBeNull();
  });
});
