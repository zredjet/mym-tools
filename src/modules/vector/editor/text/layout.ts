/**
 * テキストの行分割 (§4.3 / §4.7)。名前と引数は契約 (`render/types.ts` の `LayoutText`)。
 * 描画 (`buildNodeShell`)、書き出し、大きさの求め直し (`fitTextNodes`) がこれだけを通して行を得る。
 *
 * - `\n` で改行する。末尾の改行は空の行になる
 * - `auto-width` は折り返さない。`auto-height` と `fixed` はノードの幅で折り返す
 *   (和文は文字の間、欧文は単語の間。禁則は `lineBreak.ts`)。幅に収まらない単語は書記素クラスタで割る
 * - 行末の空白は折り返しの判定と揃えに数えない (CSS の `white-space: pre-wrap` と同じくぶら下げる)。
 *   `auto-width` は空白も幅に数える (`white-space: pre`)
 * - 揃えは、行の幅とノードの幅 (`auto-width` は内容の幅を切り上げた値 = 求め直した後のノードの幅) から
 *   行頭の x を決める
 * - ベースラインは CSS の行の箱と同じ位置 (行の高さの中央に、アセントとディセントの差の半分を足す)
 * - 字間は計測 (`TextMeasurer`) が足す
 *
 * 描画のたびに呼ばれるので、結果をノードのオブジェクトと計測の組で覚えて使い回す
 * (文書は書き換えない約束なので、同じオブジェクトなら結果も同じ)。返す値は書き換えないこと。
 */
import { CANVAS_LIMITS } from "../model/limits";
import type { TextAlign, TextNode } from "../model/types";
import type { FontSpec, LayoutText, TextLayout, TextLine, TextMeasurer } from "../render/types";
import { splitGraphemes } from "./graphemes";
import { breakUnits, trimTrailingSpaces } from "./lineBreak";
import { fontMetricsOf } from "./metrics";

/** `lineHeight` が null のときの行の高さ (フォントサイズに対する倍率)。 */
export const AUTO_LINE_HEIGHT = 1.4;

/** アセントとディセントが分からないときの (アセント − ディセント) ÷ フォントサイズ。 */
export const DEFAULT_ASCENT_MINUS_DESCENT = 0.7;

/**
 * 幅と大きさを比べるときの許容差 (px)。計測の浮動小数の誤差 (22.4 × 5 = 112.00000000000001 など) で
 * 折り返しや切り上げが 1 つずれないようにする。
 */
export const SIZE_EPSILON = 1e-3;

/** 行の高さ (px)。 */
export function lineHeightOf(node: Pick<TextNode, "lineHeight" | "fontSize">): number {
  return node.lineHeight ?? node.fontSize * AUTO_LINE_HEIGHT;
}

/** 大きさを切り上げた整数にし、`maxSize` に収める (§4.7)。 */
export function ceilSize(value: number): number {
  return Math.min(CANVAS_LIMITS.maxSize, Math.max(0, Math.ceil(value - SIZE_EPSILON)));
}

export function textFontSpec(node: TextNode): FontSpec {
  return {
    family: node.fontFamily,
    size: node.fontSize,
    weight: node.fontWeight,
    italic: node.italic,
    letterSpacing: node.letterSpacing,
  };
}

/** 行の先頭から最初の行のベースラインまで (px)。CSS の行の箱と同じ位置にする。 */
export function baselineOffset(node: TextNode, measurer: TextMeasurer): number {
  const lineHeight = lineHeightOf(node);
  const metrics = fontMetricsOf(measurer, textFontSpec(node));
  const diff = metrics
    ? metrics.ascent - metrics.descent
    : node.fontSize * DEFAULT_ASCENT_MINUS_DESCENT;
  return (lineHeight + diff) / 2;
}

interface Row {
  text: string;
  width: number;
}

/**
 * 1 単位 (`breakUnits` の 1 つ) が行に収まらないとき、書記素クラスタで割る。
 * 前半は 1 つ以上の書記素クラスタを含み、末尾の空白はぶら下げる。
 */
