/**
 * 色空間変換ユーティリティ (`docs/ui-design.md` §6.5 K-2)。
 *
 * HEX を canonical (`data-model.md` §10.4) として、RGB / HSL / OKLCH の表記文字列
 * との相互変換を提供する。
 *
 * 各 `parseXxx(input)` は **入力文字列を受けて canonical HEX (6 桁、`#RRGGBB`、
 * 大文字)** を返す。パース失敗時は `null`。alpha は Phase 1 では扱わない (K-2 拡張
 * 余地として将来検討、`data-model.md` §10.4 では `#RRGGBBAA` も許容)。
 *
 * 各 `formatXxx(hex)` は HEX 6 桁を受けて表示用文字列を返す。culori 経由なので
 * sRGB <-> OKLab 変換は CSS Color 4 仕様に準拠 (https://drafts.csswg.org/css-color-4/)。
 */
import { converter, formatHex, parse } from "culori";

const toHsl = converter("hsl");
const toOklch = converter("oklch");
const toRgb = converter("rgb");

/** HEX 6 桁 (`#RRGGBB`、大文字) の正規表現 */
const HEX6_REGEX = /^#[0-9A-Fa-f]{6}$/;
/** HEX 8 桁 (`#RRGGBBAA`、alpha 付き) の正規表現 */
const HEX8_REGEX = /^#[0-9A-Fa-f]{8}$/;

/**
 * 表示用の hex 入力を扱う際、`#RRGGBBAA` (8 桁) を `#RRGGBB` に正規化する。
 * format 関数で「保存値が 8 桁でも RGB / HSL / OKLCH 表示は alpha を無視して
 * 計算する」ために使う。
 */
function strip6(hex: string): string {
  if (HEX8_REGEX.test(hex)) return hex.slice(0, 7);
  return hex;
}

/**
 * `#RRGGBB` または `#RRGGBBAA` の妥当な hex 文字列か判定する。`data-model.md` §10.4
 * で許容される backend 仕様と一致 (8 桁 alpha も valid 扱い)。
 */
export function isValidStorableHex(hex: string): boolean {
  return HEX6_REGEX.test(hex) || HEX8_REGEX.test(hex);
}

/** culori の `Color` 型を完全な hex (6 桁) に正規化。alpha がある場合は drop */
function colorToHex6(color: ReturnType<typeof parse>): string | null {
  if (color == null) return null;
  // formatHex は 8 桁 (alpha 付き) を返す場合があるので 6 桁に切り詰め (alpha drop)
  const hex = formatHex(color);
  if (hex == null) return null;
  if (hex.length === 9) {
    // `#RRGGBBAA` → `#RRGGBB`
    return hex.slice(0, 7).toUpperCase();
  }
  if (hex.length === 7) {
    return hex.toUpperCase();
  }
  return null;
}

// -------- parse: 入力 → canonical HEX --------

/** `#RRGGBB` または `#RGB` (3 桁短縮形は culori が展開) を受ける */
export function parseHexInput(input: string): string | null {
  return colorToHex6(parse(input.trim()));
}

/** `rgb(R, G, B)` / `R, G, B` / `R G B` / カンマ区切り 0-255 数値 3 つを受ける */
export function parseRgbInput(input: string): string | null {
  const trimmed = input.trim();
  // CSS 関数表記 (`rgb(...)`) は culori が直接受ける
  if (trimmed.startsWith("rgb")) {
    return colorToHex6(parse(trimmed));
  }
  // カンマ / 空白区切りの 3 数値を試す
  const parts = trimmed.split(/[,\s]+/).filter((s) => s.length > 0);
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return colorToHex6({ mode: "rgb", r: nums[0]! / 255, g: nums[1]! / 255, b: nums[2]! / 255 });
}

/** `hsl(H, S%, L%)` / `H, S, L` / `H S% L%` を受ける (S/L は 0-100) */
export function parseHslInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("hsl")) {
    return colorToHex6(parse(trimmed));
  }
  // カンマ / 空白区切りの 3 数値: H 0-360°, S 0-100%, L 0-100%
  const parts = trimmed.split(/[,\s]+/).filter((s) => s.length > 0);
  if (parts.length !== 3) return null;
  const h = Number(parts[0]);
  const s = Number(String(parts[1]).replace(/%$/, ""));
  const l = Number(String(parts[2]).replace(/%$/, ""));
  if ([h, s, l].some((n) => !Number.isFinite(n))) return null;
  if (h < 0 || h > 360 || s < 0 || s > 100 || l < 0 || l > 100) return null;
  return colorToHex6({ mode: "hsl", h, s: s / 100, l: l / 100 });
}

/** `oklch(L C H)` / `L C H` (L 0-1 か 0-100%、C 0-0.4 程度、H 0-360°) を受ける */
export function parseOklchInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("oklch")) {
    return colorToHex6(parse(trimmed));
  }
  // 空白 / カンマ区切りの 3 数値: L (0-1 or 0-100%), C (0-0.4), H (0-360°)
  const parts = trimmed.split(/[,\s]+/).filter((s) => s.length > 0);
  if (parts.length !== 3) return null;
  const lRaw = String(parts[0]);
  const lNum = Number(lRaw.replace(/%$/, ""));
  const c = Number(parts[1]);
  const h = Number(parts[2]);
  if ([lNum, c, h].some((n) => !Number.isFinite(n))) return null;
  // % 表記は 0-100 → 0-1 に正規化、それ以外は 0-1 想定
  const l = lRaw.endsWith("%") ? lNum / 100 : lNum;
  if (l < 0 || l > 1 || c < 0 || c > 1 || h < 0 || h > 360) return null;
  return colorToHex6({ mode: "oklch", l, c, h });
}

// -------- format: canonical HEX → 表示文字列 --------

/** HEX を `#RRGGBB` (大文字) として返す。8 桁 (`#RRGGBBAA`) はそのまま大文字化。
 * invalid なら入力をそのまま返す (UI 側の error 表示は呼び出し側責務) */
export function formatHexDisplay(hex: string): string {
  if (HEX6_REGEX.test(hex) || HEX8_REGEX.test(hex)) return hex.toUpperCase();
  return hex;
}

/** HEX → `R, G, B` (各 0-255 整数)。8 桁 alpha は無視 (RGB 表示には影響しない) */
export function formatRgbDisplay(hex: string): string {
  const stripped = strip6(hex);
  if (!HEX6_REGEX.test(stripped)) return "";
  const c = toRgb(parse(stripped));
  if (c == null) return "";
  return `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`;
}

/** HEX → `H, S%, L%` (H 0-360 整数、S/L 0-100 整数)。8 桁 alpha は無視 */
export function formatHslDisplay(hex: string): string {
  const stripped = strip6(hex);
  if (!HEX6_REGEX.test(stripped)) return "";
  const c = toHsl(parse(stripped));
  if (c == null) return "";
  const h = Math.round(c.h ?? 0);
  const s = Math.round(c.s * 100);
  const l = Math.round(c.l * 100);
  return `${h}, ${s}%, ${l}%`;
}

/** HEX → `L C H` (L 0-1 を 3 桁、C 0-0.4 を 3 桁、H 0-360 整数)。8 桁 alpha は無視 */
export function formatOklchDisplay(hex: string): string {
  const stripped = strip6(hex);
  if (!HEX6_REGEX.test(stripped)) return "";
  const c = toOklch(parse(stripped));
  if (c == null) return "";
  const l = c.l.toFixed(3);
  const chr = c.c.toFixed(3);
  const h = (c.h ?? 0).toFixed(0);
  return `${l} ${chr} ${h}`;
}
