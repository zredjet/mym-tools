/**
 * なぞった点を 3 次ベジェに当てはめる (`docs/canvas-editor-design.md` §8.8)。純関数。
 *
 * Schneider の方法 ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems, 1990):
 * 1. 弦の長さで各点のパラメーターを決め、両端の接線の向きを固定して最小二乗で制御点を求める
 * 2. いちばん離れた点の距離が誤差以内なら終える。誤差の 4 倍以内なら、Newton 法でパラメーターを直して
 *    やり直す (最大 `MAX_ITERATIONS` 回)
 * 3. それでも収まらなければ、いちばん離れた点で 2 つに分け、そこでの接線 (前後の点の差) を両方に使って
 *    再帰する。分けた点の前後は向きがそろう (G1)
 *
 * - 入力は同じ座標系の点の列 (鉛筆では親の座標系)。続けて同じ点は 1 つにまとめる
 * - 結果は曲線の列 `[p0, c1, c2, p3]`。隣り合う曲線の端は同じ点。点が 1 個 (まとめた後) なら空
 * - 点が 2 個 (まとめた後) なら、1 本の曲線 (制御点は弦の 1/3 と 2/3。見た目は直線)
 */
import type { Point } from "../model/types";

export type CubicCurve = readonly [Point, Point, Point, Point];

/** パラメーターを直す回数の上限。 */
const MAX_ITERATIONS = 4;
/** 分けるかどうかの境: 誤差のこの倍以内なら、分けずにパラメーターを直す。 */
const REPARAMETERIZE_FACTOR = 4;
/** 同じ点とみなす距離。 */
const SAME_POINT = 1e-9;

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

function normalize(v: Point): Point | null {
  const length = Math.hypot(v.x, v.y);
  return length > SAME_POINT ? { x: v.x / length, y: v.y / length } : null;
}

/** 続けて同じ点をまとめる (向きを求められなくなるため)。 */
export function dedupePoints(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (last && dist(last, p) <= SAME_POINT) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * 点の列を 3 次ベジェの列に当てはめる。どの点も、曲線から `error` 以内 (同じ座標系の長さ) になる。
 * `error` が 0 以下か数でなければ、最小の値 (1e-6) にする。
 */
export function fitCurve(points: readonly Point[], error: number): CubicCurve[] {
  const pts = dedupePoints(points);
  if (pts.length < 2) return [];
  const tolerance = Number.isFinite(error) && error > 0 ? error : 1e-6;
  const first = pts[0] as Point;
  const last = pts[pts.length - 1] as Point;
  const left = normalize(sub(pts[1] as Point, first)) as Point;
  const right = normalize(sub(pts[pts.length - 2] as Point, last)) as Point;
  const out: CubicCurve[] = [];
  // 再帰の代わりに積む (点が数万個でも呼び出しが深くならないように)。左の半分を先に取り出す
  const stack: Task[] = [{ first: 0, last: pts.length - 1, tHat1: left, tHat2: right }];
  for (let task = stack.pop(); task; task = stack.pop()) {
    const result = fitCubic(pts, task, tolerance);
    if ("left" in result) stack.push(result.right, result.left);
    else out.push(result);
  }
  return out;
}

interface Task {
  first: number;
  last: number;
  tHat1: Point;
  tHat2: Point;
}

/** 1 本で収まればその曲線、収まらなければ分けた 2 つの仕事。 */
function fitCubic(
  pts: readonly Point[],
  { first, last, tHat1, tHat2 }: Task,
  error: number,
): CubicCurve | { left: Task; right: Task } {
  const p0 = pts[first] as Point;
  const p3 = pts[last] as Point;
  if (last - first === 1) {
    const d = dist(p0, p3) / 3;
    return [p0, add(p0, scale(tHat1, d)), add(p3, scale(tHat2, d)), p3];
  }

  let u = chordLengthParameterize(pts, first, last);
  let curve = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { max, split } = computeMaxError(pts, first, last, curve, u);
  const errorSq = error * error;
  if (max <= errorSq) return curve;

  if (max <= errorSq * REPARAMETERIZE_FACTOR) {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const next = reparameterize(pts, first, u, curve);
      if (!next) break;
      u = next;
      curve = generateBezier(pts, first, last, u, tHat1, tHat2);
      ({ max, split } = computeMaxError(pts, first, last, curve, u));
      if (max <= errorSq) return curve;
    }
  }

  // 分けた点の接線。前後の点の差 (前後が同じ点なら、前の点からの向き)
  const at = pts[split] as Point;
  const center =
    normalize(sub(pts[split - 1] as Point, pts[split + 1] as Point)) ??
    normalize(sub(pts[split - 1] as Point, at)) ??
    normalize(sub(at, pts[split + 1] as Point)) ??
    tHat2;
  return {
    left: { first, last: split, tHat1, tHat2: center },
    right: { first: split, last, tHat1: scale(center, -1), tHat2 },
  };
}

