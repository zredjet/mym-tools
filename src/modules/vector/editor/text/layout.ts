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
import {
  breakUnits,
  mayTrimAtLineEnd,
  trimTrailingSpaces,
  type LineBreakOptions,
} from "./lineBreak";
import { largestFitting, predictCount, type FitProbe } from "./lineFit";
import { editorWidthOf, fontMetricsOf, lineBreakOptionsOf, lineEndTrimOf } from "./metrics";

/** `lineHeight` が null のときの行の高さ (フォントサイズに対する倍率)。 */
export const AUTO_LINE_HEIGHT = 1.4;

/** アセントとディセントが分からないときの (アセント − ディセント) ÷ フォントサイズ。 */
export const DEFAULT_ASCENT_MINUS_DESCENT = 0.7;

/**
 * 幅と大きさを比べるときの許容差 (px)。計測の浮動小数の誤差 (22.4 × 5 = 112.00000000000001 など) で
 * 折り返しや切り上げが 1 つずれないようにする。
 */
export const SIZE_EPSILON = 1e-3;

/**
 * 折り返しで、行が幅 `maxWidth` に収まる幅の上限 (この値より狭ければ収まる)。
 * ブラウザは行の幅を 1/64 px 単位 (LayoutUnit) に四捨五入して枠の幅と比べる (Chromium で実測。
 * 端数が 1/128 px 未満なら収まり、それ以上なら収まらない)。編集欄の `<textarea>` と折り返しをそろえるため
 * 同じ規則にする。`ceilSize` の許容差より大きいので、`auto-width` を同じ幅の `auto-height` にしても折り返さない。
 */
export function wrapLimit(maxWidth: number): number {
  return (Math.round(maxWidth * 64) + 0.5) / 64;
}

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

/** 1 段落を折り返すのに使う、測り方と規則。 */
interface WrapContext {
  /** `wrapLimit` */
  limit: number;
  options: LineBreakOptions;
  /** 描画の幅 */
  measure: (text: string) => number;
  /** 編集欄 (HTML) が組む幅。折り返すかどうかはこの幅で判定する */
  editor: (text: string) => number;
  /**
   * 行末の約物を詰めて縮められる幅 (末尾の空白を落とした行の文字列と、行の後に続く文字から)。詰めなければ 0。
   * 続く文字は、単位の途中で割った行のときだけ渡す
   */
  squeeze: (visible: string, next?: string) => number;
}

/** 予測 (`predictCount`) で 1 つずつの幅の和を求める範囲 (見積もった個数の 2 倍 + この数まで)。 */
const PREDICT_MARGIN = 64;

/**
 * 1 単位 (`breakUnits` の 1 つ) が行に収まらないとき、書記素クラスタで割る (幅に収まらない単語)。
 * 収まる行をすべて返し、最後の収まりきる残りは `rest` として返す (呼び出し側が、続く単位と同じ行に並べる)。
 * 各行は 1 つ以上の書記素クラスタを含み、末尾の空白はぶら下げる。
 *
 * 時間は単位の長さにほぼ比例させる (空白のない長い文字列、base64 や URL で固まらないように)。
 * 書記素クラスタへの分割と 1 文字ずつの幅は 1 回だけ求め、残りの文字列を作り直さない。
 * 行ごとに、1 文字ずつの幅の和で見積もってから、その行だけを実際に測って確かめる。見積もりがカーニングで
 * 外れても、行全体を測る回数は `largestFitting` の上限 (行の文字数の対数) で済む。
 */
