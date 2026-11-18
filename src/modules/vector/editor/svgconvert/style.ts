/**
 * SVG の見た目の属性の求め方 (§4.17)。表示属性 (`fill="red"`) と `style` 属性 (`style="fill: red"`) を読み、
 * `style` を優先する。継承するもの (`INHERITED`) は親の値を引き継ぎ、`inherit` は親の値にする。
 * `<style>` 要素と `class` は SVG ポリシーが許さないので見ない (ポリシーが通した値だけを読む)。
 */
import { parseColor, parseLength, parseNumber, parseOpacity, type LengthContext } from "./values";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * 子の要素を順にたどる。`children` / `childNodes` の添字のたどり方はエンジンによって子の数の 2 乗の時間が
 * かかる (jsdom) ので、兄弟の参照でたどる。
 */
export function* childElements(element: Element): Generator<Element> {
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) yield child;
}

/** 子のノード (テキストを含む) を順にたどる。 */
export function* childNodes(node: Node): Generator<ChildNode> {
  for (let child = node.firstChild; child; child = child.nextSibling) yield child;
}

/** 自分と子孫の要素を、文書の順にたどる (再帰しない)。 */
export function* descendantElements(root: Element): Generator<Element> {
  let current: Element | null = root;
  while (current) {
    yield current;
    if (current.firstElementChild) {
      current = current.firstElementChild;
      continue;
    }
    while (current && current !== root && !current.nextElementSibling)
      current = current.parentElement;
    if (!current || current === root) break;
    current = current.nextElementSibling;
  }
}

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

/**
 * 見た目の属性の値の長さの上限。これより長い値は読めない値として扱う (信頼しない入力の巨大な値を、要素を
 * 展開するたびに読み直さないように)。
 */
export const MAX_STYLE_VALUE_LENGTH = 4096;

/** 要素自身に書かれた値 (`style` が表示属性より優先)。無ければ null。長すぎる値は無いものとして扱う。 */
export function ownValue(element: Element, name: string): string | null {
  const fromStyle = styleDeclarations(element).get(name);
  if (fromStyle !== undefined && fromStyle.length <= MAX_STYLE_VALUE_LENGTH) return fromStyle;
  const attr = element.getAttribute(name);
  if (attr === null || attr.length > MAX_STYLE_VALUE_LENGTH) return null;
  return attr.trim();
}

// ---------------------------------------------------------------------------
// 値の検証 (読めない値は宣言がないものとして扱う。CSS と同じく、継承した値を上書きしない)
// ---------------------------------------------------------------------------

const VALIDATION_CONTEXT: LengthContext = { viewport: { width: 100, height: 100 }, fontSize: 16 };

const isLength = (v: string) => parseLength(v, VALIDATION_CONTEXT) !== null;
const isColor = (v: string) => v.toLowerCase() === "currentcolor" || parseColor(v) !== null;
const oneOf =
  (...values: string[]) =>
  (v: string) =>
    values.includes(v.toLowerCase());

/** 塗り: `none`、`currentColor`、色、`url(#id)` と代わりの値 (`none` か色)。 */
export function isPaintValue(value: string): boolean {
  const v = value.trim();
  if (v.toLowerCase() === "none" || isColor(v)) return true;
  const reference = parseUrlReference(v);
  if (!reference) return false;
  return (
    reference.fallback === null ||
    reference.fallback.toLowerCase() === "none" ||
    isColor(reference.fallback)
  );
}

function isDashArray(value: string): boolean {
  if (value.toLowerCase() === "none") return true;
  const parts = value.trim().split(/[\s,]+/);
  return parts.every((part) => {
    const n = parseLength(part, VALIDATION_CONTEXT);
    return n !== null && n >= 0;
  });
}

function isFontSize(value: string): boolean {
  const v = value.toLowerCase();
  if (FONT_SIZE_KEYWORDS[v] !== undefined || v === "larger" || v === "smaller") return true;
  if (v.endsWith("%")) {
    const n = parseNumber(v.slice(0, -1));
    return n !== null && n >= 0;
  }
  const n = parseLength(v, VALIDATION_CONTEXT);
  return n !== null && n >= 0;
}

const VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  fill: isPaintValue,
  stroke: isPaintValue,
  "fill-opacity": (v) => parseOpacity(v) !== null,
  "stroke-opacity": (v) => parseOpacity(v) !== null,
  "fill-rule": oneOf("nonzero", "evenodd"),
  "stroke-width": (v) => {
    const n = parseLength(v, VALIDATION_CONTEXT);
    return n !== null && n >= 0;
  },
  "stroke-linecap": oneOf("butt", "round", "square"),
  "stroke-linejoin": oneOf("miter", "round", "bevel", "miter-clip", "arcs"),
  "stroke-dasharray": isDashArray,
  "stroke-dashoffset": isLength,
  "stroke-miterlimit": (v) => {
    const n = parseNumber(v);
    return n !== null && n >= 1;
  },
  color: isColor,
  "font-family": (v) => v.trim() !== "",
  "font-style": (v) => /^(normal|italic|oblique)\b/i.test(v.trim()),
  "font-weight": (v) => {
    if (/^(normal|bold|bolder|lighter)$/i.test(v.trim())) return true;
    const n = parseNumber(v);
    return n !== null && n >= 1 && n <= 1000;
  },
  "letter-spacing": (v) => v.toLowerCase() === "normal" || isLength(v),
  "text-anchor": oneOf("start", "middle", "end"),
  visibility: oneOf("visible", "hidden", "collapse"),
  "font-size": isFontSize,
};

/** 継承する属性の値として読めるか (`inherit` は読める)。検証のない属性は空でなければ読める。 */
export function isValidValue(name: string, value: string): boolean {
  if (value === "") return false;
  if (value.toLowerCase() === "inherit") return true;
  const validate = VALIDATORS[name];
  return validate ? validate(value) : true;
}

/** 要素自身の、読める値 (`style` が読めなければ表示属性)。 */
function ownValidValue(element: Element, name: string): string | null {
  const fromStyle = styleDeclarations(element).get(name);
  if (
    fromStyle !== undefined &&
    fromStyle.length <= MAX_STYLE_VALUE_LENGTH &&
    isValidValue(name, fromStyle)
  )
    return fromStyle;
  const attr = element.getAttribute(name)?.trim();
  if (attr === undefined || attr.length > MAX_STYLE_VALUE_LENGTH || !isValidValue(name, attr))
    return null;
  return attr;
}

const ownStyleCache = new WeakMap<Element, ReadonlyMap<string, string>>();

/** 要素自身に書かれた、継承する属性とフォントサイズの読める値 (要素ごとに 1 回だけ求める)。 */
function ownStyle(element: Element): ReadonlyMap<string, string> {
  const cached = ownStyleCache.get(element);
  if (cached) return cached;
  const result = new Map<string, string>();
  for (const name of [...INHERITED, "font-size"]) {
    const value = ownValidValue(element, name);
    if (value !== null) result.set(name, value);
  }
  ownStyleCache.set(element, result);
  return result;
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
  const own = ownStyle(element);
  let values: Record<string, string> | null = null;
  for (const [name, value] of own) {
    if (name === "font-size" || value.toLowerCase() === "inherit") continue;
    values ??= { ...parent.values };
    values[name] = value;
  }
  const fontSize = resolveFontSize(own.get("font-size") ?? null, parent.fontSize, context);
  if (values === null && fontSize === parent.fontSize) return parent;
  return { values: values ?? parent.values, fontSize };
}

/** 継承しない属性 (`opacity`、`display`、`clip-path` など) の値。`inherit` は親の要素の値。 */
export function nonInheritedValue(element: Element, name: string): string | null {
  for (let e: Element | null = element; e; e = e.parentElement) {
    const own = ownValue(e, name);
    if (own === null || own.toLowerCase() !== "inherit") return own;
  }
  return null;
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