function splitToFit(
  unit: string,
  limit: number,
  measure: (text: string) => number,
): [string, string] {
  const graphemes = splitGraphemes(unit);
  const prefix = (count: number) => graphemes.slice(0, count).join("");
  // まず 1 文字ずつの幅の和で見積もり、実際の幅で確かめる
  let count = 1;
  let estimate = measure(graphemes[0] ?? "");
  while (count < graphemes.length) {
    const grapheme = graphemes[count] as string;
    const width = measure(grapheme);
    if (trimTrailingSpaces(grapheme) !== "" && estimate + width > limit) break;
    estimate += width;
    count++;
  }
  while (count > 1 && measure(trimTrailingSpaces(prefix(count))) > limit) count--;
  while (count < graphemes.length && measure(trimTrailingSpaces(prefix(count + 1))) <= limit)
    count++;
  return [prefix(count), graphemes.slice(count).join("")];
}

/**
 * 1 段落を幅 `maxWidth` で折り返す。各行は入る限りの単位を持つ (貪欲法)。
 * 単位ごとの幅の和で見積もってから、行全体の実際の幅 (カーニングを含む) で確かめる。
 * 同じ単位の幅は計測が覚えているので、長い文でも計測の呼び出しは行の数に比例する程度で済む。
 */
function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  measure: (text: string) => number,
  rows: Row[],
): void {
  const limit = maxWidth + SIZE_EPSILON;
  const units = breakUnits(paragraph);
  const visibleWidth = (parts: readonly string[]) => measure(trimTrailingSpaces(parts.join("")));
  let next = 0;
  while (next < units.length) {
    const line: string[] = [];
    let estimate = 0;
    // 1. 単位ごとの幅の和で、入るところまで取る (空白だけの単位は行末にぶら下げる)
    while (next < units.length) {
      const unit = units[next] as string;
      const visible = trimTrailingSpaces(unit);
      if (line.length > 0 && visible !== "" && estimate + measure(visible) > limit) break;
      line.push(unit);
      estimate += measure(unit);
      next++;
    }
    // 2. 行全体の実際の幅で確かめる。はみ出すなら後ろから戻し、まだ入るなら次の単位も取る
    while (line.length > 1 && visibleWidth(line) > limit) {
      line.pop();
      next--;
    }
    while (next < units.length && visibleWidth([...line, units[next] as string]) <= limit) {
      line.push(units[next] as string);
      next++;
    }
    // 3. 1 単位だけでも入らなければ、書記素クラスタで割る (幅に収まらない単語)
    if (line.length === 1 && visibleWidth(line) > limit) {
      const [head, rest] = splitToFit(line[0] as string, limit, measure);
      line[0] = head;
      if (rest !== "") {
        next--;
        units[next] = rest;
      }
    }
    const text = line.join("");
    rows.push({ text, width: measure(trimTrailingSpaces(text)) });
  }
}

function alignOffset(align: TextAlign, boxWidth: number, lineWidth: number): number {
  if (align === "center") return (boxWidth - lineWidth) / 2;
  if (align === "right") return boxWidth - lineWidth;
  return 0;
}

function computeLayout(node: TextNode, measurer: TextMeasurer): TextLayout {
  const font = textFontSpec(node);
  const measure = (text: string) => measurer.measure(text, font);
  const lineHeight = lineHeightOf(node);
  const wrap = node.sizing !== "auto-width";
  const rows: Row[] = [];
  for (const paragraph of node.text.split("\n")) {
    if (wrap) wrapParagraph(paragraph, node.width, measure, rows);
    else rows.push({ text: paragraph, width: measure(paragraph) });
  }
  let width = 0;
  for (const row of rows) width = Math.max(width, row.width);
  if (rows.some((row) => !Number.isFinite(row.width))) width = Number.NaN;
  const boxWidth = wrap ? node.width : ceilSize(width);
  const baseline = baselineOffset(node, measurer);
  const lines: TextLine[] = rows.map((row, index) => ({
    text: row.text,
    x: alignOffset(node.align, boxWidth, row.width),
    y: index * lineHeight + baseline,
    width: row.width,
  }));
  return { lines, width, height: rows.length * lineHeight };
}

const caches = new WeakMap<TextMeasurer, WeakMap<TextNode, TextLayout>>();

/**
 * テキストを行に分ける。結果はノードのオブジェクトと計測の組で覚える。
 * 返す `TextLayout` は呼び出し側で共有されるので、書き換えないこと。
 */
export const layoutText: LayoutText = (node: TextNode, measurer: TextMeasurer): TextLayout => {
  let perMeasurer = caches.get(measurer);
  if (!perMeasurer) {
    perMeasurer = new WeakMap();
    caches.set(measurer, perMeasurer);
  }
  const cached = perMeasurer.get(node);
  if (cached) return cached;
  const layout = computeLayout(node, measurer);
  perMeasurer.set(node, layout);
  return layout;
};
