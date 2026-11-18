/**
 * 線分と 3 次ベジェ 1 本の幾何 (`docs/canvas-editor-design.md` §8.5〜§8.9)。交点は `intersect.ts`。
 *
 * 返すもの:
 * - `Segment` は線分 (`line`) か 3 次ベジェ (`cubic`)。t は 0〜1 の媒介変数 (線分は長さに比例)
 * - 値 `pointAt`、微分 `derivativeAt` / `secondDerivativeAt`、向き `tangentAt` (長さ 1。潰れた曲線でも
 *   高次の微分から向きを求める。すべての点が同じなら null)
 * - 範囲 `segmentBounds` は曲線そのものの範囲 (制御点は含めない)。極値の t は `segmentExtrema`
 * - 分割 `splitSegment`、区間の切り出し `subSegment` (t0 > t1 なら向きが逆の曲線)、反転 `reverseSegment`
 * - 最近点 `nearestPoint` (t、点、距離)、長さ `segmentLength`、長さから t `tAtLength`
 * - 折れ線化 `flattenSegment` / `flattenSegmentParams` (誤差 = 曲線と折れ線の距離の上限)
 * - 行列で写す `transformSegment` (アフィン変換はベジェの制御点に掛ければ厳密)
 *
 * 誤差と前提:
 * - すべて純関数で、引数を変えない。返す点は新しいオブジェクト。座標は有限の数であること
 * - `splitSegment` / `subSegment` は端の点をちょうど元の値にする (0 と 1 は元の端点そのもの)。
 *   切り出しは blossom (極形式) で直接求めるので、続けて分けても誤差が積み重ならない
 * - `segmentExtrema` の極値は 2 次方程式を解いて求め、端 (t = 0, 1) は含めない。範囲は端と極値の値の min / max
 * - `nearestPoint` は 32 等分の標本 (接線の向きが 60° より大きく変わる区間は、4 等分を 4 段まで繰り返して
 *   細かくする) で、距離の局所的な最小と、距離の微分 (B - p)·B' が負から正へ変わる区間を拾い、それぞれ
 *   Newton 法 (後退つき) で t を 1e-12 程度まで詰めて最も近いものを選ぶ (端点も候補)。向きがあまり変わらない
 *   標本の 1 区間に最小が 2 つある場合だけ、浅い方を見落とすことがある
 * - `segmentLength` は 8 点の Gauss–Legendre を区間を分けながら当て、相対誤差 1e-10 以内
 * - `tAtLength` は長さの誤差が (1 + 全長) × 1e-9 以内の t
 * - `flattenSegment` の誤差は「制御点から弦までの距離の最大」で判定する (曲線は制御点の凸包の中にあるので、
 *   曲線と折れ線の距離はこれ以下)。`tolerance` は max(`MIN_FLATTEN_TOLERANCE` (1e-4 px)、座標の大きさ × 1e-10)
 *   より小さければ切り上げる (0 を渡しても点の数が爆発しない)。分割の深さは 24 まで
 */
import type { Point } from "../model/types";
import { applyToPoint, type Matrix } from "./matrix";

export interface LineSegment {
  kind: "line";
  from: Point;
  to: Point;
}

export interface CubicSegment {
  kind: "cubic";
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
}

export type Segment = LineSegment | CubicSegment;

/** 軸に平行な範囲。空の範囲は持たない (関数ごとに null で表す)。 */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 絶対的な幾何の許容値の下限 (px)。 */
export const GEOMETRIC_EPSILON = 1e-7;
/** 座標の大きさに比例する許容値の係数。座標が大きいほど丸めの誤差も大きいため。 */
export const RELATIVE_EPSILON = 1e-10;
/** 折れ線化の許容値の下限 (px)。0 などを渡しても点の数が爆発しないように。 */
export const MIN_FLATTEN_TOLERANCE = 1e-4;

const MAX_FLATTEN_DEPTH = 24;
const NEAREST_SAMPLES = 32;

// ---------------------------------------------------------------------------
// 作る・変える
// ---------------------------------------------------------------------------