/** 両端の接線の向きを固定し、制御点までの長さを最小二乗で求める。 */
function generateBezier(
  pts: readonly Point[],
  first: number,
  last: number,
  u: readonly number[],
  tHat1: Point,
  tHat2: Point,
): CubicCurve {
  const p0 = pts[first] as Point;
  const p3 = pts[last] as Point;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i] as number;
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * t * mt * mt;
    const b2 = 3 * t * t * mt;
    const b3 = t * t * t;
    const a1 = scale(tHat1, b1);
    const a2 = scale(tHat2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const shortfall = sub(pts[first + i] as Point, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
    x0 += dot(a1, shortfall);
    x1 += dot(a2, shortfall);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = 0;
  let alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  }
  // 長さが負かほぼ 0 なら当てはめが崩れているので、Wu と Barsky の目安 (弦の 1/3) にする
  const segLength = dist(p0, p3);
  const epsilon = 1e-6 * segLength;
  if (!(alpha1 > epsilon) || !(alpha2 > epsilon)) {
    alpha1 = alpha2 = segLength / 3;
  }
  return [p0, add(p0, scale(tHat1, alpha1)), add(p3, scale(tHat2, alpha2)), p3];
}

function chordLengthParameterize(pts: readonly Point[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++)
    u.push((u[u.length - 1] as number) + dist(pts[i] as Point, pts[i - 1] as Point));
  const total = u[u.length - 1] as number;
  return total > 0 ? u.map((v) => v / total) : u.map((_, i) => i / (u.length - 1));
}

export function bezierPoint(c: CubicCurve, t: number): Point {
  const mt = 1 - t;
  const b0 = mt * mt * mt;
  const b1 = 3 * t * mt * mt;
  const b2 = 3 * t * t * mt;
  const b3 = t * t * t;
  return {
    x: c[0].x * b0 + c[1].x * b1 + c[2].x * b2 + c[3].x * b3,
    y: c[0].y * b0 + c[1].y * b1 + c[2].y * b2 + c[3].y * b3,
  };
}

function bezierDerivative(c: CubicCurve, t: number): Point {
  const mt = 1 - t;
  const d0 = sub(c[1], c[0]);
  const d1 = sub(c[2], c[1]);
  const d2 = sub(c[3], c[2]);
  return add(add(scale(d0, 3 * mt * mt), scale(d1, 6 * mt * t)), scale(d2, 3 * t * t));
}

function bezierSecondDerivative(c: CubicCurve, t: number): Point {
  const e0 = add(sub(c[2], scale(c[1], 2)), c[0]);
  const e1 = add(sub(c[3], scale(c[2], 2)), c[1]);
  return add(scale(e0, 6 * (1 - t)), scale(e1, 6 * t));
}

/** Newton 法で各点のパラメーターを曲線の最も近い所へ寄せる。並びが崩れたら null (直さない)。 */
function reparameterize(
  pts: readonly Point[],
  first: number,
  u: readonly number[],
  curve: CubicCurve,
): number[] | null {
  const next = u.map((t, i) => {
    const p = pts[first + i] as Point;
    const diff = sub(bezierPoint(curve, t), p);
    const d1 = bezierDerivative(curve, t);
    const d2 = bezierSecondDerivative(curve, t);
    const numerator = dot(diff, d1);
    const denominator = dot(d1, d1) + dot(diff, d2);
    if (Math.abs(denominator) < 1e-12) return t;
    const moved = t - numerator / denominator;
    return Math.min(1, Math.max(0, moved));
  });
  for (let i = 1; i < next.length; i++)
    if ((next[i] as number) <= (next[i - 1] as number)) return null;
  return next;
}

/** いちばん離れた点 (距離の 2 乗) と、その位置 (両端を除く)。 */
function computeMaxError(
  pts: readonly Point[],
  first: number,
  last: number,
  curve: CubicCurve,
  u: readonly number[],
): { max: number; split: number } {
  let max = 0;
  let split = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const p = bezierPoint(curve, u[i - first] as number);
    const d = (p.x - (pts[i] as Point).x) ** 2 + (p.y - (pts[i] as Point).y) ** 2;
    if (d >= max) {
      max = d;
      split = i;
    }
  }
  return { max, split };
}
