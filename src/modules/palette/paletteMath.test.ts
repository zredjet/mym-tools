import { describe, expect, it } from "vitest";

import type { HarmonyRule, PaletteColors } from "@/lib/types";

import {
  HARMONY_RULES,
  generateHarmony,
  hexToHsv,
  moveIndex,
  randomizePalette,
  reorderColors,
  updateHarmonyColor,
} from "./paletteMath";

const COLORS: PaletteColors = ["#111111", "#222222", "#333333", "#444444", "#555555"];

describe("palette harmony engine", () => {
  it.each(HARMONY_RULES)("generates five canonical colors for %s", (harmony) => {
    const colors = generateHarmony("#3B82F6", harmony, 2);
    expect(colors).toHaveLength(5);
    for (const color of colors) expect(color).toMatch(/^#[0-9A-F]{6}$/);
    expect(colors[2]).toBe("#3B82F6");
  });

  it("uses the requested base position", () => {
    expect(generateHarmony("#FF0000", "analogous", 4)[4]).toBe("#FF0000");
  });

  it("uses standard hue relationships", () => {
    const complementary = generateHarmony("#FF0000", "complementary", 2);
    expect(hexToHsv(complementary[3]).h).toBeCloseTo(180, 0);
    const triad = generateHarmony("#FF0000", "triad", 2);
    expect(hexToHsv(triad[3]).h).toBeCloseTo(120, 0);
  });

  it("preserves locked colors while updating a harmony", () => {
    const initial = generateHarmony("#3B82F6", "analogous", 2);
    const next = updateHarmonyColor(initial, 2, "#FF0000", "analogous", 2, [
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(next[0]).toBe(initial[0]);
    expect(next[2]).toBe("#FF0000");
  });

  it("randomizes only unlocked custom colors", () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    let index = 0;
    const next = randomizePalette(
      COLORS,
      "custom",
      2,
      [true, false, true, false, true],
      () => values[index++ % values.length]!,
    );
    expect(next[0]).toBe(COLORS[0]);
    expect(next[2]).toBe(COLORS[2]);
    expect(next[4]).toBe(COLORS[4]);
    expect(next[1]).not.toBe(COLORS[1]);
    expect(next[3]).not.toBe(COLORS[3]);
  });

  it("reorders colors and tracks moved indices", () => {
    expect(reorderColors(COLORS, 1, 4)).toEqual([
      "#111111",
      "#333333",
      "#444444",
      "#555555",
      "#222222",
    ]);
    expect(moveIndex(1, 1, 4)).toBe(4);
    expect(moveIndex(3, 1, 4)).toBe(2);
  });

  it("covers every persisted rule", () => {
    const expected: HarmonyRule[] = [
      "custom",
      "analogous",
      "complementary",
      "split_complementary",
      "triad",
      "square",
      "compound",
      "shades",
      "monochromatic",
    ];
    expect(HARMONY_RULES).toEqual(expected);
  });
});