function breakLongUnit(
  unit: string,
  context: WrapContext,
  probeText: (text: string, next: string) => FitProbe,
): { lines: { text: string; next: string; width: number }[]; rest: string } {
  const { limit, measure, options } = context;
  const graphemes = splitGraphemes(unit);
  // 同じ文字は 1 回だけ測る (`"a".repeat(n)` や `━━━` の連続)
  const seen = new Map<string, number>();
  const widths = graphemes.map((grapheme) => {
    let width = seen.get(grapheme);
    if (width === undefined) {
      width = measure(grapheme);
      seen.set(grapheme, width);
    }
    return width;
  });
  const count = graphemes.length;
  // 先頭からの 1 文字ずつの幅の和 (予測に使う)
  const sums = [0];
  for (const width of widths) sums.push((sums[sums.length - 1] as number) + width);
  const text = (from: number, to: number) => graphemes.slice(from, to).join("");
  const lines: { text: string; next: string; width: number }[] = [];
  let start = 0;
  while (start < count) {
    // 1 文字ずつの幅の和で、入るところまで (空白は行末にぶら下げる)
    let end = start + 1;
    let estimate = widths[start] ?? 0;
    while (end < count) {
      const width = widths[end] ?? 0;
      if (trimTrailingSpaces(graphemes[end] as string, options) !== "" && estimate + width >= limit)
        break;
      estimate += width;
      end++;
    }
    // 残りが見積もりで収まるなら、続く単位と並べられるよう呼び出し側へ返す (そこで実際の幅で確かめる)
    if (end === count && start > 0) return { lines, rest: text(start, count) };
    // その行だけを実際に測って確かめる (先頭から何文字入るか)
    const from = start;
    const probes = new Map<number, FitProbe & { text: string }>();
    const probe = (length: number) => {
      let result = probes.get(length);
      if (!result) {
        const value = text(from, from + length);
        result = { ...probeText(value, graphemes[from + length] ?? ""), text: value };
        probes.set(length, result);
      }
      return result;
    };
    const available = count - from;
    const length = largestFitting(1, available, end - from, probe, (guess, width) =>
      predictCount(
        guess,
        width,
        limit,
        1,
        Math.min(available, guess * 2 + PREDICT_MARGIN),
        (n) => (sums[from + n] as number) - (sums[from] as number),
      ),
    );
    end = from + length;
    if (end === count && start > 0) return { lines, rest: text(start, count) };
    const line = probe(length);
    lines.push({ text: line.text, next: graphemes[end] ?? "", width: line.width });
    start = end;
  }
  return { lines, rest: "" };
}

/**
 * 1 段落を折り返す。各行は入る限りの単位を持つ (貪欲法)。
 * 単位ごとの幅の和で見積もってから、行全体の実際の幅 (カーニングを含む) で確かめる。
 * 同じ単位の幅は計測が覚えているので、長い文でも計測の呼び出しは行の数に比例する程度で済む。
 * 見積もりが外れたときに行全体を測り直す回数は、行の単位の数の対数で抑える (`largestFitting`)。
 *
 * 収まるかどうかは、編集欄 (HTML) が組む幅と描画の幅の広いほうで判定する。編集欄の幅は、WebKit は単位ごとに
 * 組むので単位ごとの幅の和、Chromium は行全体の幅。描画の幅のほうが広いこともある (WebKit の字間は描画では
 * 符号位置ごと、編集欄では書記素ごと。タブは描画では空白 1 つ) ので、広いほうで判定して、描いた行が枠から
 * はみ出さないようにする。収まらなくても、行末の約物を詰めて収まるなら収める (Chromium の `text-spacing-trim`)。
 * 行の幅 (揃え) は描画の幅で、行末を詰めた行は詰めた分を引く (編集欄と同じ位置に揃う)。
 */
