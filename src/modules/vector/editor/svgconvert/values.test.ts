import { describe, expect, it } from "vitest";

import { applyToPoint, multiply, rotate, scale, translate } from "../geometry/matrix";
import {
  cleanNumber,
  parseColor,
  parseLength,
  parseNumberList,
  parseOpacity,
  parseTransformList,
  parseViewBox,
  viewBoxTransform,
} from "./values";

describe("SVG の値の読み取り", () => {
  it("数値の並び (詰めた書き方、読めたところまで)", () => {
    expect(parseNumberList("1,2 3-4.5.5e1")).toEqual([1, 2, 3, -4.5, 5]);
    expect(parseNumberList("1 2 x 3")).toEqual([1, 2]);
  });

  it("長さの単位と %", () => {
    const context = { viewport: { width: 200, height: 100 }, fontSize: 10 };
    expect(parseLength("12", context)).toBe(12);
    expect(parseLength("1in", context)).toBe(96);
    expect(parseLength("3pt", context)).toBe(4);
    expect(parseLength("2em", context)).toBe(20);
    expect(parseLength("50%", context, "x")).toBe(100);
    expect(parseLength("50%", context, "y")).toBe(50);
    expect(parseLength("10%", context, "other")).toBeCloseTo(
      Math.hypot(200, 100) / Math.SQRT2 / 10,
      9,
    );
    expect(parseLength("auto", context)).toBeNull();
  });

  it("色", () => {
    expect(parseColor("#abc")).toEqual({ color: "#AABBCC", alpha: 1 });
    expect(parseColor("#11223380")).toEqual({ color: "#112233", alpha: 128 / 255 });
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ color: "#FF0000", alpha: 1 });
    expect(parseColor("rgba(0,0,255,0.5)")).toEqual({ color: "#0000FF", alpha: 0.5 });
    expect(parseColor("rgb(100% 0% 0% / 25%)")).toEqual({ color: "#FF0000", alpha: 0.25 });
    expect(parseColor("hsl(120, 100%, 50%)")).toEqual({ color: "#00FF00", alpha: 1 });
    expect(parseColor("RebeccaPurple")).toEqual({ color: "#663399", alpha: 1 });
    expect(parseColor("transparent")).toEqual({ color: "#000000", alpha: 0 });
    expect(parseColor("url(#a)")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });

  it("不透明度", () => {
    expect(parseOpacity("0.5")).toBe(0.5);
    expect(parseOpacity("40%")).toBe(0.4);
    expect(parseOpacity("2")).toBe(1);
    expect(parseOpacity("x")).toBeNull();
  });

  it("transform の並び (誤りがあれば null)", () => {
    const m = parseTransformList("translate(10,20) rotate(30 5 5), scale(2)");
    const want = multiply(multiply(translate(10, 20), rotate(30, 5, 5)), scale(2));
    for (const p of [
      { x: 0, y: 0 },
      { x: 3, y: -7 },
    ])
      expect(applyToPoint(m!, p)).toEqual(applyToPoint(want, p));
    expect(parseTransformList("matrix(1 0 0 1 5 6)")).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 5,
      f: 6,
    });
    expect(parseTransformList("translate(1,)")).toBeNull();
    expect(parseTransformList("rotate(1 2)")).toBeNull();
    expect(parseTransformList("foo(1)")).toBeNull();
  });

  it("viewBox と preserveAspectRatio", () => {
    expect(parseViewBox("0 0 10 0")).toBeNull();
    const vb = parseViewBox("0,0,10,10")!;
    expect(applyToPoint(viewBoxTransform(vb, 40, 20, null), { x: 10, y: 10 })).toEqual({
      x: 30,
      y: 20,
    });
    expect(applyToPoint(viewBoxTransform(vb, 40, 20, "xMinYMin slice"), { x: 10, y: 10 })).toEqual({
      x: 40,
      y: 40,
    });
    expect(applyToPoint(viewBoxTransform(vb, 40, 20, "none"), { x: 10, y: 10 })).toEqual({
      x: 40,
      y: 20,
    });
  });

  it("計算の誤差を落とす", () => {
    expect(cleanNumber(159.99999999999997)).toBe(160);
    expect(cleanNumber(-0)).toBe(0);
    expect(cleanNumber(0.1234567891234)).toBe(0.1234567891234);
  });
});
