/**
 * 取り込んだ SVG の大きさ。v1 からの変換 (§3.7、Rust の `upgrade.rs` の `svg_size`) と同じ規則にする。
 *
 * - ルートの `width` / `height` 属性 (単位なしか `px`) が両方とも正ならその値
 * - なければ `viewBox` の幅と高さ (4 つの数を空白か、前後に空白を置いてよいカンマ 1 個で区切る)
 * - それもなければ 640 × 480
 * - 1 以上 `maxSize` 以下に収める
 */
import { CANVAS_LIMITS } from "../model/limits";

export const FALLBACK_SVG_SIZE = { width: 640, height: 480 } as const;

const ASCII_WHITESPACE = /[ \t\n\f\r]+/;

/** SVG の数の書式 (`[+-]? (数字+ (. 数字*)? | . 数字+) ([eE] [+-]? 数字+)?`) で、有限のものだけ。 */
const NUMBER = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

export function parseSvgNumber(token: string): number | null {
  if (!NUMBER.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

/** `width` / `height` 属性の値。単位なしか `px` の正の数だけ (`%` や `em` は読まない)。 */
export function parseSvgLength(value: string): number | null {
  let text = value.trim();
  if (text.length >= 2 && text.slice(-2).toLowerCase() === "px") text = text.slice(0, -2);
  const n = parseSvgNumber(text);
  return n !== null && n > 0 ? n : null;
}

/** `viewBox` の幅と高さ。どちらも正でなければ null。 */
export function parseViewBoxSize(value: string): { width: number; height: number } | null {
  const numbers: number[] = [];
  for (const segment of value.trim().split(",")) {
    const tokens = segment.split(ASCII_WHITESPACE).filter((token) => token.length > 0);
    if (tokens.length === 0) return null;
    for (const token of tokens) {
      const n = parseSvgNumber(token);
      if (n === null) return null;
      numbers.push(n);
    }
  }
  if (numbers.length !== 4) return null;
  const [, , width, height] = numbers as [number, number, number, number];
  return width > 0 && height > 0 ? { width, height } : null;
}

const clamp = (v: number) => Math.min(CANVAS_LIMITS.maxSize, Math.max(1, v));

/** ルートの属性から大きさを求める。 */
export function svgSizeFromAttributes(attributes: {
  width: string | null;
  height: string | null;
  viewBox: string | null;
}): { width: number; height: number } {
  const width = attributes.width === null ? null : parseSvgLength(attributes.width);
  const height = attributes.height === null ? null : parseSvgLength(attributes.height);
  const size =
    width !== null && height !== null
      ? { width, height }
      : ((attributes.viewBox === null ? null : parseViewBoxSize(attributes.viewBox)) ??
        FALLBACK_SVG_SIZE);
  return { width: clamp(size.width), height: clamp(size.height) };
}

/** SVG 文書の大きさ。読めなければ 640 × 480。 */
export function svgIntrinsicSize(svg: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  return svgSizeFromAttributes({
    width: root.getAttribute("width"),
    height: root.getAttribute("height"),
    viewBox: root.getAttribute("viewBox"),
  });
}