function wrapParagraph(paragraph: string, context: WrapContext, rows: Row[]): void {
  const { limit, options, measure, editor, squeeze } = context;
  const trim = (text: string) => trimTrailingSpaces(text, options);
  const units = breakUnits(paragraph, options);
  const editorOf = options.shapePerUnit
    ? (parts: readonly string[]) => {
        if (parts.some((part) => part.includes("\t"))) return editor(trim(parts.join("")));
        let width = 0;
        const last = parts.length - 1;
        for (let i = 0; i < last; i++) width += editor(parts[i] as string);
        return last >= 0 ? width + editor(trim(parts[last] as string)) : 0;
      }
    : (parts: readonly string[]) => editor(trim(parts.join("")));
  /** 収まるかの判定に使う幅 (編集欄の幅と描画の幅の広いほう) */
  const editorWidth = (parts: readonly string[]) =>
    Math.max(editorOf(parts), measure(trim(parts.join(""))));
  /**
   * 行末で詰められる幅。行の末尾に空白がぶら下がるときは詰めない (約物が行の終わりにないので、
   * Chromium の編集欄も詰めずに空白の後で折り返す)
   */
  const squeezeOf = (text: string, next: string) => {
    const visible = trim(text);
    return visible.length === text.length ? squeeze(visible, next) : 0;
  };
  /** 幅 `width` (`editorWidth`) の行が収まるか */
  const fits = (parts: readonly string[], width: number, next = "") =>
    width < limit || width - squeezeOf(parts.join(""), next) < limit;
  const pushRow = (text: string, width: number, next = "") => {
    const visible = trim(text);
    rows.push({ text, width: measure(visible) - (width < limit ? 0 : squeezeOf(text, next)) });
  };
  const probeText = (text: string, next: string): FitProbe => {
    const width = editorWidth([text]);
    return { fits: fits([text], width, next), width };
  };
  let next = 0;
  while (next < units.length) {
    const start = next;
    // 行頭からの単位ごとの幅の和 (見積もりと、2. の予測に使う。予測は必要なところまで伸ばす)
    const sums = [0];
    let estimate = 0;
    // 1. 単位ごとの幅の和で、入るところまで取る (空白だけの単位は行末にぶら下げる)
    while (next < units.length) {
      const unit = units[next] as string;
      const visible = trim(unit);
      if (next > start && visible !== "" && estimate + measure(visible) >= limit) break;
      estimate += measure(unit);
      sums.push(estimate);
      next++;
    }
    // 2. 行全体の実際の幅で確かめ、入る単位の数を求める (見積もりが外れても、測る回数は数の対数で済む)
    const probes = new Map<number, FitProbe & { line: string[] }>();
    const probe = (count: number) => {
      let result = probes.get(count);
      if (!result) {
        const line = units.slice(start, start + count);
        const width = editorWidth(line);
        result = { fits: fits(line, width), width, line };
        probes.set(count, result);
      }
      return result;
    };
    const sumAt = (count: number) => {
      for (let i = sums.length; i <= count; i++)
        sums.push((sums[i - 1] as number) + measure(units[start + i - 1] as string));
      return sums[count] as number;
    };
    const available = units.length - start;
    const count = largestFitting(1, available, next - start, probe, (guess, width) =>
      predictCount(guess, width, limit, 1, Math.min(available, guess * 2 + PREDICT_MARGIN), sumAt),
    );
    next = start + count;
    const { line, fits: fitted, width } = probe(count);
    // 3. 1 単位だけでも入らなければ、書記素クラスタで割る。収まる残りは次の行の先頭の単位にする
    if (count === 1 && !fitted) {
      const { lines, rest } = breakLongUnit(line[0] as string, context, probeText);
      for (const row of lines) pushRow(row.text, row.width, row.next);
      if (rest !== "") {
        next--;
        units[next] = rest;
      }
      continue;
    }
    pushRow(line.join(""), width);
  }
}

function alignOffset(align: TextAlign, boxWidth: number, lineWidth: number): number {
  if (align === "center") return (boxWidth - lineWidth) / 2;
  if (align === "right") return boxWidth - lineWidth;
  return 0;
}

/** これより長い文字列の幅は、1 回のレイアウトの間だけ覚えて測り直さない (計測は長い文字列を覚えない)。 */
const LONG_TEXT_LENGTH = 64;

/**
 * 編集欄が 1 行 (行頭から) に組む幅。編集欄はタブを次のタブ位置 (`tab-size: 1` = 空白 1 つの幅ごと。
 * 空白の半分より近ければその次) まで進める。描画はタブを空白 1 つとして描くので、ここだけが違う。
 */
