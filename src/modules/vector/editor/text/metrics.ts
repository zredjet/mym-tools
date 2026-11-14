/**
 * フォントのアセント・ディセントを返す計測の口 (`render/measureText.ts` が実装する)。
 * 契約の `TextMeasurer` にない追加の口なので、持たない計測 (テストの固定幅など) では
 * `layoutText` が既定の比率を使う。
 */
import type { FontSpec, TextMeasurer } from "../render/types";

/** フォントのアセントとディセント (px)。ベースラインより上と下の長さで、どちらも正の数。 */
export interface FontMetrics {
  ascent: number;
  descent: number;
}

/** アセントとディセントも返す計測。 */
export interface MetricsTextMeasurer extends TextMeasurer {
  /** 分からなければ null */
  fontMetrics(font: FontSpec): FontMetrics | null;
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
