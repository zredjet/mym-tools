/// <reference lib="es2022.intl" />

import { normalizeSearchText } from "./tree";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 検索は文字列全体で行い、表示対象の最初の一致だけを元の書記素境界に戻す。 */
export function findHighlightRange(
  text: string,
  query: string,
): { start: number; end: number } | null {
  const needle = normalizeSearchText(query.trim());
  if (needle === "") return null;
  const matchStart = normalizeSearchText(text).indexOf(needle);
  if (matchStart < 0) return null;
  const matchEnd = matchStart + needle.length;
  let normalizedOffset = 0;
  let start: number | null = null;
  for (const { segment, index } of graphemes.segment(text)) {
    // 正規化で増減する長さだけを対応づける。内容を連結して検索すると、
    // ギリシャ語の語末シグマなど、文脈に依存する小文字化が変わってしまう。
    normalizedOffset += normalizeSearchText(segment).length;
    if (start == null && normalizedOffset > matchStart) start = index;
    if (start != null && normalizedOffset >= matchEnd)
      return { start, end: index + segment.length };
  }
  return null;
}