export function lineSegment(from: Point, to: Point): LineSegment {
  return { kind: "line", from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
}

export function cubicSegment(from: Point, c1: Point, c2: Point, to: Point): CubicSegment {
  return {
    kind: "cubic",
    from: { x: from.x, y: from.y },
    c1: { x: c1.x, y: c1.y },
    c2: { x: c2.x, y: c2.y },
    to: { x: to.x, y: to.y },
  };
}

/** 2 次ベジェを同じ形の 3 次ベジェにする (厳密)。 */
export function quadraticToCubic(from: Point, control: Point, to: Point): CubicSegment {
  return cubicSegment(
    from,
    { x: from.x + ((control.x - from.x) * 2) / 3, y: from.y + ((control.y - from.y) * 2) / 3 },
    { x: to.x + ((control.x - to.x) * 2) / 3, y: to.y + ((control.y - to.y) * 2) / 3 },
    to,
  );
}

/** 線分なら同じ媒介変数の 3 次ベジェ (制御点は 1/3 と 2/3)。3 次ベジェはそのまま。 */
export function toCubic(seg: Segment): CubicSegment {
  if (seg.kind === "cubic") return seg;
  const { from, to } = seg;
  return {
    kind: "cubic",
    from,
    c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
    c2: { x: from.x + ((to.x - from.x) * 2) / 3, y: from.y + ((to.y - from.y) * 2) / 3 },
    to,
  };
}

/** 制御点の並び (線分は 2 個、3 次ベジェは 4 個)。 */
export function controlPoints(seg: Segment): Point[] {
  return seg.kind === "line" ? [seg.from, seg.to] : [seg.from, seg.c1, seg.c2, seg.to];
}

export function reverseSegment(seg: Segment): Segment {
  return seg.kind === "line"
    ? { kind: "line", from: seg.to, to: seg.from }
    : { kind: "cubic", from: seg.to, c1: seg.c2, c2: seg.c1, to: seg.from };
}

export function transformSegment(seg: Segment, m: Matrix): Segment {
  return seg.kind === "line"
    ? { kind: "line", from: applyToPoint(m, seg.from), to: applyToPoint(m, seg.to) }
    : {
        kind: "cubic",
        from: applyToPoint(m, seg.from),
        c1: applyToPoint(m, seg.c1),
        c2: applyToPoint(m, seg.c2),
        to: applyToPoint(m, seg.to),
      };
}

/** 制御点の座標の絶対値の最大。許容値を座標の大きさに合わせるのに使う。 */
export function segmentMagnitude(seg: Segment): number {
  let m = 0;
  for (const p of controlPoints(seg)) m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
  return m;
}

/** 座標の大きさに合わせた幾何の許容値: max(`GEOMETRIC_EPSILON`, 大きさ × `RELATIVE_EPSILON`)。 */
export function toleranceFor(magnitude: number): number {
  return Math.max(GEOMETRIC_EPSILON, magnitude * RELATIVE_EPSILON);
}

// ---------------------------------------------------------------------------
// 値と微分
// ---------------------------------------------------------------------------

export function pointAt(seg: Segment, t: number): Point {
  if (seg.kind === "line") {
    if (t === 0) return { x: seg.from.x, y: seg.from.y };
    if (t === 1) return { x: seg.to.x, y: seg.to.y };
    return { x: lerp(seg.from.x, seg.to.x, t), y: lerp(seg.from.y, seg.to.y, t) };
  }
  if (t === 0) return { x: seg.from.x, y: seg.from.y };
  if (t === 1) return { x: seg.to.x, y: seg.to.y };
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * seg.from.x + b * seg.c1.x + c * seg.c2.x + d * seg.to.x,
    y: a * seg.from.y + b * seg.c1.y + c * seg.c2.y + d * seg.to.y,
  };
}

/** dB/dt。 */
export function derivativeAt(seg: Segment, t: number): Point {
  if (seg.kind === "line") return { x: seg.to.x - seg.from.x, y: seg.to.y - seg.from.y };
  const mt = 1 - t;
  const a = 3 * mt * mt;
  const b = 6 * mt * t;
  const c = 3 * t * t;
  return {
    x: a * (seg.c1.x - seg.from.x) + b * (seg.c2.x - seg.c1.x) + c * (seg.to.x - seg.c2.x),
    y: a * (seg.c1.y - seg.from.y) + b * (seg.c2.y - seg.c1.y) + c * (seg.to.y - seg.c2.y),
  };
}

/** d²B/dt²。線分は 0。 */
export function secondDerivativeAt(seg: Segment, t: number): Point {
  if (seg.kind === "line") return { x: 0, y: 0 };
  const mt = 1 - t;
  return {
    x: 6 * (mt * (seg.c2.x - 2 * seg.c1.x + seg.from.x) + t * (seg.to.x - 2 * seg.c2.x + seg.c1.x)),
    y: 6 * (mt * (seg.c2.y - 2 * seg.c1.y + seg.from.y) + t * (seg.to.y - 2 * seg.c2.y + seg.c1.y)),
  };
}

