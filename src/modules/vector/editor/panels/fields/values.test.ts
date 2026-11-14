import { describe, expect, it } from "vitest";

import {
  clampToRange,
  clipName,
  commonValue,
  formatNumber,
  fromPercent,
  inRange,
  MIXED,
  parseHexInput,
  parseNumberInput,
  roundTo,
} from "./values";

describe("parseNumberInput", () => {
  it("半角・全角の数値を読む", () => {
    expect(parseNumberInput(" 12 ")).toBe(12);
    expect(parseNumberInput("-3.5")).toBe(-3.5);
    expect(parseNumberInput(".5")).toBe(0.5);
    expect(parseNumberInput("１２３")).toBe(123);
    expect(parseNumberInput("－４")).toBe(-4);
    expect(parseNumberInput("−4")).toBe(-4);
  });
  it("数値でなければ null", () => {
    for (const text of ["", "abc", "1e3", "1,000", "--1", "12px", "Infinity", "."])
      expect(parseNumberInput(text)).toBeNull();
  });
});

describe("丸めと表示", () => {
  it("桁数で丸め、-0 を 0 にする", () => {
    expect(roundTo(1.005, 0)).toBe(1);
    expect(roundTo(1.256, 2)).toBe(1.26);
    expect(Object.is(roundTo(-0.2, 0), 0)).toBe(true);
    expect(formatNumber(28.999999999999996, 0)).toBe("29");
    expect(formatNumber(1.5, 2)).toBe("1.5");
  });
  it("% と 0〜1 を行き来する", () => {
    expect(fromPercent(33)).toBe(0.33);
    expect(fromPercent(33.3)).toBe(0.333);
  });
});

describe("範囲", () => {
  it("下限を含むか含まないかを選べる", () => {
    expect(inRange(0, { min: 0, max: 1 })).toBe(true);
    expect(inRange(0, { min: 0, max: 1, minExclusive: true })).toBe(false);
    expect(inRange(2, { min: 0, max: 1 })).toBe(false);
    expect(inRange(Number.NaN, { min: 0, max: 1 })).toBe(false);
  });
  it("矢印キーの結果を範囲に収める", () => {
    expect(clampToRange(105, { min: 0, max: 100 })).toBe(100);
    expect(clampToRange(-3, { min: 0, max: 100 })).toBe(0);
    expect(clampToRange(-3, { min: 0, max: 100, minExclusive: true })).toBeNull();
  });
});

describe("commonValue", () => {
  it("そろっていれば値、違えば混在", () => {
    expect(commonValue([1, 1])).toBe(1);
    expect(commonValue([1, 2])).toBe(MIXED);
    expect(commonValue([])).toBe(MIXED);
    expect(commonValue([{ a: 1 }, { a: 1 }], (a, b) => a.a === b.a)).toEqual({ a: 1 });
  });
});

describe("parseHexInput", () => {
  it("#RRGGBB の大文字にする", () => {
    expect(parseHexInput("#a1b2c3")).toBe("#A1B2C3");
    expect(parseHexInput("a1b2c3")).toBe("#A1B2C3");
    expect(parseHexInput("#abc")).toBe("#AABBCC");
    expect(parseHexInput("＃ＦＦ００００")).toBe("#FF0000");
  });
  it("読めなければ null", () => {
    for (const text of ["", "#12345", "#GGGGGG", "red", "#1234567"])
      expect(parseHexInput(text)).toBeNull();
  });
});

describe("clipName", () => {
  it("コードポイント数で切る", () => {
    expect(clipName("あいう", 2)).toBe("あい");
    expect(clipName("😀😀😀", 2)).toBe("😀😀");
    expect(clipName("abc", 5)).toBe("abc");
  });
});
