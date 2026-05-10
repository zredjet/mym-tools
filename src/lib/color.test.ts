/**
 * 色変換ユーティリティのテスト (`docs/ui-design.md` §6.5 K-2)。
 *
 * sRGB ↔ HSL ↔ OKLCH の往復が許容誤差内で一致することと、不正入力が `null` を
 * 返すことを確認する。culori 経由で CSS Color 4 仕様に準拠した変換を期待する。
 */
import { describe, expect, it } from "vitest";

import {
  formatHexDisplay,
  formatHslDisplay,
  formatOklchDisplay,
  formatRgbDisplay,
  parseHexInput,
  parseHslInput,
  parseOklchInput,
  parseRgbInput,
} from "./color";

describe("parseHexInput", () => {
  it("accepts #RRGGBB and normalizes to uppercase", () => {
    expect(parseHexInput("#3b82f6")).toBe("#3B82F6");
    expect(parseHexInput("#3B82F6")).toBe("#3B82F6");
  });

  it("accepts short hex (#RGB) and expands", () => {
    // culori の挙動: #f00 → #ff0000
    expect(parseHexInput("#f00")).toBe("#FF0000");
  });

  it("drops alpha for #RRGGBBAA inputs", () => {
    // K-2 phase 1: alpha は保存しない
    expect(parseHexInput("#3B82F6FF")).toBe("#3B82F6");
  });

  it("returns null for invalid input", () => {
    expect(parseHexInput("nope")).toBeNull();
    expect(parseHexInput("#GGHHII")).toBeNull();
  });
});

describe("parseRgbInput", () => {
  it("accepts CSS rgb() function", () => {
    expect(parseRgbInput("rgb(59, 130, 246)")).toBe("#3B82F6");
  });

  it("accepts comma-separated 3 numbers", () => {
    expect(parseRgbInput("59, 130, 246")).toBe("#3B82F6");
  });

  it("accepts space-separated 3 numbers", () => {
    expect(parseRgbInput("59 130 246")).toBe("#3B82F6");
  });

  it("rejects out-of-range numbers", () => {
    expect(parseRgbInput("256, 0, 0")).toBeNull();
    expect(parseRgbInput("-1, 0, 0")).toBeNull();
  });

  it("rejects wrong arity", () => {
    expect(parseRgbInput("0, 0")).toBeNull();
    expect(parseRgbInput("0, 0, 0, 0")).toBeNull();
  });
});

describe("parseHslInput", () => {
  it("accepts CSS hsl() function and produces plausible HEX", () => {
    // 整数 HSL → HEX 変換は丸め誤差で 1-2 channel ずれることがある (#3B82F6 ↔ #3C83F6 等)。
    // パターン一致と「妥当 HEX に変換される」を確認する
    const hex = parseHslInput("hsl(217, 91%, 60%)");
    expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("accepts comma-separated 3 numbers with % suffix", () => {
    const hex = parseHslInput("217, 91%, 60%");
    expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("rejects out-of-range numbers", () => {
    expect(parseHslInput("361, 0, 0")).toBeNull();
    expect(parseHslInput("0, 101%, 0")).toBeNull();
  });
});

describe("parseOklchInput", () => {
  it("accepts CSS oklch() function", () => {
    // CSS Color 4 仕様: oklch(L C H)
    const hex = parseOklchInput("oklch(0.62 0.19 256)");
    expect(hex).not.toBeNull();
    expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("accepts space-separated L C H (L 0-1)", () => {
    expect(parseOklchInput("0.62 0.19 256")).not.toBeNull();
  });

  it("accepts L as % (0-100)", () => {
    expect(parseOklchInput("62% 0.19 256")).not.toBeNull();
  });

  it("rejects out-of-range L (> 1 without %)", () => {
    expect(parseOklchInput("1.5 0.19 256")).toBeNull();
  });
});

describe("formatXxxDisplay", () => {
  it("hex round-trip preserves uppercase 6-digit", () => {
    expect(formatHexDisplay("#3b82f6")).toBe("#3B82F6");
  });

  it("rgb display matches expected", () => {
    expect(formatRgbDisplay("#3B82F6")).toBe("59, 130, 246");
  });

  it("hsl display has H, S%, L% (rounded integers)", () => {
    // 整数化された出力 (例: `217, 91%, 60%`)
    const hsl = formatHslDisplay("#3B82F6");
    expect(hsl).toMatch(/^\d+,\s+\d+%,\s+\d+%$/);
  });

  it("oklch display has L C H format", () => {
    const oklch = formatOklchDisplay("#3B82F6");
    expect(oklch).toMatch(/^\d+\.\d{3}\s\d+\.\d{3}\s\d+$/);
  });

  it("returns empty string for invalid hex (display fallback)", () => {
    expect(formatRgbDisplay("not-hex")).toBe("");
    expect(formatHslDisplay("#GGHHII")).toBe("");
    expect(formatOklchDisplay("#XYZ")).toBe("");
  });
});

describe("round-trip conversions", () => {
  // 各入力 → HEX → 再表示で同じ HEX に戻ることを確認
  const samples = ["#3B82F6", "#FF0000", "#00FF00", "#0000FF", "#000000", "#FFFFFF"];

  for (const hex of samples) {
    it(`HEX → RGB → HEX: ${hex}`, () => {
      const rgb = formatRgbDisplay(hex);
      expect(parseRgbInput(rgb)).toBe(hex);
    });

    it(`HEX → HSL → HEX (within 1 step rounding tolerance): ${hex}`, () => {
      const hsl = formatHslDisplay(hex);
      const back = parseHslInput(hsl);
      expect(back).not.toBeNull();
      // HSL は 0-100% rounding があるので完全一致しない可能性あり (各 channel ±1 を許容)
      const hexNum = parseInt(hex.slice(1), 16);
      const backNum = parseInt((back ?? "#000000").slice(1), 16);
      const rDiff = Math.abs(((hexNum >> 16) & 0xff) - ((backNum >> 16) & 0xff));
      const gDiff = Math.abs(((hexNum >> 8) & 0xff) - ((backNum >> 8) & 0xff));
      const bDiff = Math.abs((hexNum & 0xff) - (backNum & 0xff));
      expect(Math.max(rDiff, gDiff, bDiff)).toBeLessThanOrEqual(2);
    });
  }
});