/** d³B/dt³ (t によらない)。線分は 0。 */
export function thirdDerivative(seg: Segment): Point {
  if (seg.kind === "line") return { x: 0, y: 0 };
  return {
    x: 6 * (seg.to.x - 3 * seg.c2.x + 3 * seg.c1.x - seg.from.x),
    y: 6 * (seg.to.y - 3 * seg.c2.y + 3 * seg.c1.y - seg.from.y),
  };
}

/**
 * t での進む向き (長さ 1)。微分が 0 の点 (ハンドルが点に重なった端など) では、2 次・3 次の微分から
 * 曲線が実際に進む向きを求める。それでも決まらなければ始点から終点への向き、すべての点が同じなら null。
 */
export function tangentAt(seg: Segment, t: number): Point | null {
  const eps = segmentMagnitude(seg) * 1e-12;
  const d1 = derivativeAt(seg, t);
  if (Math.hypot(d1.x, d1.y) > eps) return normalize(d1);
  const d2 = secondDerivativeAt(seg, t);
  if (Math.hypot(d2.x, d2.y) > eps) {
    // B'(t0) = 0 なら B'(t) ≈ B''(t0)(t - t0)。終点では手前から来るので向きが逆になる
    const sign = t >= 1 ? -1 : 1;
    return normalize({ x: sign * d2.x, y: sign * d2.y });
  }
  const d3 = thirdDerivative(seg);
  if (Math.hypot(d3.x, d3.y) > eps) return normalize(d3);
  const chord = { x: seg.to.x - seg.from.x, y: seg.to.y - seg.from.y };
  return Math.hypot(chord.x, chord.y) > 0 ? normalize(chord) : null;
}

// ---------------------------------------------------------------------------
// 範囲
// ---------------------------------------------------------------------------

/** x と y それぞれの微分が 0 になる t (0 < t < 1、昇順)。線分は空。 */
export function segmentExtrema(seg: Segment): { x: number[]; y: number[] } {
  if (seg.kind === "line") return { x: [], y: [] };
  return {
    x: axisExtrema(seg.from.x, seg.c1.x, seg.c2.x, seg.to.x),
    y: axisExtrema(seg.from.y, seg.c1.y, seg.c2.y, seg.to.y),
  };
}

function axisExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t)/3 = (A - 2B + C) t² + 2(B - A) t + A。A = p1 - p0, B = p2 - p1, C = p3 - p2
  const A = p1 - p0;
  const B = p2 - p1;
  const C = p3 - p2;
  return solveQuadratic(A - 2 * B + C, 2 * (B - A), A)
    .filter((t) => t > 0 && t < 1)
    .sort((x, y) => x - y);
}

