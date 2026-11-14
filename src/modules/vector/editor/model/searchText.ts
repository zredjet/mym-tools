/**
 * 検索用テキスト (§3.6)。Rust も同じ規則で求め直し、一致しない payload を拒否する。
 */
import { walkPage } from "./tree";
import type { CanvasDocument } from "./types";

/**
 * 空白の集合。Unicode の White_Space で、Rust の `char::is_whitespace` と同じ。
 * JavaScript の `\s` は U+FEFF を含み集合が違うので使わない。
 */
export const WHITE_SPACE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
]);

export function isWhiteSpace(char: string): boolean {
  return WHITE_SPACE_CODE_POINTS.has(char.codePointAt(0) ?? -1);
}

/** 空白で区切って空の要素を捨て、半角スペース 1 個でつなぐ (§3.6 の 3)。 */
export function collapseWhiteSpace(value: string): string {
  const words: string[] = [];
  let word = "";
  for (const char of value) {
    if (isWhiteSpace(char)) {
      if (word) words.push(word);
      word = "";
    } else word += char;
  }
  if (word) words.push(word);
  return words.join(" ");
}

/**
 * 文書から検索用テキストを求める。ページを配列の順に、各ページを深さ優先・背面からたどり、
 * frame の名前、テキストの本文、埋め込み SVG のアセットの `text` を拾う
 * (group は拾わずに子へ進む。非表示でも拾う)。
 */
export function computeSearchText(doc: CanvasDocument): string {
  const parts: string[] = [];
  const push = (value: string) => {
    const collapsed = collapseWhiteSpace(value);
    if (collapsed) parts.push(collapsed);
  };
  for (const page of doc.pages)
    walkPage(doc, page.id, (node) => {
      if (node.type === "frame") push(node.name);
      else if (node.type === "text") push(node.text);
      else if (node.type === "svg") {
        const asset = doc.assets[node.assetId];
        if (asset?.kind === "svg") push(asset.text);
      }
    });
  return parts.join(" ");
}
