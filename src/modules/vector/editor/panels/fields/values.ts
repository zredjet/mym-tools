/**
 * パネルの入力欄で使う値の扱い (純関数)。
 * - 数値の入力の解釈と表示 (全角の数字・マイナスも受け付ける)
 * - 複数選択の「混在」
 * - `#RRGGBB` の入力の解釈
 */

/** 複数選択で値がそろっていないことを表す。 */
export const MIXED = "mixed" as const;
export type Mixed = typeof MIXED;

/** すべて等しければその値、違えば `MIXED`。空なら `MIXED`。 */
export function commonValue<T>(
  values: readonly T[],
  equal: (a: T, b: T) => boolean = Object.is,
): T | Mixed {
  if (values.length === 0) return MIXED;
  const first = values[0] as T;
  return values.every((value) => equal(value, first)) ? first : MIXED;
}

const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * 数値の入力を解釈する。全角の数字・符号・小数点は NFKC で半角にし、
 * 数学のマイナス (U+2212) と長音記号もマイナスとして読む。数値でなければ null。
 */
export function parseNumberInput(text: string): number | null {
  const normalized = text
    .normalize("NFKC")
    .trim()
    .replace(/^[−ーｰ]/, "-");
  if (!NUMBER_TEXT.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** 小数点以下 `precision` 桁に丸める。`-0` は `0` にする。 */
export function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** 表示用の文字列。小数点以下 `precision` 桁までで、末尾の 0 は付けない。 */
export function formatNumber(value: number, precision: number): string {
  return String(roundTo(value, precision));
}

export interface NumberRange {
  min: number;
  max: number;
  /** true なら `min` ちょうどは範囲外 (線の太さ、グラデーションの半径) */
  minExclusive?: boolean;
}

export function inRange(value: number, range: NumberRange): boolean {
  if (!Number.isFinite(value)) return false;
  if (range.minExclusive ? value <= range.min : value < range.min) return false;
  return value <= range.max;
}

/** 矢印キーで動かした値を範囲に収める。収められなければ null。 */
export function clampToRange(value: number, range: NumberRange): number | null {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return inRange(clamped, range) ? clamped : null;
}

/**
 * 色の入力を `#RRGGBB` (大文字) にする。`#` は省略可、3 桁の短縮形も受け付ける。
 * それ以外は null。
 */
export function parseHexInput(text: string): string | null {
  const body = text.normalize("NFKC").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(body)) return `#${body.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(body))
    return `#${[...body].map((c) => c + c).join("")}`.toUpperCase();
  return null;
}

/** 名前を `max` 文字 (コードポイント数) までに切る。 */
export function clipName(name: string, max: number): string {
  const chars = Array.from(name);
  return chars.length <= max ? name : chars.slice(0, max).join("");
}

/** 不透明度などの割合を % で出す欄の範囲。 */
export const PERCENT: NumberRange = { min: 0, max: 100 };

/** 0〜1 の値を % にする (「混在」はそのまま)。 */
export function toPercent(value: number | Mixed): number | Mixed {
  return value === MIXED ? MIXED : value * 100;
}

/** % を 0〜1 にする。浮動小数の端数を落とす。 */
export function fromPercent(value: number): number {
  return Math.round(value * 100) / 10000;
}
