/**
 * フォントのアセント・ディセントを返す計測の口 (`render/measureText.ts` が実装する)。
 * 契約の `TextMeasurer` にない追加の口なので、持たない計測 (テストの固定幅など) では
 * `layoutText` が既定の比率を使う。
 */
import type { FontSpec, TextMeasurer } from "../render/types";
import type { LineBreakOptions } from "./lineBreak";

/** フォントのアセントとディセント (px)。ベースラインより上と下の長さで、どちらも正の数。 */
export interface FontMetrics {
  ascent: number;
  descent: number;
}

/**
 * 行に収まらないとき、行末の約物を詰める割合 (その字の幅に対する)。0 は詰めない。
 * Chromium の `text-spacing-trim` (既定の `normal` の `allow-end`) がこうする。
 * - `close`: 全角の閉じ括弧 (`」` `）` など)
 * - `dot`: 全角の読点・句点 (`、` `。` など)
 * - `quote`: 閉じの引用符 (`”` `’`。全角の字形のフォントだけ)
 */
export interface LineEndTrim {
  close: number;
  dot: number;
  quote: number;
}

export const NO_LINE_END_TRIM: LineEndTrim = { close: 0, dot: 0, quote: 0 };

/** アセントとディセントも返す計測。エンジンによって違う折り返しの規則も返す。 */
export interface MetricsTextMeasurer extends TextMeasurer {
  /** 分からなければ null */
  fontMetrics(font: FontSpec): FontMetrics | null;
  /** 編集欄と行分割をそろえるための、エンジンの折り返しの規則。持たなければ既定の規則 */
  lineBreakOptions?(): LineBreakOptions;
  /**
   * 字間が 0 でないとき、描画がカーニングを入れないか (WebKit の SVG は 1 文字ずつ並べる)。
   * そのときは編集欄もカーニングを切って、折り返しを描画とそろえる
   */
  letterSpacingDropsKerning?(): boolean;
  /**
   * 編集欄 (HTML の `<textarea>`) が 1 行に組む幅。折り返すかどうかをこの幅で判定して、編集欄と行分割を
   * そろえる。描画の幅 (`measure`) と違うエンジンだけが違う値を返す (WebKit は単位ごとに組む)
   */
  editorWidth?(text: string, font: FontSpec): number;
  /** 行末の約物を詰める割合 (フォントごと)。持たなければ詰めない */
  lineEndTrim?(font: FontSpec): LineEndTrim;
}

/** 計測がアセントとディセントを返せるならその値、返せなければ null。 */
export function fontMetricsOf(measurer: TextMeasurer, font: FontSpec): FontMetrics | null {
  const candidate = measurer as Partial<MetricsTextMeasurer>;
  if (typeof candidate.fontMetrics !== "function") return null;
  const metrics = candidate.fontMetrics(font);
  if (!metrics || !Number.isFinite(metrics.ascent) || !Number.isFinite(metrics.descent))
    return null;
  return metrics;
}

/** 計測が返すエンジンの折り返しの規則。返さなければ既定 (空)。 */
export function lineBreakOptionsOf(measurer: TextMeasurer): LineBreakOptions {
  const candidate = measurer as Partial<MetricsTextMeasurer>;
  return typeof candidate.lineBreakOptions === "function" ? candidate.lineBreakOptions() : {};
}

/** 字間があるとき描画がカーニングを入れないか。計測が返さなければ false。 */
export function letterSpacingDropsKerningOf(measurer: TextMeasurer): boolean {
  const candidate = measurer as Partial<MetricsTextMeasurer>;
  return typeof candidate.letterSpacingDropsKerning === "function"
    ? candidate.letterSpacingDropsKerning()
    : false;
}

/** 編集欄が 1 行に組む幅。計測が返さなければ描画の幅。 */
export function editorWidthOf(measurer: TextMeasurer, text: string, font: FontSpec): number {
  const candidate = measurer as Partial<MetricsTextMeasurer>;
  return typeof candidate.editorWidth === "function"
    ? candidate.editorWidth(text, font)
    : measurer.measure(text, font);
}

/** 行末の約物を詰める割合。計測が返さなければ詰めない。 */
export function lineEndTrimOf(measurer: TextMeasurer, font: FontSpec): LineEndTrim {
  const candidate = measurer as Partial<MetricsTextMeasurer>;
  return typeof candidate.lineEndTrim === "function"
    ? candidate.lineEndTrim(font)
    : NO_LINE_END_TRIM;
}
