/**
 * なぞった点を 3 次ベジェに当てはめる (`docs/canvas-editor-design.md` §4.14)。純関数。
 *
 * Schneider の方法 ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems, 1990):
 * 1. 弦の長さで各点のパラメーターを決め、両端の接線の向きを固定して最小二乗で制御点を求める
 * 2. いちばん離れた点の距離が誤差以内なら終える。誤差の 4 倍以内なら、Newton 法でパラメーターを直して
 *    やり直す (最大 `MAX_ITERATIONS` 回)
 * 3. それでも収まらなければ、いちばん離れた点で 2 つに分け、そこでの接線 (前後の点の差) を両方に使って
 *    再帰する。分けた点の前後は向きがそろう (G1)
 *
 * 足したもの:
 * - 角: 当てはめの前に、向きが `CORNER_ANGLE` 度より大きく曲がる点を角として探し (`findCorners`)、そこで
 *   分けてから別々に当てはめる。角の前後は接線を別にする (向きがそろわない)。曲がり具合は、前後に誤差の
 *   `CORNER_SPAN` 倍以上離れた点への向きで見る (細かな手ぶれを角にしない)
 * - 誤差は、点の位置に加えて、隣り合う点の中点 (曲線ではパラメーターの中間) でも確かめる (点の間隔が広い
 *   速いなぞりで、点の間で曲線が離れないように)
 *
 * - 入力は同じ座標系の点の列 (鉛筆では親の座標系)。続けて同じ点は 1 つにまとめる
 * - 結果は曲線の列 `[p0, c1, c2, p3]`。隣り合う曲線の端は同じ点。点が 1 個 (まとめた後) なら空。
 *   つなぎ目が滑らかか角かは、つなぎ目の前後のハンドルの向きで分かる (`isSmoothJoin`)
 * - 点が 2 個 (まとめた後) なら、1 本の曲線 (制御点は弦の 1/3 と 2/3。見た目は直線)
 * - 分けていって点が 2 個だけになった区間は、ハンドルを短くして弦から誤差以内にする (向きは変えないので、
 *   つなぎ目の滑らかさは保つ)
 */
import type { Point } from "../model/types";

export type CubicCurve = readonly [Point, Point, Point, Point];

/** パラメーターを直す回数の上限。 */
const MAX_ITERATIONS = 4;
/** 分けるかどうかの境: 誤差のこの倍以内なら、分けずにパラメーターを直す。 */
const REPARAMETERIZE_FACTOR = 4;
/** 同じ点とみなす距離。 */
const SAME_POINT = 1e-9;
/** 角とみなす曲がりの角度 (度)。 */
export const CORNER_ANGLE = 70;
/** 曲がり具合を見るとき、前後の点をこの長さ (誤差の倍) 以上離して取る。 */
export const CORNER_SPAN = 3;
/** 前後の点を探す数の上限 (点が密で誤差が大きいときに遅くならないように)。 */
const SPAN_SEARCH_LIMIT = 50;

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
  const span = tolerance * CORNER_SPAN;
  const ends = [0, ...findCorners(pts, span), pts.length - 1];
  const out: CubicCurve[] = [];
  for (let k = 0; k + 1 < ends.length; k++) {
    const first = ends[k] as number;
    const last = ends[k + 1] as number;
    const left = endTangent(pts, first, last, 1, span);
    const right = endTangent(pts, last, first, -1, span);
    // 再帰の代わりに積む (点が数万個でも呼び出しが深くならないように)。左の半分を先に取り出す
    const stack: Task[] = [{ first, last, tHat1: left, tHat2: right }];
    for (let task = stack.pop(); task; task = stack.pop()) {
      const result = fitCubic(pts, task, tolerance);
      if ("left" in result) stack.push(result.right, result.left);
      else out.push(result);
    }
  }
  return out;
}

/**
 * 端 `from` から `to` の向き (`step` は +1 か -1) への接線。`span` 以上離れた最初の点への向き
 * (`to` を越えず、探すのは `SPAN_SEARCH_LIMIT` 個まで)。
 */
function endTangent(
  pts: readonly Point[],
  from: number,
  to: number,
  step: 1 | -1,
  span: number,
): Point {
  const at = pts[from] as Point;
  let i = from + step;
  for (let n = 1; i !== to && n < SPAN_SEARCH_LIMIT; n++, i += step)
    if (dist(pts[i] as Point, at) >= span) break;
  // 続けて同じ点はまとめてあるので、隣の点への向きは必ず求まる
  return (
    normalize(sub(pts[i] as Point, at)) ?? (normalize(sub(pts[from + step] as Point, at)) as Point)
  );
}