function editorLineWidthOf(text: string, editor: (text: string) => number): number {
  if (!text.includes("\t")) return text === "" ? 0 : editor(text);
  const parts = text.split("\t");
  const space = editor(" ");
  let x = editor(parts[0] as string);
  for (let i = 1; i < parts.length; i++) {
    if (space > 0) {
      let distance = space - (x % space);
      if (distance < space / 2) distance += space;
      x += distance;
    }
    const part = parts[i] as string;
    if (part !== "") x += editor(part);
  }
  return x;
}

function wrapContext(
  node: TextNode,
  measurer: TextMeasurer,
  font: FontSpec,
  measure: (text: string) => number,
): WrapContext {
  const editor = (text: string) => editorWidthOf(measurer, text, font);
  // 単位ごとの和 (WebKit) は同じ単位を何度も測るので、1 回のレイアウトの間だけ覚える
  const editorWidths = new Map<string, number>();
  return {
    limit: wrapLimit(node.width),
    options: lineBreakOptionsOf(measurer),
    measure,
    editor: (text) => {
      if (text.length >= LONG_TEXT_LENGTH) return editorLineWidthOf(text, editor);
      let width = editorWidths.get(text);
      if (width === undefined) {
        width = editorLineWidthOf(text, editor);
        editorWidths.set(text, width);
      }
      return width;
    },
    squeeze: (visible, next = "") => {
      if (visible === "" || !mayTrimAtLineEnd(visible.charCodeAt(visible.length - 1))) return 0;
      // 末尾の 2 つの書記素クラスタ (前の文字で詰めるかが変わる)
      const tail = splitGraphemes(visible.slice(-16));
      const last = tail[tail.length - 1] as string;
      const ratio = lineEndTrimOf(measurer, tail[tail.length - 2] ?? "", last, font);
      const atEnd = ratio > 0 ? ratio * measure(last) : 0;
      // 単位の途中で割った行: 続く約物との詰め (`、。` の `、`) を、編集欄は割った後も残す (Chromium)。
      // 詰める幅は描画の幅から求める (詰めないエンジンでは 0)
      if (next === "" || !(mayTrimAtLineEnd(next.charCodeAt(0)) || next === "\u30fb")) return atEnd;
      const adjacent = measure(last) + measure(next) - measure(last + next);
      return Math.max(atEnd, adjacent > SIZE_EPSILON ? adjacent : 0);
    },
  };
}

function computeLayout(node: TextNode, measurer: TextMeasurer): TextLayout {
  const font = textFontSpec(node);
  const long = new Map<string, number>();
  const measure = (text: string) => {
    if (text.length < LONG_TEXT_LENGTH) return measurer.measure(text, font);
    let width = long.get(text);
    if (width === undefined) {
      width = measurer.measure(text, font);
      long.set(text, width);
    }
    return width;
  };
  const lineHeight = lineHeightOf(node);
  const wrap = node.sizing !== "auto-width";
  const rows: Row[] = [];
  const context = wrap ? wrapContext(node, measurer, font, measure) : null;
  for (const paragraph of node.text.split("\n")) {
    if (context) wrapParagraph(paragraph, context, rows);
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

/**
 * 編集欄 (`<textarea>`) が組む、いちばん広い行の幅 (`auto-width` の編集中に入力欄の幅を決めるのに使う)。
 * WebKit は HTML を単位ごとに組み、単位をまたぐカーニングを入れないので、描画の幅 (= ノードの幅) より
 * 最大 1% ほど広い。ほかのエンジンでは描画の幅と同じ。
 */
export function editorLineWidth(node: TextNode, measurer: TextMeasurer): number {
  const layout = layoutText(node, measurer);
  const font = textFontSpec(node);
  let width = 0;
  const editor = (text: string) => editorWidthOf(measurer, text, font);
  for (const line of layout.lines) width = Math.max(width, editorLineWidthOf(line.text, editor));
  return width;
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