/** 曲線そのものの範囲 (制御点は含めない)。 */
export function segmentBounds(seg: Segment): Bounds {
  let minX = Math.min(seg.from.x, seg.to.x);
  let maxX = Math.max(seg.from.x, seg.to.x);
  let minY = Math.min(seg.from.y, seg.to.y);
  let maxY = Math.max(seg.from.y, seg.to.y);
  if (seg.kind === "cubic") {
    const { x, y } = segmentExtrema(seg);
    for (const t of x) {
      const v = pointAt(seg, t).x;
      if (v < minX) minX = v;
      if (v > maxX) maxX = v;
    }
    for (const t of y) {
      const v = pointAt(seg, t).y;
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** 制御点を囲む範囲 (曲線はこの中にある。求めるのが速い)。 */
export function controlBounds(seg: Segment): Bounds {
  const pts = controlPoints(seg);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** 2 つの範囲が `margin` 以内で重なるか (接していれば true)。 */
export function boundsOverlap(a: Bounds, b: Bounds, margin = 0): boolean {
  return (
    a.minX <= b.maxX + margin &&
    b.minX <= a.maxX + margin &&
    a.minY <= b.maxY + margin &&
    b.minY <= a.maxY + margin
  );
}

// ---------------------------------------------------------------------------
// 分割
// ---------------------------------------------------------------------------

/** t で 2 つに分ける。分けた点は両方で同じ値。 */
export function splitSegment(seg: Segment, t: number): [Segment, Segment] {
  return [subSegment(seg, 0, t), subSegment(seg, t, 1)];
}

/**
 * t0 から t1 までの部分。t0 > t1 なら向きが逆 (t0 の点から始まる)。0 と 1 の端は元の端点そのもの。
 * 3 次ベジェの部分は同じ多項式の曲線なので、どこで切り出しても形は元の曲線の一部と一致する。
 */
export function subSegment(seg: Segment, t0: number, t1: number): Segment {
  const from = pointAt(seg, t0);
  const to = pointAt(seg, t1);
  if (seg.kind === "line") return { kind: "line", from, to };
  const p = [seg.from, seg.c1, seg.c2, seg.to] as const;
  return {
    kind: "cubic",
    from,
    c1: blossom(p, t0, t0, t1),
    c2: blossom(p, t0, t1, t1),
    to,
  };
}

/** 3 次ベジェの極形式 P(u, v, w)。P(t, t, t) が曲線上の点。 */
function blossom(p: readonly [Point, Point, Point, Point], u: number, v: number, w: number): Point {
  const q0 = mix(p[0], p[1], u);
  const q1 = mix(p[1], p[2], u);
  const q2 = mix(p[2], p[3], u);
  const r0 = mix(q0, q1, v);
  const r1 = mix(q1, q2, v);
  return mix(r0, r1, w);
}

// ---------------------------------------------------------------------------
// 最近点
// ---------------------------------------------------------------------------

export interface NearestPoint {
  t: number;
  point: Point;
  distance: number;
}

/** 曲線の上で `p` に最も近い点。同じ距離なら t の小さい方。 */
export function nearestPoint(seg: Segment, p: Point): NearestPoint {
  if (seg.kind === "line") {
    const dx = seg.to.x - seg.from.x;
    const dy = seg.to.y - seg.from.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - seg.from.x) * dx + (p.y - seg.from.y) * dy) / len2 : 0;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const point = pointAt(seg, t);
    return { t, point, distance: Math.hypot(point.x - p.x, point.y - p.y) };
  }
  // 標本の t: 32 等分。向きが急に変わる区間 (急に折り返す曲線の先など) は、さらに細かく分ける
  const ts = nearestSampleParams(seg);
  const n = ts.length - 1;
  const d2: number[] = [];
  // g(t) = (B(t) - p)·B'(t)。距離の 2 乗の微分の半分で、局所的な最小では負から正へ変わる
  const g: number[] = [];
  for (let i = 0; i <= n; i++) {
    const b = pointAt(seg, ts[i]!);
    const d = derivativeAt(seg, ts[i]!);
    d2.push(dist2(b, p));
    g.push((b.x - p.x) * d.x + (b.y - p.y) * d.y);
  }
  let best: NearestPoint = { t: 0, point: pointAt(seg, 0), distance: Math.sqrt(d2[0]!) };
  const consider = (t: number) => {
    const point = pointAt(seg, t);
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    if (distance < best.distance || (distance === best.distance && t < best.t)) {
      best = { t, point, distance };
    }
  };
  consider(1);
  for (let i = 0; i <= n; i++) {
    // 標本の局所的な最小のまわり
    const v = d2[i]!;
    const left = i > 0 ? d2[i - 1]! : Infinity;
    const right = i < n ? d2[i + 1]! : Infinity;
    if (v <= left && v <= right) {
      consider(refineNearest(seg, p, ts[i]!, ts[Math.max(0, i - 1)]!, ts[Math.min(n, i + 1)]!));
    }
    // g が負から正へ変わる区間 (標本の間に隠れた最小も拾う)
    if (i < n && g[i]! < 0 && g[i + 1]! >= 0) {
      const t0 = ts[i]!;
      const t1 = ts[i + 1]!;
      const guess = t0 + ((t1 - t0) * -g[i]!) / (g[i + 1]! - g[i]!);
      consider(refineNearest(seg, p, guess, t0, t1));
    }
  }
  return best;
}

/** 向きの変わり方がこれより大きい区間 (cos で 60°) は細かく分ける。 */
const NEAREST_TURN_COS = 0.5;
/** 細かく分ける深さ (1 段で 4 等分。32 等分の 1 区間を最も細かくて 1/256 に) */
const NEAREST_REFINE_DEPTH = 4;

/**
 * 最近点を探す標本の t (0 と 1 を含む昇順)。32 等分し、両端の接線の向きが 60° より大きく変わる区間
 * (微分が 0 の所を含む) は 4 等分を `NEAREST_REFINE_DEPTH` 段まで繰り返す。急に折り返す曲線では、
 * 1 区間の中で点から遠ざかってまた近づくので、距離の最小が区間の中に 2 つ隠れて見落とされうるため。
 */
function nearestSampleParams(seg: Segment): number[] {
  const out = [0];
  const visit = (t0: number, t1: number, d0: Point, d1: Point, depth: number) => {
    if (depth < NEAREST_REFINE_DEPTH && turnsSharply(d0, d1)) {
      let prevT = t0;
      let prevD = d0;
      for (let k = 1; k <= 4; k++) {
        const t = k === 4 ? t1 : t0 + ((t1 - t0) * k) / 4;
        const d = k === 4 ? d1 : derivativeAt(seg, t);
        visit(prevT, t, prevD, d, depth + 1);
        prevT = t;
        prevD = d;
      }
      return;
    }
    out.push(t1);
  };
  let prev = derivativeAt(seg, 0);
  for (let i = 1; i <= NEAREST_SAMPLES; i++) {
    const t = i / NEAREST_SAMPLES;
    const d = derivativeAt(seg, t);
    visit((i - 1) / NEAREST_SAMPLES, t, prev, d, 0);
    prev = d;
  }
  return out;
}

function turnsSharply(d0: Point, d1: Point): boolean {
  const l0 = Math.hypot(d0.x, d0.y);
  const l1 = Math.hypot(d1.x, d1.y);
  if (l0 === 0 || l1 === 0) return true;
  return d0.x * d1.x + d0.y * d1.y < NEAREST_TURN_COS * l0 * l1;
}

/** [lo, hi] の中で |B(t) - p|² を最小にする t を Newton 法 (後退つき) で求める。 */
function refineNearest(seg: Segment, p: Point, t0: number, lo: number, hi: number): number {
  let t = t0;
  let h = dist2(pointAt(seg, t), p);
  for (let iter = 0; iter < 40; iter++) {
    const b = pointAt(seg, t);
    const d1 = derivativeAt(seg, t);
    const d2 = secondDerivativeAt(seg, t);
    const ex = b.x - p.x;
    const ey = b.y - p.y;
    const g = ex * d1.x + ey * d1.y;
    const gp = d1.x * d1.x + d1.y * d1.y + ex * d2.x + ey * d2.y;
    let next: number;
    if (gp > 0) next = t - g / gp;
    else next = g > 0 ? (lo + t) / 2 : (t + hi) / 2;
    if (next < lo) next = lo;
    if (next > hi) next = hi;
    let hn = dist2(pointAt(seg, next), p);
    let guard = 0;
    while (hn > h && guard++ < 30) {
      next = (t + next) / 2;
      hn = dist2(pointAt(seg, next), p);
    }
    if (hn > h) break;
    const moved = Math.abs(next - t);
    t = next;
    h = hn;
    if (moved <= 1e-15) break;
  }
  return t;
}

// ---------------------------------------------------------------------------
// 長さ
// ---------------------------------------------------------------------------

// 8 点の Gauss–Legendre の節点と重み ([-1, 1])
const GL_X = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GL_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
  0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

/** t0 から t1 までの長さ (t0 > t1 でも正の値)。 */
export function segmentLength(seg: Segment, t0 = 0, t1 = 1): number {
  if (t0 > t1) [t0, t1] = [t1, t0];
  if (seg.kind === "line") {
    return Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) * (t1 - t0);
  }
  if (t1 === t0) return 0;
  return integrateSpeed(seg, t0, t1, gaussSpeed(seg, t0, t1), 0);
}

function gaussSpeed(seg: Segment, a: number, b: number): number {
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  let sum = 0;
  for (let i = 0; i < GL_X.length; i++) {
    const d = derivativeAt(seg, mid + half * GL_X[i]!);
    sum += GL_W[i]! * Math.hypot(d.x, d.y);
  }
  return sum * half;
}

function integrateSpeed(seg: Segment, a: number, b: number, whole: number, depth: number): number {
  const mid = (a + b) / 2;
  const left = gaussSpeed(seg, a, mid);
  const right = gaussSpeed(seg, mid, b);
  const sum = left + right;
  if (depth >= 20 || Math.abs(sum - whole) <= 1e-11 * Math.max(1, Math.abs(sum))) return sum;
  return (
    integrateSpeed(seg, a, mid, left, depth + 1) + integrateSpeed(seg, mid, b, right, depth + 1)
  );
}

/** 始点からの長さが `length` になる t。0 以下なら 0、全長以上なら 1。 */
export function tAtLength(seg: Segment, length: number): number {
  if (!(length > 0)) return 0;
  const total = segmentLength(seg);
  if (length >= total) return 1;
  if (seg.kind === "line") return length / total;
  const tol = 1e-9 * (1 + total);
  let lo = 0;
  let hi = 1;
  let t = length / total;
  for (let iter = 0; iter < 60; iter++) {
    const f = segmentLength(seg, 0, t) - length;
    if (Math.abs(f) <= tol) return t;
    if (f > 0) hi = t;
    else lo = t;
    const d = derivativeAt(seg, t);
    const speed = Math.hypot(d.x, d.y);
    let next = speed > 0 ? t - f / speed : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    t = next;
  }
  return t;
}

// ---------------------------------------------------------------------------
// 折れ線化
// ---------------------------------------------------------------------------

/**
 * 曲線を折れ線にした点の並び (始点と終点を含む)。曲線と折れ線の距離は `tolerance` 以下。
 * 線分は端の 2 点。
 */
export function flattenSegment(seg: Segment, tolerance: number): Point[] {
  return flattenSegmentParams(seg, tolerance).map((t) => pointAt(seg, t));
}

/** `flattenSegment` の点の t (0 と 1 を含む昇順)。 */
export function flattenSegmentParams(seg: Segment, tolerance: number): number[] {
  if (seg.kind === "line") return [0, 1];
  const tol = Math.max(tolerance, MIN_FLATTEN_TOLERANCE, segmentMagnitude(seg) * RELATIVE_EPSILON);
  const out: number[] = [0];
  flattenInto(seg, 0, 1, tol, 0, out);
  return out;
}

function flattenInto(
  part: CubicSegment,
  t0: number,
  t1: number,
  tol: number,
  depth: number,
  out: number[],
): void {
  if (depth >= MAX_FLATTEN_DEPTH || cubicFlatness(part) <= tol) {
    out.push(t1);
    return;
  }
  const [a, b] = splitSegment(part, 0.5) as [CubicSegment, CubicSegment];
  const mid = (t0 + t1) / 2;
  flattenInto(a, t0, mid, tol, depth + 1, out);
  flattenInto(b, mid, t1, tol, depth + 1, out);
}

/** 制御点から弦 (始点と終点を結ぶ線分) までの距離の最大。曲線と弦の距離の上限。 */
export function cubicFlatness(seg: CubicSegment): number {
  return Math.max(
    distanceToLineSegment(seg.c1, seg.from, seg.to),
    distanceToLineSegment(seg.c2, seg.from, seg.to),
  );
}

/** 3 次ベジェが (許容値の中で) まっすぐか。制御点がすべて弦の上にある。 */
export function isStraight(seg: Segment, tolerance: number): boolean {
  return seg.kind === "line" || cubicFlatness(seg) <= tolerance;
}

/** すべての制御点が `tolerance` 以内に集まっている (長さがほぼ 0)。 */
export function isDegenerate(seg: Segment, tolerance: number): boolean {
  for (const p of controlPoints(seg)) {
    if (Math.hypot(p.x - seg.from.x, p.y - seg.from.y) > tolerance) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 小さな道具 (ほかのファイルでも使う)
// ---------------------------------------------------------------------------

export function lerp(a: number, b: number, t: number): number {
  return (1 - t) * a + t * b;
}

function mix(p: Point, q: Point, t: number): Point {
  return { x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) };
}

export function dist2(p: Point, q: Point): number {
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  return dx * dx + dy * dy;
}

export function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

function normalize(v: Point): Point {
  const len = Math.hypot(v.x, v.y);
  return { x: v.x / len, y: v.y / len };
}

/** 点 `p` から線分 a–b までの距離。 */
export function distanceToLineSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * a·t² + b·t + c = 0 の実数解 (重解は 1 個)。a が b, c に比べてごく小さければ 1 次式として解く。
 * 桁落ちを避ける形 (q = -(b + sign(b)√D)/2) で求める。
 */
export function solveQuadratic(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  if (Math.abs(a) <= 1e-12 * scale) {
    return Math.abs(b) <= 1e-12 * scale ? [] : [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    // 丸めで少しだけ負になった重解
    if (disc > -1e-14 * b * b) return [-b / (2 * a)];
    return [];
  }
  if (disc === 0) return [-b / (2 * a)];
  const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(disc)) / 2;
  const r1 = q / a;
  const r2 = q !== 0 ? c / q : -r1;
  return r1 === r2 ? [r1] : [r1, r2];
}
