/** ルーラーの目盛り (純関数)。倍率に応じて、ラベル付きの目盛りの間隔を 1・2・5 × 10^n から選ぶ。 */

/** ルーラーの太さ (画面 px)。 */
export const RULER_SIZE = 20;

/** ラベル付きの目盛りの間隔の下限 (画面 px)。これより狭くならない最小の間隔を選ぶ。 */
export const MIN_MAJOR_SPACING = 64;

export interface RulerTick {
  /** ルーラーの始点からの画面 px */
  screen: number;
  /** ページ座標 */
  value: number;
}

export interface RulerTicks {
  /** ラベル付きの目盛りの間隔 (ページ px) */
  step: number;
  major: RulerTick[];
  minor: RulerTick[];
}

/** 画面で `minSpacing` px 以上になる、1・2・5 × 10^n の最小の間隔 (ページ px、1 以上)。 */
export function rulerStep(zoom: number, minSpacing = MIN_MAJOR_SPACING): number {
  const raw = minSpacing / zoom;
  if (raw <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 5, 10]) {
    const step = factor * power;
    if (step >= raw) return step;
  }
  return 10 * power;
}

/** 間隔に応じた細かい目盛りの分割数。 */
function minorDivisions(step: number): number {
  const leading = step / 10 ** Math.floor(Math.log10(step));
  return Math.round(leading) === 2 ? 2 : 5;
}

/**
 * ルーラーの目盛り。`start` は始点 (画面 0 px) のページ座標、`length` はルーラーの長さ (画面 px)。
 * 細かい目盛りは間隔が 1 ページ px 未満か 4 画面 px 未満になるときは出さない。
 */
export function rulerTicks(start: number, zoom: number, length: number): RulerTicks {
  const step = rulerStep(zoom);
  const end = start + length / zoom;
  const major: RulerTick[] = [];
  const minor: RulerTick[] = [];
  const first = Math.floor(start / step) * step;
  const divisions = minorDivisions(step);
  const minorStep = step / divisions;
  const showMinor = minorStep >= 1 && minorStep * zoom >= 4;
  for (let value = first; value <= end; value += step) {
    const fixed = Number(value.toFixed(6));
    if (fixed >= start) major.push({ value: fixed, screen: (fixed - start) * zoom });
    if (!showMinor) continue;
    for (let i = 1; i < divisions; i++) {
      const sub = Number((fixed + minorStep * i).toFixed(6));
      if (sub >= start && sub <= end) minor.push({ value: sub, screen: (sub - start) * zoom });
    }
  }
  return { step, major, minor };
}

/** 目盛りのラベル。整数は区切りなし、小数は出さない (間隔は 1 以上なので常に整数)。 */
export function formatRulerValue(value: number): string {
  return String(Math.round(value));
}
