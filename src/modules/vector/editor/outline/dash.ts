/**
 * 破線の区間 (`docs/canvas-editor-design.md` §8.10、§8.11)。描画 (`stroke-dasharray`) と同じ規則:
 *
 * - 破線は輪郭ごとに、輪郭の始点から始める (ずらしはない)。奇数個の並びは 2 回繰り返して偶数個にする
 * - 値が空、負・有限でない値を含む、合計が 0 のときは実線 (SVG で無効な値は実線になる)
 * - 長さ 0 の線 (間隔のあとに 0 の長さが来る所) も区間に数える (丸・四角の端なら点を描く)
 * - 閉じた輪郭でも、最後の区間と先頭の区間はつながない (最後の区間が終わりまで続いても、始点の角は描かず、
 *   両方の区間の端を描く)。macOS のアプリの WebKit (CoreGraphics) の描き方に合わせる。Windows の WebView2
 *   (Chromium / Skia) は、最後の区間が終わりまで続くと先頭の区間とつないで始点の角を描くので、そこだけ見た目が
 *   違う
 * - 長さ 0 の輪郭は破線では何も描かない (Skia は長さ 0 の輪郭を破線にしない)
 */

export interface DashSpan {
  /** 輪郭の始点からの長さ */
  start: number;
  end: number;
}

/** 実線なら null。奇数個は繰り返して偶数個にする。 */
export function normalizeDash(dash: readonly number[]): number[] | null {
  if (dash.length === 0) return null;
  let sum = 0;
  for (const value of dash) {
    if (!Number.isFinite(value) || value < 0) return null;
    sum += value;
  }
  if (!(sum > 0)) return null;
  return dash.length % 2 === 1 ? [...dash, ...dash] : [...dash];
}

/**
 * 長さ `length` の輪郭の、線を描く区間 (始点からの長さの順)。区間の数が `maxSpans` を超えるなら null。
 * 終わりの近く (長さの 1e-9 倍以内) は終わりとみなす (足し合わせの丸めで、ごく短い区間を作らないため)。
 */
export function dashSpans(
  length: number,
  pattern: readonly number[],
  maxSpans: number,
): DashSpan[] | null {
  if (!(length > 0)) return [];
  let period = 0;
  for (const value of pattern) period += value;
  const onCount = Math.ceil(pattern.length / 2);
  if ((length / period + 1) * onCount > maxSpans) return null;
  const snap = 1e-9 * Math.max(1, length);
  const spans: DashSpan[] = [];
  let pos = 0;
  let index = 0;
  while (length - pos > snap) {
    const len = pattern[index]!;
    const on = index % 2 === 0;
    const end = pos + len;
    if (on) {
      spans.push({ start: pos, end: length - end <= snap ? length : end });
      if (spans.length > maxSpans) return null;
    }
    pos = end;
    index = (index + 1) % pattern.length;
  }
  return spans.map((s) => ({ ...s, end: Math.min(s.end, length) }));
}
