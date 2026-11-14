import { describe, expect, it } from "vitest";
import { gridLevels, gridOffset } from "./grid";

describe("グリッドを描く条件 (§5.5)", () => {
  it("切なら描かない (800% 未満)", () => {
    expect(gridLevels({ grid: false, gridSize: 8 }, 1)).toEqual([]);
  });

  it("入なら gridSize の間隔で描く", () => {
    expect(gridLevels({ grid: true, gridSize: 8 }, 1)).toEqual([{ step: 8, strong: true }]);
  });

  it("線の間隔が 4 画面 px を下回る倍率では描かない", () => {
    expect(gridLevels({ grid: true, gridSize: 8 }, 0.5)).toEqual([{ step: 8, strong: true }]);
    expect(gridLevels({ grid: true, gridSize: 8 }, 0.49)).toEqual([]);
  });

  it("800% 以上では入切に関係なく 1 px のグリッドを描く", () => {
    expect(gridLevels({ grid: false, gridSize: 8 }, 8)).toEqual([{ step: 1, strong: false }]);
    expect(gridLevels({ grid: false, gridSize: 8 }, 7.99)).toEqual([]);
    expect(gridLevels({ grid: true, gridSize: 8 }, 10)).toEqual([
      { step: 1, strong: false },
      { step: 8, strong: true },
    ]);
  });

  it("gridSize が 1 なら 1 px のグリッドを 1 つだけ濃く描く", () => {
    expect(gridLevels({ grid: true, gridSize: 1 }, 8)).toEqual([{ step: 1, strong: true }]);
  });

  it("パターンの開始位置は 0 以上 1 周期未満", () => {
    expect(gridOffset(0, 8, 1)).toBe(0);
    expect(gridOffset(3, 8, 1)).toBe(5);
    expect(gridOffset(-3, 8, 1)).toBe(3);
    expect(gridOffset(1_000_003, 8, 2)).toBe(10);
  });
});
