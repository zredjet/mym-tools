/**
 * SVG の見た目の属性の求め方 (§8.12)。表示属性 (`fill="red"`) と `style` 属性 (`style="fill: red"`) を読み、
 * `style` を優先する。継承するもの (`INHERITED`) は親の値を引き継ぎ、`inherit` は親の値にする。
 * `<style>` 要素と `class` は SVG ポリシーが許さないので見ない (ポリシーが通した値だけを読む)。
 */
import { parseLength, parseNumber, type LengthContext } from "./values";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

/** 継承する属性と初期値。 */
const INHERITED_INITIAL: Readonly<Record<string, string>> = {
  fill: "black",
  "fill-opacity": "1",
  "fill-rule": "nonzero",
  stroke: "none",
  "stroke-width": "1",
  "stroke-opacity": "1",
  "stroke-linecap": "butt",
  "stroke-linejoin": "miter",
  "stroke-dasharray": "none",
  "stroke-dashoffset": "0",
  "stroke-miterlimit": "4",
  color: "black",
  "font-family": "serif",
  "font-style": "normal",
  "font-weight": "normal",
  "letter-spacing": "normal",
  "text-anchor": "start",
  visibility: "visible",
  "marker-start": "none",
  "marker-mid": "none",
  "marker-end": "none",
  "paint-order": "normal",
};

const INHERITED = Object.keys(INHERITED_INITIAL);

/** 既定のフォントサイズ (px。CSS の medium)。 */
export const DEFAULT_FONT_SIZE = 16;

export interface ComputedStyle {
  /** 継承する属性の値 (文字列のまま) */
  readonly values: Readonly<Record<string, string>>;
  /** フォントサイズ (px。em と % は解決済み) */
  readonly fontSize: number;
}

export const INITIAL_STYLE: ComputedStyle = {
  values: INHERITED_INITIAL,
  fontSize: DEFAULT_FONT_SIZE,
};

const declarationsCache = new WeakMap<Element, ReadonlyMap<string, string>>();

/** `style` 属性の宣言 (名前は小文字。`!important` は落とす)。 */
function styleDeclarations(element: Element): ReadonlyMap<string, string> {
  const cached = declarationsCache.get(element);
  if (cached) return cached;
  const result = new Map<string, string>();
  const style = element.getAttribute("style");
  if (style)
    for (const declaration of style.split(";")) {
      const split = declaration.indexOf(":");
      if (split < 0) continue;
      const name = declaration.slice(0, split).trim().toLowerCase();
      const value = declaration
        .slice(split + 1)
        .replace(/!\s*important\s*$/i, "")
        .trim();
      if (name && value) result.set(name, value);
    }
  declarationsCache.set(element, result);
  return result;
}

/** 要素自身に書かれた値 (`style` が表示属性より優先)。無ければ null。 */
export function ownValue(element: Element, name: string): string | null {
  const fromStyle = styleDeclarations(element).get(name);
  if (fromStyle !== undefined) return fromStyle;
  const attr = element.getAttribute(name);
  return attr === null ? null : attr.trim();
}

const FONT_SIZE_KEYWORDS: Readonly<Record<string, number>> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
  "xxx-large": 48,
};

function resolveFontSize(value: string | null, parent: number, context: LengthContext): number {
  if (value === null || value === "inherit") return parent;
  const v = value.toLowerCase();
  const keyword = FONT_SIZE_KEYWORDS[v];
  if (keyword !== undefined) return keyword;
  if (v === "larger") return parent * 1.2;
  if (v === "smaller") return parent / 1.2;
  if (v.endsWith("%")) {
    const n = parseNumber(v.slice(0, -1));
    return n === null || n < 0 ? parent : (parent * n) / 100;
  }
  const length = parseLength(v, { ...context, fontSize: parent });
  return length === null || length < 0 ? parent : length;
}

/** 要素の継承する属性を求める。 */
export function computeStyle(
  element: Element,
  parent: ComputedStyle,
  context: LengthContext,
): ComputedStyle {
  let values: Record<string, string> | null = null;
  for (const name of INHERITED) {
    const own = ownValue(element, name);
    if (own === null || own === "" || own.toLowerCase() === "inherit") continue;
    values ??= { ...parent.values };
    values[name] = own;
  }
  const fontSize = resolveFontSize(ownValue(element, "font-size"), parent.fontSize, context);
  if (values === null && fontSize === parent.fontSize) return parent;
  return { values: values ?? parent.values, fontSize };
}

/** 継承しない属性 (`opacity`、`display`、`clip-path` など) の値。`inherit` は親の要素の値。 */
export function nonInheritedValue(element: Element, name: string): string | null {
  const own = ownValue(element, name);
  if (own === null || own.toLowerCase() !== "inherit") return own;
  const parent = element.parentElement;
  return parent ? nonInheritedValue(parent, name) : null;
}

/** `href` (SVG 2) か `xlink:href` の参照先の ID。`#id` の形でなければ null。 */
export function hrefTarget(element: Element): string | null {
  const value = element.getAttribute("href") ?? element.getAttributeNS(XLINK_NS, "href");
  if (value === null) return null;
  const match = /^#(.+)$/.exec(value.trim());
  return match ? (match[1] as string) : null;
}

/** `url(#id)` の ID と、続く代わりの値 (`url(#g) red` の `red`)。`url(...)` でなければ null。 */
export function parseUrlReference(value: string): { id: string; fallback: string | null } | null {
  const match = /^url\(\s*(['"]?)#([^'")]+)\1\s*\)\s*(.*)$/is.exec(value.trim());
  if (!match) return null;
  const fallback = (match[3] as string).trim();
  return { id: (match[2] as string).trim(), fallback: fallback === "" ? null : fallback };
}
