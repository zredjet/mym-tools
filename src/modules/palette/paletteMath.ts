import { converter, formatHex } from "culori";

import type { HarmonyRule, PaletteColors, PaletteIndex } from "@/lib/types";

export const HARMONY_RULES: readonly HarmonyRule[] = [
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

export const HARMONY_LABELS: Record<HarmonyRule, string> = {
  custom: "カスタム",
  analogous: "類似色",
  complementary: "補色",
  split_complementary: "分裂補色",
  triad: "トライアド",
  square: "スクエア",
  compound: "コンパウンド",
  shades: "シェード",
  monochromatic: "モノクロマティック",
};

interface RecipeEntry {
  hue: number;
  saturation: number;
  value: number;
}

type Recipe = readonly [RecipeEntry, RecipeEntry, RecipeEntry, RecipeEntry, RecipeEntry];

const SAME = { hue: 0, saturation: 0, value: 0 } as const;

/** index 2 が基準色。残りは基準 HSV に対する相対差分。 */
const RECIPES: Record<Exclude<HarmonyRule, "custom">, Recipe> = {
  analogous: [
    { hue: -40, saturation: 0, value: -0.08 },
    { hue: -20, saturation: -0.06, value: 0.08 },
    SAME,
    { hue: 20, saturation: -0.04, value: 0.1 },
    { hue: 40, saturation: 0.04, value: -0.08 },
  ],
  complementary: [
    { hue: 0, saturation: -0.2, value: 0.18 },
    { hue: 0, saturation: 0.04, value: -0.2 },
    SAME,
    { hue: 180, saturation: -0.08, value: 0.12 },
    { hue: 180, saturation: 0.04, value: -0.16 },
  ],
  split_complementary: [
    { hue: -150, saturation: 0, value: -0.12 },
    { hue: -150, saturation: -0.1, value: 0.12 },
    SAME,
    { hue: 150, saturation: -0.08, value: 0.12 },
    { hue: 150, saturation: 0.02, value: -0.12 },
  ],
  triad: [
    { hue: -120, saturation: 0.02, value: -0.14 },
    { hue: -120, saturation: -0.12, value: 0.12 },
    SAME,
    { hue: 120, saturation: -0.1, value: 0.12 },
    { hue: 120, saturation: 0.02, value: -0.14 },
  ],
  square: [
    { hue: -90, saturation: -0.04, value: 0.06 },
    { hue: 90, saturation: 0, value: -0.08 },
    SAME,
    { hue: 180, saturation: -0.06, value: 0.08 },
    { hue: 0, saturation: -0.28, value: 0.2 },
  ],
  compound: [
    { hue: -150, saturation: -0.04, value: -0.1 },
    { hue: -30, saturation: -0.08, value: 0.1 },
    SAME,
    { hue: 30, saturation: -0.08, value: 0.1 },
    { hue: 150, saturation: 0.02, value: -0.1 },
  ],
  shades: [
    { hue: 0, saturation: 0, value: -0.36 },
    { hue: 0, saturation: 0, value: -0.18 },
    SAME,
    { hue: 0, saturation: 0, value: 0.12 },
    { hue: 0, saturation: 0, value: 0.24 },
  ],
  monochromatic: [
    { hue: 0, saturation: -0.34, value: 0.22 },
    { hue: 0, saturation: -0.16, value: 0.1 },
    SAME,
    { hue: 0, saturation: 0.08, value: -0.12 },
    { hue: 0, saturation: 0.16, value: -0.28 },
  ],
};

const toHsv = converter("hsv");

interface Hsv {
  h: number;
  s: number;
  v: number;
}

export function generateHarmony(
  baseHex: string,
  harmony: HarmonyRule,
  baseIndex: PaletteIndex,
): PaletteColors {
  const base = hexToHsv(baseHex);
  if (harmony === "custom") return tupleOf(baseHex.toUpperCase());
  const recipe = RECIPES[harmony];
  const output = tupleOf(baseHex.toUpperCase());
  for (let relative = 0; relative < 5; relative += 1) {
    const target = modulo(baseIndex + relative - 2, 5) as PaletteIndex;
    output[target] = applyRecipe(base, recipe[relative]!);
  }
  return output;
}

export function updateHarmonyColor(
  colors: PaletteColors,
  changedIndex: PaletteIndex,
  nextHex: string,
  harmony: HarmonyRule,
  baseIndex: PaletteIndex,
  locked: readonly boolean[],
): PaletteColors {
  const normalized = nextHex.toUpperCase();
  if (harmony === "custom") {
    const next = [...colors] as PaletteColors;
    if (!locked[changedIndex]) next[changedIndex] = normalized;
    return next;
  }

  const relative = modulo(changedIndex - baseIndex + 2, 5);
  const entry = RECIPES[harmony][relative]!;
  const changed = hexToHsv(normalized);
  const inferredBase: Hsv = {
    h: normalizeHue(changed.h - entry.hue),
    s: clamp01(changed.s - entry.saturation),
    v: clamp01(changed.v - entry.value),
  };
  const generated = generateHarmony(hsvToHex(inferredBase), harmony, baseIndex);
  return generated.map((color, index) => (locked[index] ? colors[index]! : color)) as PaletteColors;
}

export function randomizePalette(
  colors: PaletteColors,
  harmony: HarmonyRule,
  baseIndex: PaletteIndex,
  locked: readonly boolean[],
  random: () => number = Math.random,
): PaletteColors {
  if (harmony === "custom") {
    return colors.map((color, index) =>
      locked[index]
        ? color
        : hsvToHex({ h: random() * 360, s: 0.45 + random() * 0.5, v: 0.58 + random() * 0.4 }),
    ) as PaletteColors;
  }
  const baseHex = locked[baseIndex]
    ? colors[baseIndex]
    : hsvToHex({ h: random() * 360, s: 0.5 + random() * 0.42, v: 0.62 + random() * 0.35 });
  const generated = generateHarmony(baseHex, harmony, baseIndex);
  return generated.map((color, index) => (locked[index] ? colors[index]! : color)) as PaletteColors;
}

export function reorderColors(
  colors: PaletteColors,
  from: PaletteIndex,
  to: PaletteIndex,
): PaletteColors {
  const next = [...colors];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next as PaletteColors;
}

export function moveIndex(index: PaletteIndex, from: PaletteIndex, to: PaletteIndex): PaletteIndex {
  const indices = [0, 1, 2, 3, 4] as PaletteIndex[];
  const [moved] = indices.splice(from, 1);
  indices.splice(to, 0, moved!);
  return indices.indexOf(index) as PaletteIndex;
}

export function hexToHsv(hex: string): Hsv {
  const color = toHsv(hex);
  if (color == null) return { h: 0, s: 0, v: 0 };
  return { h: normalizeHue(color.h ?? 0), s: clamp01(color.s), v: clamp01(color.v) };
}

export function hsvToHex(color: Hsv): string {
  const value = formatHex({
    mode: "hsv",
    h: normalizeHue(color.h),
    s: clamp01(color.s),
    v: clamp01(color.v),
  });
  return (value ?? "#000000").slice(0, 7).toUpperCase();
}

function applyRecipe(base: Hsv, entry: RecipeEntry): string {
  return hsvToHex({
    h: base.h + entry.hue,
    s: base.s + entry.saturation,
    v: base.v + entry.value,
  });
}

function tupleOf(value: string): PaletteColors {
  return [value, value, value, value, value];
}

function normalizeHue(value: number): number {
  return modulo(value, 360);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