/** `i` から `step` の向きに、`span` 以上離れた最初の点 (なければ端の点)。 */
function reach(pts: readonly Point[], i: number, step: 1 | -1, span: number): number {
  const at = pts[i] as Point;
  let j = i + step;
  for (let n = 1; n < SPAN_SEARCH_LIMIT; n++) {
    const next = j + step;
    if (next < 0 || next >= pts.length || dist(pts[j] as Point, at) >= span) break;
    j = next;
  }
  return j;
}

/**
 * 角の点の位置 (両端を除く、小さい順)。前後に `span` 以上離れた点への向きが `CORNER_ANGLE` 度より大きく曲がる
 * 点を候補にし、`span` 以内に続く候補からは最も曲がる点だけを残す。
 */
export function findCorners(pts: readonly Point[], span: number): number[] {
  const threshold = Math.cos((CORNER_ANGLE * Math.PI) / 180);
  const candidates: { index: number; cos: number }[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const at = pts[i] as Point;
    const a = normalize(sub(at, pts[reach(pts, i, -1, span)] as Point));
    const b = normalize(sub(pts[reach(pts, i, 1, span)] as Point, at));
    if (!a || !b) continue;
    const cos = dot(a, b);
    if (cos < threshold) candidates.push({ index: i, cos });
  }
  const corners: number[] = [];
  let best: { index: number; cos: number } | null = null;
  let previous = -1;
  for (const c of candidates) {
    const near =
      best !== null &&
      previous >= 0 &&
      (c.index - previous <= 1 || dist(pts[c.index] as Point, pts[previous] as Point) <= span);
    if (!near) {
      if (best) corners.push(best.index);
      best = c;
    } else if (best && c.cos < best.cos) best = c;
    previous = c.index;
  }
  if (best) corners.push(best.index);
  return corners;
}

/**
 * 曲線 `before` の終わりと `after` の始まりのつなぎ目が滑らか (前後のハンドルが反対向きで一直線) か。
 * どちらかのハンドルの長さが 0 なら角とする。
 */
export function isSmoothJoin(before: CubicCurve, after: CubicCurve): boolean {
  const at = after[0];
  const u = normalize(sub(at, before[2]));
  const v = normalize(sub(after[1], at));
  if (!u || !v) return false;
  return dot(u, v) > 0 && Math.abs(u.x * v.y - u.y * v.x) < 1e-6;
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
    // 点が 2 個だけの区間は、弦の 1/3 の長さで両端の接線に沿ったハンドルにする。弦 (なぞった折れ線) から誤差より
    // 離れるなら、ハンドルを短くする (向きは変えない)。ずれは弦の上の点から k(h1·b1 + h2·b2) で、b1・b2 の最大は
    // どちらも 4/9 なので、長さ d のハンドルなら 8d/9 以下。まず測って縮め、収まらなければこの上限で決める
    const curveFor = (d: number): CubicCurve => [
      p0,
      add(p0, scale(tHat1, d)),
      add(p3, scale(tHat2, d)),
      p3,
    ];
    let d = dist(p0, p3) / 3;
    for (let i = 0; i < 4; i++) {
      const deviation = chordDeviation(curveFor(d));
      if (deviation <= error) return curveFor(d);
      d *= (error / deviation) * 0.99;
    }
    d = Math.min(d, (9 * error) / 8);
    return curveFor(d);
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

/** 曲線が弦 (両端を結ぶ線分) から離れる最大の距離 (細かく刻んで測る)。 */
function chordDeviation(c: CubicCurve): number {
  const a = c[0];
  const b = c[3];
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  let max = 0;
  for (let i = 1; i < 32; i++) {
    const p = bezierPoint(c, i / 32);
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
    max = Math.max(max, dist(p, add(a, scale(ab, t))));
  }
  return max;
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

/**
 * いちばん離れた所 (距離の 2 乗) と、分ける点の位置 (両端を除く)。点と、隣り合う点の中点 (曲線ではパラメーターの
 * 中間) の両方を見る。中点がいちばん離れていれば、その両側の点のうち端でない方で分ける。
 */
function computeMaxError(
  pts: readonly Point[],
  first: number,
  last: number,
  curve: CubicCurve,
  u: readonly number[],
): { max: number; split: number } {
  let max = 0;
  let split = Math.floor((last - first + 1) / 2) + first;
  const distSq = (p: Point, q: Point) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
  for (let i = first; i < last; i++) {
    const a = pts[i] as Point;
    const b = pts[i + 1] as Point;
    const ta = u[i - first] as number;
    const tb = u[i + 1 - first] as number;
    if (i > first) {
      const d = distSq(bezierPoint(curve, ta), a);
      if (d >= max) {
        max = d;
        split = i;
      }
    }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = distSq(bezierPoint(curve, (ta + tb) / 2), mid);
    if (d > max) {
      max = d;
      split = i > first ? i : i + 1;
    }
  }
  return { max, split };
}
