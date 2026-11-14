import { describe, expect, it } from "vitest";
import { formatRulerValue, MIN_MAJOR_SPACING, rulerStep, rulerTicks } from "./rulerTicks";

describe("ルーラーの目盛り", () => {
  it("間隔は画面で 64 px 以上になる 1・2・5 × 10^n", () => {
    expect(rulerStep(1)).toBe(100);
    expect(rulerStep(0.75)).toBe(100);
    expect(rulerStep(0.5)).toBe(200);
    expect(rulerStep(0.1)).toBe(1000);
    expect(rulerStep(2)).toBe(50);
    expect(rulerStep(12)).toBe(10);
    expect(rulerStep(64)).toBe(1); // 1 px より細かくしない
    for (const zoom of [0.02, 0.3, 1, 3.7, 20]) {
      expect(rulerStep(zoom) * zoom).toBeGreaterThanOrEqual(Math.min(MIN_MAJOR_SPACING, 64 * zoom));
    }
  });

  it("ラベル付きの目盛りの位置と値", () => {
    const ticks = rulerTicks(-30, 1, 300);
    expect(ticks.step).toBe(100);
    expect(ticks.major).toEqual([
      { value: 0, screen: 30 },
      { value: 100, screen: 130 },
      { value: 200, screen: 230 },
    ]);
  });

  it("細かい目盛り: 100 の間隔なら 20 ごと", () => {
    const ticks = rulerTicks(0, 1, 100);
    expect(ticks.minor.map((tick) => tick.value)).toEqual([20, 40, 60, 80]);
  });

  it("細かい目盛りは 1 ページ px 未満にしない", () => {
    expect(rulerTicks(0, 64, 640).minor).toEqual([]);
  });

  it("倍率が変わると間隔も変わる", () => {
    expect(rulerTicks(0, 4, 400).major.map((tick) => tick.value)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("ラベルは整数", () => {
    expect(formatRulerValue(-200)).toBe("-200");
    expect(formatRulerValue(1e-9)).toBe("0");
  });
});
