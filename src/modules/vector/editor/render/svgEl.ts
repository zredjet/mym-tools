/**
 * `SvgEl` (SVG 要素の素朴な木) を作る補助と、React 要素・文字列への出力 (§4.3)。
 * 画面と SVG 書き出しは同じ木からこの 2 つの関数で作る。描画の規則は `buildNodeSvg.ts` にだけ書く。
 */
import { createElement, Fragment, type ReactNode } from "react";
import type { SvgEl } from "./types";

export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 子の差し込み位置を表す要素のタグ。`buildNodeShell` は frame / group の子をここに置かずに返し、
 * 呼び出し側が子を差し込む (`fillSlot` で `SvgEl` を、`svgElToReact` の `slot` で React 要素を)。
 * 文字列や React へそのまま出すことはない。
 */
export const CHILDREN_SLOT = "#children";

/** `SvgEl` を作る。`undefined` の属性は捨てる。 */
export function el(
  tag: string,
  attrs: Record<string, string | number | undefined> = {},
  children: (SvgEl | string)[] = [],
): SvgEl {
  const clean: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) clean[name] = value;
  return { tag, attrs: clean, children };
}

export function isSvgEl(value: SvgEl | string): value is SvgEl {
  return typeof value !== "string";
}

/** 子の差し込み位置を、与えた要素で置き換えた木を返す (元の木は変えない)。 */
export function fillSlot(tree: SvgEl, children: SvgEl[]): SvgEl {
  const replaced: (SvgEl | string)[] = [];
  let changed = false;
  for (const child of tree.children) {
    if (typeof child === "string") replaced.push(child);
    else if (child.tag === CHILDREN_SLOT) {
      replaced.push(...children);
      changed = true;
    } else {
      const next = fillSlot(child, children);
      if (next !== child) changed = true;
      replaced.push(next);
    }
  }
  return changed ? { ...tree, children: replaced } : tree;
}

// ---------------------------------------------------------------------------
// 文字列
// ---------------------------------------------------------------------------

/** 数値を属性値の文字列にする。`-0` は `0`、指数表記はそのまま (SVG の数値として読める)。 */
export function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  return String(value);
}

/**
 * XML 1.0 に書けない文字 (U+0000〜U+0008、U+000B、U+000C、U+000E〜U+001F、U+FFFE、U+FFFF、
 * 対になっていないサロゲート) を取り除く。文字参照でも書けないので、残すと SVG 全体が読めなくなる。
 */
const INVALID_XML_CHARS = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]",
    "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])",
    "(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
  ].join("|"),
  "g",
);

export function escapeXmlText(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 属性値 (`"` で囲む) のエスケープ。改行とタブは属性値の正規化で空白にならないよう文字参照にする。 */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/** `SvgEl` を XML の文字列にする。子のない要素は `<tag/>` で閉じる。 */
export function svgElToString(node: SvgEl | string): string {
  if (typeof node === "string") return escapeXmlText(node);
  if (node.tag === CHILDREN_SLOT) return "";
  let out = `<${node.tag}`;
  for (const [name, value] of Object.entries(node.attrs)) {
    const text = typeof value === "number" ? formatNumber(value) : value;
    out += ` ${name}="${escapeXmlAttr(text)}"`;
  }
  if (node.children.length === 0) return `${out}/>`;
  out += ">";
  for (const child of node.children) out += svgElToString(child);
  return `${out}</${node.tag}>`;
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

const REACT_ATTR_NAMES: Record<string, string> = {
  class: "className",
  "xml:space": "xmlSpace",
  "xlink:href": "xlinkHref",
  "xml:lang": "xmlLang",
};

const reactNameCache = new Map<string, string>();

/** SVG の属性名を React の prop 名にする (`stroke-width` → `strokeWidth`)。`data-*` / `aria-*` はそのまま。 */
export function reactAttrName(name: string): string {
  const cached = reactNameCache.get(name);
  if (cached !== undefined) return cached;
  let result = REACT_ATTR_NAMES[name];
  if (result === undefined) {
    result =
      name.startsWith("data-") || name.startsWith("aria-")
        ? name
        : name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  }
  reactNameCache.set(name, result);
  return result;
}

export interface ToReactOptions {
  /** `CHILDREN_SLOT` の位置に置く React の子 */
  slot?: ReactNode;
  key?: string | number;
}

/**
 * `SvgEl` を React 要素にする。文字列の子は React がエスケープする。
 * XML に書けない文字は文字列化と同じく取り除き、画面と書き出しで中身をそろえる。
 */
export function svgElToReact(node: SvgEl | string, options: ToReactOptions = {}): ReactNode {
  if (typeof node === "string") return node.replace(INVALID_XML_CHARS, "");
  if (node.tag === CHILDREN_SLOT)
    return createElement(
      Fragment,
      options.key === undefined ? null : { key: options.key },
      options.slot,
    );
  const props: Record<string, unknown> = {};
  if (options.key !== undefined) props["key"] = options.key;
  for (const [name, value] of Object.entries(node.attrs)) {
    props[reactAttrName(name)] =
      typeof value === "number" ? formatNumber(value) : value.replace(INVALID_XML_CHARS, "");
  }
  const children = node.children.map((child, index) =>
    svgElToReact(child, { slot: options.slot, key: index }),
  );
  return createElement(node.tag, props, ...children);
}
