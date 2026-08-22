import { converter, formatHex, parse, wcagContrast } from "culori";

const toRgb = converter("rgb");

export interface ContrastResult {
  foreground: string;
  background: string;
  ratio: number;
  normalAA: boolean;
  normalAAA: boolean;
  largeAA: boolean;
  largeAAA: boolean;
  nonTextAA: boolean;
  simulations: Record<
    "protanopia" | "deuteranopia" | "tritanopia",
    { foreground: string; background: string }
  >;
}

const matrices = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const;

export function evaluateContrast(foregroundInput: string, backgroundInput: string): ContrastResult {
  const foreground = parseOpaque(foregroundInput, "前景色");
  const background = parseOpaque(backgroundInput, "背景色");
  const foregroundHex = formatHex(foreground)!.toUpperCase();
  const backgroundHex = formatHex(background)!.toUpperCase();
  const ratio = wcagContrast(foreground, background);
  return {
    foreground: foregroundHex,
    background: backgroundHex,
    ratio,
    normalAA: ratio >= 4.5,
    normalAAA: ratio >= 7,
    largeAA: ratio >= 3,
    largeAAA: ratio >= 4.5,
    nonTextAA: ratio >= 3,
    simulations: Object.fromEntries(
      (Object.keys(matrices) as (keyof typeof matrices)[]).map((kind) => [
        kind,
        {
          foreground: simulateColor(foregroundHex, kind),
          background: simulateColor(backgroundHex, kind),
        },
      ]),
    ) as ContrastResult["simulations"],
  };
}

function parseOpaque(input: string, label: string) {
  const color = parse(input.trim());
  if (color == null) throw new Error(`${label}をCSS colorとして解釈できません`);
  if ("alpha" in color && color.alpha != null && color.alpha < 1)
    throw new Error(`${label}は不透明色にしてください`);
  return color;
}

function simulateColor(input: string, kind: keyof typeof matrices): string {
  const color = toRgb(input);
  if (color == null) throw new Error("色変換に失敗しました");
  const linear = [toLinear(color.r), toLinear(color.g), toLinear(color.b)];
  const transformed = matrices[kind].map((row) =>
    clamp(row.reduce((sum, coefficient, index) => sum + coefficient * linear[index]!, 0)),
  );
  return formatHex({
    mode: "rgb",
    r: toGamma(transformed[0]!),
    g: toGamma(transformed[1]!),
    b: toGamma(transformed[2]!),
  })!.toUpperCase();
}

function toLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function toGamma(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
