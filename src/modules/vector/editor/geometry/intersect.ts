/**
 * 線分と 3 次ベジェの交点 (`docs/canvas-editor-design.md` §8.9.3 のブーリアン演算の土台)。
 *
 * 返すもの:
 * - `intersectSegments(a, b)` は `{ intersections, overlaps, complete }`
 *   - `intersections`: 1 点で交わる・接する所。`t1` は a、`t2` は b の媒介変数。t1 の昇順
 *   - `overlaps`: 同じ曲線の一部が重なっている区間。`t1` は a の区間 (昇順)、`t2` はそれに対応する b の区間
 *     (`t2[0]` の点が `t1[0]` の点と同じ。b が逆向きに重なれば `t2[0] > t2[1]`)。重なりの端は交点には入れない
 *   - 重なりと交点は排他: 重なりがある組では交点を返さない (多項式の曲線が一部で重なるなら同じ曲線の一部なので、
 *     ほかの所で交わるのは元の曲線の自己交差だけ。そこは扱わない)
 *   - `complete`: 探し尽くしたか。曲線同士で調べる組が上限 (`MAX_PAIRS`) に達して打ち切ったときだけ false。
 *     false の結果は交点が欠けているかもしれない。ブーリアン演算はこのとき求められなかった (`null`) とする
 *   - 返す配列は呼び出しごとに新しい (足したり変えたりしても、ほかの呼び出しの結果に混ざらない)
 * - `selfIntersection(seg)` は 3 次ベジェ 1 本の自己交差 (輪) の点 (`t1 < t2`)。なければ null。
 *   3 次ベジェの自己交差は高々 1 つ。交点が端点に許容値以内なら t は 0 / 1 ちょうど、点は端点そのもの
 *
 * 誤差と前提:
 * - 許容値 `tolerance` (px) は既定で `toleranceFor(2 本の座標の大きさ)` (= max(1e-7, 大きさ × 1e-10))。
 *   2 本の距離が許容値以内なら交わっているとみなす。接している (触れているだけの) 所も 1 点として返す。
 *   `path/segments.ts` の「閉じている」の判定も同じ許容値を使う
 * - 端点はちょうどの値にする: 端点が相手の曲線から許容値以内なら、その t は 0 か 1 ちょうど。点 `point` は、
 *   端点なら端点の値そのもの (a の端点を優先)、そうでなければ a の上の点
 * - 継ぎ目の近くの交点は重なって報告されうる: 輪郭の隣り合う 2 本の継ぎ目 (前の曲線の t = 1 と次の曲線の
 *   t = 0) の近くを相手が横切ると、両方の組が同じ交点を (許容値の中でずれた t で) 返す。ブーリアン演算は、
 *   許容値以内の交点を 1 つにまとめる前提で使う
 * - `tangent` は 2 本の向きがほぼ平行 (sin の絶対値が `TANGENT_EPSILON` 以下) な交点。触れているだけか
 *   横切るかは決めない (呼び出し側が両側の巻き数 `windingsBeside` で決める)。重なった線分同士が 1 点だけで
 *   接する所も `tangent`
 * - まっすぐな曲線 (制御点が弦から許容値以内) は線分として扱う。媒介変数は最近点で戻す。折り返す
 *   (制御点が弦の外へ出る) まっすぐな曲線の重なりの t は、最近点で選んだ側になる
 * - 線分と曲線: 曲線を線分の向きへ回し、距離の 3 次式の根を、微分の根で区切った単調な区間ごとに挟み撃ちで
 *   求める。区切りの点の値が許容値以内なら 0 とみなす (接する所はここで 1 点になる)
 * - 曲線と曲線: 端点を調べたうえで、組を次の順に調べる (`search`)
 *   1. 制御点の範囲が重ならない、または片方が相手の fat line (弦からの距離の帯) の外にあれば交わらない
 *   2. 両方が共通の向きのグラフ (制御点の辺がどれもその向きから 30° 以内) なら、その向きの座標 s で
 *      2 本の法線方向の差 h(s) を直接解く (`solveAsGraphs`): 厳密な h' と h'' で h の極値を求めて h が単調な
 *      区間に分け、区間ごとに符号の変化を挟み撃ちで詰める。極値の |h| が許容値以内なら接する点 1 つ。
 *      寄り添う曲線 (1e-5〜1 px 離れたもの) も、端点を共有して端のすぐ近くで交わる曲線も、深く分けずに解ける
 *   3. 両方が十分平ら (弦からのずれが max(許容値, 大きさ × 1e-6)) なら、弦の最近点から Newton 法で詰める
 *      (接して行列が潰れる所は交互の射影)
 *   4. それ以外は大きい方 (または両方) を半分に分ける
 *   1 回の目安 (幅 100 px の曲線): 横切る・接する組は 0.02〜0.06 ms、1〜1e-5 px 離れて寄り添う組は
 *   0.02〜0.05 ms。落としうるのは、h の極値が標本の 1 区間 (共通の範囲の 1/16) に 3 つ以上集まる形だけ
 */
import type { Point } from "../model/types";
import {
  type Bounds,
  boundsOverlap,
  controlBounds,
  type CubicSegment,
  cross,
  derivativeAt,
  distance,
  dot,
  isStraight,
  nearestPoint,
  pointAt,
  type Segment,
  segmentMagnitude,
  solveQuadratic,
  splitSegment,
  subSegment,
  tangentAt,
  toleranceFor,
} from "./bezier";

export interface SegmentIntersection {
  /** a の媒介変数 */
  t1: number;
  /** b の媒介変数 */
  t2: number;
  point: Point;
  /** 2 本の向きがほぼ平行 */
  tangent: boolean;
}

export interface SegmentOverlap {
  /** a の区間 (`t1[0] < t1[1]`) */
  t1: [number, number];
  /** 対応する b の区間 (`t2[0]` が `t1[0]` に対応) */
  t2: [number, number];
}

export interface IntersectionResult {
  intersections: SegmentIntersection[];
  overlaps: SegmentOverlap[];
  /**
   * 探し尽くしたか。曲線同士で調べる組が `MAX_PAIRS` に達して打ち切ったときだけ false
   * (見つからなかった交点がありうる)。ブーリアン演算はこのとき結果を求められなかった (`null`) とする
   */
  complete: boolean;
}

export interface IntersectOptions {
  /** 交わるとみなす距離 (px)。省くと座標の大きさから決める */
  tolerance?: number;
  /** 曲線同士で調べる組の数の上限。省くと `MAX_PAIRS` (テストで打ち切りを起こすのに使う) */
  maxPairs?: number;
}

/** `tangent` とみなす向きの sin の絶対値の上限。 */
export const TANGENT_EPSILON = 1e-4;
/** 同じ交点とみなす媒介変数の差。 */
export const PARAM_EPSILON = 1e-9;
/** 曲線と曲線の分割で調べる組の数の上限。 */
export const MAX_PAIRS = 4096;

/** 毎回新しい空の結果 (呼び出し側が配列に足しても、ほかの結果に混ざらない)。 */
function empty(): IntersectionResult {
  return { intersections: [], overlaps: [], complete: true };
}

export function intersectSegments(
  a: Segment,
  b: Segment,
  options: IntersectOptions = {},
): IntersectionResult {
  const tol = options.tolerance ?? toleranceFor(Math.max(segmentMagnitude(a), segmentMagnitude(b)));
  if (!boundsOverlap(controlBounds(a), controlBounds(b), tol)) return empty();
  const aStraight = isStraight(a, tol);
  const bStraight = isStraight(b, tol);
  let result: IntersectionResult;
  if (aStraight && bStraight) result = intersectStraight(a, b, tol);
  else if (aStraight) result = intersectStraightCurve(a, b as CubicSegment, tol);
  else if (bStraight) result = swap(intersectStraightCurve(b, a as CubicSegment, tol));
  else {
    result = intersectCurves(
      a as CubicSegment,
      b as CubicSegment,
      tol,
      options.maxPairs ?? MAX_PAIRS,
    );
  }
  return finish(a, b, result);
}

/** 3 次ベジェ 1 本の自己交差。なければ null。線分とまっすぐな曲線は null。 */
export function selfIntersection(
  seg: Segment,
  options: IntersectOptions = {},
): SegmentIntersection | null {
  if (seg.kind === "line") return null;
  const tol = options.tolerance ?? toleranceFor(segmentMagnitude(seg));
  if (isStraight(seg, tol)) return null;
  // P(t) = a t³ + b t² + c t + d。P(t) = P(s) を (t - s) で割ると a(σ² - π) + bσ + c = 0 (σ = t + s, π = ts)
  const a = {
    x: -seg.from.x + 3 * seg.c1.x - 3 * seg.c2.x + seg.to.x,
    y: -seg.from.y + 3 * seg.c1.y - 3 * seg.c2.y + seg.to.y,
  };
  const b = {
    x: 3 * seg.from.x - 6 * seg.c1.x + 3 * seg.c2.x,
    y: 3 * seg.from.y - 6 * seg.c1.y + 3 * seg.c2.y,
  };
  const c = { x: 3 * (seg.c1.x - seg.from.x), y: 3 * (seg.c1.y - seg.from.y) };
  const den = a.y * b.x - a.x * b.y;
  const scale = Math.max(Math.abs(a.x), Math.abs(a.y)) * Math.max(Math.abs(b.x), Math.abs(b.y));
  if (scale === 0 || Math.abs(den) <= 1e-12 * scale) return null;
  const sigma = (a.x * c.y - a.y * c.x) / den;
  const pi =
    Math.abs(a.x) >= Math.abs(a.y)
      ? sigma * sigma + (b.x * sigma + c.x) / a.x
      : sigma * sigma + (b.y * sigma + c.y) / a.y;
  const disc = sigma * sigma - 4 * pi;
  if (!(disc > 0)) return null;
  const r = Math.sqrt(disc);
  let t1 = (sigma - r) / 2;
  let t2 = (sigma + r) / 2;
  const slack = 1e-9;
  if (t1 < -slack || t2 > 1 + slack) return null;
  t1 = clamp01(t1);
  t2 = clamp01(t2);
  if (t2 - t1 < 1e-7) return null; // 尖点 (輪が潰れた形)
  const refined = refinePair(seg, seg, t1, t2, tol);
  if (refined && refined.t2 - refined.t1 >= 1e-7) {
    t1 = refined.t1;
    t2 = refined.t2;
  }
  if (distance(pointAt(seg, t1), pointAt(seg, t2)) > tol) return null;
  // 端点に許容値以内なら 0 / 1 ちょうど (輪の一部を切り出した曲線で、交点が端点に来る場合)
  if (distance(pointAt(seg, t1), seg.from) <= tol) t1 = 0;
  if (distance(pointAt(seg, t2), seg.to) <= tol) t2 = 1;
  if (t2 - t1 < 1e-7) return null;
  return {
    t1,
    t2,
    point: t1 === 0 ? { ...seg.from } : t2 === 1 ? { ...seg.to } : pointAt(seg, t1),
    tangent: isTangent(seg, t1, seg, t2),
  };
}

// ---------------------------------------------------------------------------
// まっすぐなもの同士
// ---------------------------------------------------------------------------

interface Extent {
  from: Point;
  to: Point;
}

/** まっすぐな曲線が覆う線分 (折り返す曲線は折り返した先まで)。 */
function straightExtent(seg: Segment): Extent {
  if (seg.kind === "line") return { from: seg.from, to: seg.to };
  let dx = seg.to.x - seg.from.x;
  let dy = seg.to.y - seg.from.y;
  if (dx === 0 && dy === 0) {
    // 始点と終点が同じ: 最も遠い制御点の向き
    const far = [seg.c1, seg.c2].reduce((p, q) =>
      distance(p, seg.from) >= distance(q, seg.from) ? p : q,
    );
    dx = far.x - seg.from.x;
    dy = far.y - seg.from.y;
    if (dx === 0 && dy === 0) return { from: seg.from, to: seg.to };
  }
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const proj = (p: Point) => (p.x - seg.from.x) * ux + (p.y - seg.from.y) * uy;
  let lo = 0;
  let hi = proj(seg.to);
  let loPoint = seg.from;
  let hiPoint = seg.to;
  if (hi < lo) {
    [lo, hi] = [hi, lo];
    [loPoint, hiPoint] = [hiPoint, loPoint];
  }
  const p = [proj(seg.from), proj(seg.c1), proj(seg.c2), proj(seg.to)];
  const A = p[1]! - p[0]!;
  const B = p[2]! - p[1]!;
  const C = p[3]! - p[2]!;
  for (const t of solveQuadratic(A - 2 * B + C, 2 * (B - A), A)) {
    if (!(t > 0 && t < 1)) continue;
    const q = pointAt(seg, t);
    const s = proj(q);
    if (s < lo) {
      lo = s;
      loPoint = q;
    } else if (s > hi) {
      hi = s;
      hiPoint = q;
    }
  }
  return { from: loPoint, to: hiPoint };
}

/** まっすぐな曲線の上の点 `p` の媒介変数。端点に許容値以内なら 0 か 1 ちょうど。 */
function paramOnStraight(seg: Segment, p: Point, tol: number): number {
  const d0 = distance(p, seg.from);
  const d1 = distance(p, seg.to);
  if (d0 <= tol && d0 <= d1) return 0;
  if (d1 <= tol) return 1;
  return nearestPoint(seg, p).t;
}

function intersectStraight(a: Segment, b: Segment, tol: number): IntersectionResult {
  const A = straightExtent(a);
  const B = straightExtent(b);
  const lenA = distance(A.from, A.to);
  const lenB = distance(B.from, B.to);
  if (lenA <= tol || lenB <= tol) {
    // 長さがほぼ 0: 点として相手に触れているか
    if (lenA <= tol) {
      const np = nearestPoint(b, a.from);
      if (np.distance > tol) return empty();
      return single(0, paramOnStraight(b, a.from, tol), a.from, true);
    }
    const np = nearestPoint(a, b.from);
    if (np.distance > tol) return empty();
    return single(paramOnStraight(a, b.from, tol), 0, b.from, true);
  }

  const onA = (p: Point) => distanceToInfiniteLine(p, A) <= tol;
  const onB = (p: Point) => distanceToInfiniteLine(p, B) <= tol;
  const collinear = (onA(B.from) && onA(B.to)) || (onB(A.from) && onB(A.to));
  if (collinear) {
    const base = lenA >= lenB ? A : B;
    const len = Math.max(lenA, lenB);
    const ux = (base.to.x - base.from.x) / len;
    const uy = (base.to.y - base.from.y) / len;
    const proj = (p: Point) => (p.x - base.from.x) * ux + (p.y - base.from.y) * uy;
    const sa = [proj(A.from), proj(A.to)].sort((x, y) => x - y) as [number, number];
    const sb = [proj(B.from), proj(B.to)].sort((x, y) => x - y) as [number, number];
    const lo = Math.max(sa[0], sb[0]);
    const hi = Math.min(sa[1], sb[1]);
    if (hi < lo - tol) return empty();
    const at = (s: number): Point => ({ x: base.from.x + ux * s, y: base.from.y + uy * s });
    // 重なりの端は、近ければ元の端点そのものを使う (t を 0 か 1 ちょうどにするため)
    const endpoints = [a.from, a.to, b.from, b.to];
    const snap = (p: Point): Point => endpoints.find((q) => distance(p, q) <= tol) ?? p;
    if (hi - lo <= tol) {
      const p = snap(at((lo + hi) / 2));
      return single(paramOnStraight(a, p, tol), paramOnStraight(b, p, tol), p, true);
    }
    const p0 = snap(at(lo));
    const p1 = snap(at(hi));
    let ta0 = paramOnStraight(a, p0, tol);
    let ta1 = paramOnStraight(a, p1, tol);
    let tb0 = paramOnStraight(b, p0, tol);
    let tb1 = paramOnStraight(b, p1, tol);
    if (ta0 > ta1) {
      [ta0, ta1] = [ta1, ta0];
      [tb0, tb1] = [tb1, tb0];
    }
    return { intersections: [], overlaps: [{ t1: [ta0, ta1], t2: [tb0, tb1] }], complete: true };
  }

  // 1 点で交わるか。端点が相手に触れていれば、その端点を使う
  const candidates: SegmentIntersection[] = [];
  for (const [t1, p] of [
    [0, a.from],
    [1, a.to],
  ] as const) {
    if (nearestPoint(b, p).distance <= tol) {
      candidates.push({ t1, t2: paramOnStraight(b, p, tol), point: { ...p }, tangent: false });
    }
  }
  for (const [t2, p] of [
    [0, b.from],
    [1, b.to],
  ] as const) {
    if (nearestPoint(a, p).distance <= tol) {
      candidates.push({ t1: paramOnStraight(a, p, tol), t2, point: { ...p }, tangent: false });
    }
  }
  if (candidates.length > 0) {
    // 交わる直線同士なので交点は 1 つ。端点どうしが重なるもの (両方の t がちょうど) を選ぶ
    candidates.sort((p, q) => exactness(q) - exactness(p));
    return { intersections: [candidates[0]!], overlaps: [], complete: true };
  }
  const dA = { x: A.to.x - A.from.x, y: A.to.y - A.from.y };
  const dB = { x: B.to.x - B.from.x, y: B.to.y - B.from.y };
  const den = cross(dA, dB);
  if (den === 0) return empty();
  const r = { x: B.from.x - A.from.x, y: B.from.y - A.from.y };
  const sA = cross(r, dB) / den;
  const sB = cross(r, dA) / den;
  if (sA < -tol / lenA || sA > 1 + tol / lenA || sB < -tol / lenB || sB > 1 + tol / lenB) {
    return empty();
  }
  const p = { x: A.from.x + dA.x * clamp01(sA), y: A.from.y + dA.y * clamp01(sA) };
  const t1 = a.kind === "line" ? clamp01(sA) : paramOnStraight(a, p, tol);
  const t2 = b.kind === "line" ? clamp01(sB) : paramOnStraight(b, p, tol);
  return single(t1, t2, p, false);
}

function distanceToInfiniteLine(p: Point, line: Extent): number {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return distance(p, line.from);
  return Math.abs((p.x - line.from.x) * dy - (p.y - line.from.y) * dx) / len;
}

// ---------------------------------------------------------------------------
// まっすぐなものと曲線
// ---------------------------------------------------------------------------

/** a はまっすぐ、b はまっすぐでない 3 次ベジェ。 */
function intersectStraightCurve(a: Segment, b: CubicSegment, tol: number): IntersectionResult {
  const L = straightExtent(a);
  const len = distance(L.from, L.to);
  if (len <= tol) {
    const np = nearestPoint(b, a.from);
    if (np.distance > tol) return empty();
    return single(0, snapEnd(b, np.t, tol), a.from, true);
  }
  const ux = (L.to.x - L.from.x) / len;
  const uy = (L.to.y - L.from.y) / len;
  // 曲線の制御点を、線の向きを x 軸にした座標へ
  const ys = [b.from, b.c1, b.c2, b.to].map((p) => (p.y - L.from.y) * ux - (p.x - L.from.x) * uy);
  const roots = bernsteinRoots(ys as [number, number, number, number], tol);
  const intersections: SegmentIntersection[] = [];
  for (const t of roots) {
    const p = pointAt(b, t);
    const s = (p.x - L.from.x) * ux + (p.y - L.from.y) * uy;
    if (s < -tol || s > len + tol) continue;
    const onLine = { x: L.from.x + ux * s, y: L.from.y + uy * s };
    const t1 = a.kind === "line" ? paramOnStraight(a, onLine, tol) : paramOnStraight(a, p, tol);
    intersections.push({ t1, t2: t, point: p, tangent: false });
  }
  return { intersections, overlaps: [], complete: true };
}

/**
 * Bernstein 係数 `ys` の 3 次式の [0, 1] の根。微分の根で単調な区間に分け、符号が変わる区間を挟み撃ちで解く。
 * 区切りの点 (0、1、微分の根) の値の絶対値が `tol` 以下なら 0 とみなし、その点を根にする。
 */
function bernsteinRoots(ys: [number, number, number, number], tol: number): number[] {
  const f = (t: number) => {
    const mt = 1 - t;
    return (
      mt * mt * mt * ys[0] + 3 * mt * mt * t * ys[1] + 3 * mt * t * t * ys[2] + t * t * t * ys[3]
    );
  };
  const A = ys[1] - ys[0];
  const B = ys[2] - ys[1];
  const C = ys[3] - ys[2];
  const crit = solveQuadratic(A - 2 * B + C, 2 * (B - A), A)
    .filter((t) => t > 0 && t < 1)
    .sort((x, y) => x - y);
  const stops = [0, ...crit, 1];
  const values = stops.map((t, i) => {
    const v = i === 0 ? ys[0] : i === stops.length - 1 ? ys[3] : f(t);
    return Math.abs(v) <= tol ? 0 : v;
  });
  const roots: number[] = [];
  for (let i = 0; i < stops.length; i++) {
    if (values[i] === 0) roots.push(stops[i]!);
    if (i + 1 < stops.length && values[i]! * values[i + 1]! < 0) {
      roots.push(bisectRoot(f, stops[i]!, stops[i + 1]!, values[i]!, values[i + 1]!));
    }
  }
  roots.sort((x, y) => x - y);
  return roots.filter((t, i) => i === 0 || t - roots[i - 1]! > PARAM_EPSILON);
}

/** 符号が変わる単調な区間 [lo, hi] の根 (Illinois 法)。f(lo) と f(hi) の符号は逆。 */
function bisectRoot(
  f: (t: number) => number,
  lo: number,
  hi: number,
  flo: number,
  fhi: number,
): number {
  let a = lo;
  let b = hi;
  let fa = flo;
  let fb = fhi;
  let side = 0;
  let c = (a + b) / 2;
  for (let iter = 0; iter < 100; iter++) {
    c = (a * fb - b * fa) / (fb - fa);
    if (!(c > a && c < b)) c = (a + b) / 2;
    const fc = f(c);
    if (fc === 0 || b - a <= 1e-15) return c;
    if (fa * fc < 0) {
      b = c;
      fb = fc;
      if (side === -1) fa /= 2;
      side = -1;
    } else {
      a = c;
      fa = fc;
      if (side === 1) fb /= 2;
      side = 1;
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// 曲線同士
// ---------------------------------------------------------------------------

interface Candidate {
  t1: number;
  t2: number;
  residual: number;
}

interface SearchState {
  pairs: number;
  maxPairs: number;
  truncated: boolean;
}

interface EndPair {
  ta: number;
  tb: number;
  residual: number;
}

function intersectCurves(
  a: CubicSegment,
  b: CubicSegment,
  tol: number,
  maxPairs: number,
): IntersectionResult {
  // 端点が相手の上にある組 (重なりの判定と端点の交点の両方に使う)
  const ends: EndPair[] = [];
  for (const ta of [0, 1]) {
    const np = nearestPoint(b, pointAt(a, ta));
    if (np.distance <= tol) ends.push({ ta, tb: snapEnd(b, np.t, tol), residual: np.distance });
  }
  for (const tb of [0, 1]) {
    const np = nearestPoint(a, pointAt(b, tb));
    if (np.distance <= tol) ends.push({ ta: snapEnd(a, np.t, tol), tb, residual: np.distance });
  }
  const overlap = curveOverlap(a, b, tol, ends);
  if (overlap) return { intersections: [], overlaps: [overlap], complete: true };

  const found: Candidate[] = ends.map((e) => ({ t1: e.ta, t2: e.tb, residual: e.residual }));
  const ba = controlBounds(a);
  const bb = controlBounds(b);
  const extent = Math.max(
    ba.maxX - ba.minX,
    ba.maxY - ba.minY,
    bb.maxX - bb.minX,
    bb.maxY - bb.minY,
  );
  const flatTol = Math.max(tol, extent * 1e-6);
  const state: SearchState = { pairs: 0, maxPairs, truncated: false };
  search(a, b, a, 0, 1, b, 0, 1, tol, flatTol, 0, found, state);

  const intersections = mergeCandidates(a, b, found).map((c) => ({
    t1: c.t1,
    t2: c.t2,
    point: pointAt(a, c.t1),
    tangent: false,
  }));
  return { intersections, overlaps: [], complete: !state.truncated };
}

const MAX_DEPTH = 40;

/**
 * 部分 a (元の a0 の [aT0, aT1]) と部分 b (元の b0 の [bT0, bT1]) の交点を探す。
 * 1. 制御点の範囲が重ならない、または fat line (相手の弦からの距離の帯) の外にあれば交わらない
 * 2. 両方が同じ向きのグラフ (制御点の辺がどれも共通の向きから `GRAPH_ANGLE` 以内) なら、その向きに沿った
 *    符号つきの距離を直接解く (`solveAsGraphs`)。寄り添う曲線もここで分けずに済む
 * 3. 両方が十分平らなら、弦の最近点から Newton 法で詰める
 * 4. それ以外は大きい方 (または両方) を半分に分ける
 */
function search(
  a0: CubicSegment,
  b0: CubicSegment,
  a: CubicSegment,
  aT0: number,
  aT1: number,
  b: CubicSegment,
  bT0: number,
  bT1: number,
  tol: number,
  flatTol: number,
  depth: number,
  out: Candidate[],
  state: SearchState,
): void {
  if (state.pairs >= state.maxPairs) {
    state.truncated = true;
    return;
  }
  state.pairs++;
  const ba: Bounds = controlBounds(a);
  const bb: Bounds = controlBounds(b);
  if (!boundsOverlap(ba, bb, tol)) return;
  if (outsideFatLine(a, b, tol) || outsideFatLine(b, a, tol)) return;
  if (solveAsGraphs(a0, b0, a, aT0, aT1, b, bT0, bT1, tol, out)) return;
  const flatA = isStraight(a, flatTol);
  const flatB = isStraight(b, flatTol);
  if ((flatA && flatB) || depth >= MAX_DEPTH) {
    // 弦の最近点を出発点に、元の曲線で詰める
    const [sa, sb] = closestOnChords(a.from, a.to, b.from, b.to);
    const t = aT0 + (aT1 - aT0) * sa;
    const u = bT0 + (bT1 - bT0) * sb;
    const r = refinePair(a0, b0, t, u, tol);
    if (r) out.push(r);
    return;
  }
  const sizeA = Math.max(ba.maxX - ba.minX, ba.maxY - ba.minY);
  const sizeB = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
  const aMid = (aT0 + aT1) / 2;
  const bMid = (bT0 + bT1) / 2;
  const next = depth + 1;
  const splitA = !flatA && (flatB || sizeA >= sizeB * 0.5);
  const splitB = !flatB && (flatA || sizeB >= sizeA * 0.5);
  const as = splitA ? (splitSegment(a, 0.5) as [CubicSegment, CubicSegment]) : null;
  const bs = splitB ? (splitSegment(b, 0.5) as [CubicSegment, CubicSegment]) : null;
  const aParts: [CubicSegment, number, number][] = as
    ? [
        [as[0], aT0, aMid],
        [as[1], aMid, aT1],
      ]
    : [[a, aT0, aT1]];
  const bParts: [CubicSegment, number, number][] = bs
    ? [
        [bs[0], bT0, bMid],
        [bs[1], bMid, bT1],
      ]
    : [[b, bT0, bT1]];
  for (const [pa, pa0, pa1] of aParts) {
    for (const [pb, pb0, pb1] of bParts) {
      search(a0, b0, pa, pa0, pa1, pb, pb0, pb1, tol, flatTol, next, out, state);
    }
  }
}

/**
 * b が a の fat line の外にあるか。a は弦からの符号つきの距離が [min(0, c1, c2), max(0, c1, c2)] の帯の中に
 * あるので、b の制御点がすべて帯の片側の外 (許容値より遠く) なら交わらない。
 */
function outsideFatLine(a: CubicSegment, b: CubicSegment, tol: number): boolean {
  const dx = a.to.x - a.from.x;
  const dy = a.to.y - a.from.y;
  const len = Math.hypot(dx, dy);
  if (len <= tol) return false;
  const d = (p: Point) => ((p.y - a.from.y) * dx - (p.x - a.from.x) * dy) / len;
  const d1 = d(a.c1);
  const d2 = d(a.c2);
  const lo = Math.min(0, d1, d2) - tol;
  const hi = Math.max(0, d1, d2) + tol;
  const q = [d(b.from), d(b.c1), d(b.c2), d(b.to)];
  return Math.min(...q) > hi || Math.max(...q) < lo;
}

/** 曲線をグラフとして扱う、制御点の辺と共通の向きの角度の上限 (度)。 */
const GRAPH_ANGLE = 30;
const GRAPH_COS = Math.cos((GRAPH_ANGLE * Math.PI) / 180);
const GRAPH_SAMPLES = 16;

/** 曲線を向き u の座標 s と法線の座標 n に直したもの (Bernstein 係数)。 */
interface Graph {
  s: [number, number, number, number];
  n: [number, number, number, number];
  /** s が増える向きなら 1、減る向きなら -1 */
  sign: number;
}

/**
 * 両方の部分が共通の向き u のグラフなら、u に沿った座標 s で h(s) = (b の法線の座標) − (a の法線の座標) の
 * 根を求めて `out` に足し、true を返す。グラフでなければ何もせず false。
 * - h の 1 階・2 階の微分は厳密に求まる (`graphAt`)。16 等分の標本で h' の符号の変化を拾い (標本の間で h'' の
 *   符号が変われば、h'' の根で区間を分けてから)、h の極値で区間を分ける。各区間で h は単調なので、根は
 *   両端の符号が変わる区間に 1 つだけあり、挟み撃ちで詰める (t の精度は 1e-15 程度)
 * - 区切りの点 (両端と極値) の |h| が許容値以内なら、その点を採る (端点を共有する所、接する所)。極値では
 *   符号を 0 とみなし (接するだけの所は 1 点)、両端では符号をそのまま使う。端点を共有する 2 本の、端点の
 *   すぐ近くの交差も、隣の単調な区間の符号の変化で見つかる
 * - h はその s での 2 点の距離そのものなので、採った点の距離は許容値以下
 * - 落としうるのは、標本の 1 区間 (共通の範囲の 1/16) の中で h'' が 2 回以上符号を変え、そのせいで
 *   h' の根を数え損ねる形だけ (3 次の曲線同士では、極値が 3 つ以上ごく近くに集まる場合)
 */
function solveAsGraphs(
  a0: CubicSegment,
  b0: CubicSegment,
  a: CubicSegment,
  aT0: number,
  aT1: number,
  b: CubicSegment,
  bT0: number,
  bT1: number,
  tol: number,
  out: Candidate[],
): boolean {
  const la = distance(a.from, a.to);
  const lb = distance(b.from, b.to);
  if (Math.max(la, lb) <= tol) return false;
  const base = la >= lb ? a : b;
  const len = Math.max(la, lb);
  const ux = (base.to.x - base.from.x) / len;
  const uy = (base.to.y - base.from.y) / len;
  const ga = toGraph(a, ux, uy, base.from);
  const gb = toGraph(b, ux, uy, base.from);
  if (!ga || !gb) return false;
  const [aLo, aHi] = sRange(ga);
  const [bLo, bHi] = sRange(gb);
  let lo = Math.max(aLo, bLo);
  let hi = Math.min(aHi, bHi);
  if (hi < lo - tol) return true; // s の範囲が重ならない
  if (hi < lo) lo = hi = (lo + hi) / 2;

  const accept = (s: number) => {
    const ta = invertGraph(ga, s);
    const tb = invertGraph(gb, s);
    const t1 = aT0 + (aT1 - aT0) * ta;
    const t2 = bT0 + (bT1 - bT0) * tb;
    const residual = distance(pointAt(a0, t1), pointAt(b0, t2));
    if (residual <= tol) out.push({ t1, t2, residual });
  };
  const h = (s: number) => graphAt(gb, s).y - graphAt(ga, s).y;
  const dh = (s: number) => graphAt(gb, s).dy - graphAt(ga, s).dy;
  const ddh = (s: number) => graphAt(gb, s).ddy - graphAt(ga, s).ddy;
  if (hi <= lo) {
    if (Math.abs(h(lo)) <= tol) accept(lo);
    return true;
  }

  // 1. h の極値 (h' の根) を集め、h が単調な区間に分ける。標本の間で h' が単調でない所 (h'' の符号が変わる所) は、
  //    h'' の根で区間をさらに分けてから h' の符号の変化を見る
  const n = GRAPH_SAMPLES;
  const ss: number[] = [];
  const d1: number[] = [];
  const d2: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i === n ? hi : lo + ((hi - lo) * i) / n;
    const ea = graphAt(ga, s);
    const eb = graphAt(gb, s);
    ss.push(s);
    d1.push(eb.dy - ea.dy);
    d2.push(eb.ddy - ea.ddy);
  }
  const crit: number[] = [];
  const addRoot = (p: number, q: number, fp: number, fq: number) => {
    if (fp * fq < 0) crit.push(bisect(dh, p, q, fp, fq, CRIT_ITERATIONS));
  };
  for (let i = 0; i < n; i++) {
    const p = ss[i]!;
    const q = ss[i + 1]!;
    if (i > 0 && d1[i] === 0) crit.push(p);
    if (d2[i]! * d2[i + 1]! < 0) {
      const e = bisect(ddh, p, q, d2[i]!, d2[i + 1]!, CRIT_ITERATIONS);
      const de = dh(e);
      if (de === 0) crit.push(e);
      addRoot(p, e, d1[i]!, de);
      addRoot(e, q, de, d1[i + 1]!);
    } else {
      addRoot(p, q, d1[i]!, d1[i + 1]!);
    }
  }
  const stops = [lo, ...crit.filter((c) => c > lo && c < hi).sort((x, y) => x - y), hi];

  // 2. 区切りの点の h。許容値以内ならその点を採る (端点を共有する所、接する所)。極値では符号を 0 とみなし
  //    (接するだけの所を 2 つの交点にしない)、両端では符号をそのまま使う (端から許容値の中を寄り添ってから
  //    横切る所も落とさない)。単調な区間の中の根は、両端の符号が変わる区間に 1 つだけある
  const values = stops.map((s, i) => {
    const v = h(s);
    if (Math.abs(v) > tol) return v;
    accept(s);
    return i === 0 || i === stops.length - 1 ? v : 0;
  });
  for (let i = 0; i + 1 < stops.length; i++) {
    if (values[i]! * values[i + 1]! < 0) {
      accept(bisect(h, stops[i]!, stops[i + 1]!, values[i]!, values[i + 1]!, ROOT_ITERATIONS));
    }
  }
  return true;
}

/** 曲線を向き (ux, uy) のグラフにする。制御点の辺がどれも同じ向きで、角度が `GRAPH_ANGLE` 以内でなければ null。 */
function toGraph(seg: CubicSegment, ux: number, uy: number, origin: Point): Graph | null {
  const pts = [seg.from, seg.c1, seg.c2, seg.to];
  const s = pts.map((p) => (p.x - origin.x) * ux + (p.y - origin.y) * uy) as Graph["s"];
  const nn = pts.map((p) => (p.y - origin.y) * ux - (p.x - origin.x) * uy) as Graph["n"];
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const ds = s[i + 1]! - s[i]!;
    const dn = nn[i + 1]! - nn[i]!;
    const leg = Math.hypot(ds, dn);
    if (leg === 0) continue;
    if (Math.abs(ds) < GRAPH_COS * leg) return null;
    const legSign = ds > 0 ? 1 : -1;
    if (sign !== 0 && legSign !== sign) return null;
    sign = legSign;
  }
  if (sign === 0) return null;
  return { s, n: nn, sign };
}

function sRange(g: Graph): [number, number] {
  return g.sign > 0 ? [g.s[0], g.s[3]] : [g.s[3], g.s[0]];
}

function bernstein(c: readonly [number, number, number, number], t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * c[0] + 3 * mt * mt * t * c[1] + 3 * mt * t * t * c[2] + t * t * t * c[3];
}

/** s(t) = `s` となる t (s(t) は単調)。範囲の外の s は端の t。 */
function invertGraph(g: Graph, s: number): number {
  const [lo, hi] = sRange(g);
  if (s <= lo) return g.sign > 0 ? 0 : 1;
  if (s >= hi) return g.sign > 0 ? 1 : 0;
  let a = 0;
  let b = 1;
  for (let i = 0; i < 64 && b - a > 1e-16; i++) {
    const m = (a + b) / 2;
    if ((bernstein(g.s, m) - s) * g.sign < 0) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

interface GraphPoint {
  /** 法線の座標 n */
  y: number;
  /** dn/ds */
  dy: number;
  /** d²n/ds² */
  ddy: number;
}

/**
 * グラフの s での値と、s についての 1 階・2 階の微分 (厳密: dn/ds = n'/s'、d²n/ds² = (n''s' − n's'')/s'³)。
 * s' が 0 になるのは長さ 0 の辺がある端だけなので、そこでは微分を少し内側で求める。
 */
function graphAt(g: Graph, s: number): GraphPoint {
  const t = invertGraph(g, s);
  const y = bernstein(g.n, t);
  let u = t;
  let s1 = bernsteinD1(g.s, u);
  if (s1 === 0) {
    u = t < 0.5 ? t + 1e-9 : t - 1e-9;
    s1 = bernsteinD1(g.s, u);
  }
  if (s1 === 0) return { y, dy: 0, ddy: 0 };
  const n1 = bernsteinD1(g.n, u);
  const s2 = bernsteinD2(g.s, u);
  const n2 = bernsteinD2(g.n, u);
  return { y, dy: n1 / s1, ddy: (n2 * s1 - n1 * s2) / (s1 * s1 * s1) };
}

function bernsteinD1(c: readonly [number, number, number, number], t: number): number {
  const mt = 1 - t;
  return 3 * (mt * mt * (c[1] - c[0]) + 2 * mt * t * (c[2] - c[1]) + t * t * (c[3] - c[2]));
}

function bernsteinD2(c: readonly [number, number, number, number], t: number): number {
  return 6 * ((1 - t) * (c[2] - 2 * c[1] + c[0]) + t * (c[3] - 2 * c[2] + c[1]));
}

/** 根 (交点の s) を詰める回数 (区間の 2^-80 まで)。 */
const ROOT_ITERATIONS = 80;
/** 極値 (h' と h'' の根) を詰める回数。区切りに使うだけなので、根ほど細かくなくてよい */
const CRIT_ITERATIONS = 48;

/** 符号が変わる [lo, hi] の根を挟み撃ちで。 */
function bisect(
  f: (s: number) => number,
  lo: number,
  hi: number,
  flo: number,
  fhi: number,
  iterations: number,
): number {
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  let a = lo;
  let b = hi;
  let fa = flo;
  for (let i = 0; i < iterations; i++) {
    const m = (a + b) / 2;
    if (m <= a || m >= b) break;
    const fm = f(m);
    if (fm === 0) return m;
    if (fa * fm < 0) b = m;
    else {
      a = m;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/** 線分 p0–p1 と q0–q1 の最も近い点の媒介変数 (それぞれ 0〜1)。 */
function closestOnChords(p0: Point, p1: Point, q0: Point, q1: Point): [number, number] {
  const d1 = { x: p1.x - p0.x, y: p1.y - p0.y };
  const d2 = { x: q1.x - q0.x, y: q1.y - q0.y };
  const r = { x: p0.x - q0.x, y: p0.y - q0.y };
  const den = cross(d1, d2);
  if (den !== 0) {
    const s = cross({ x: q0.x - p0.x, y: q0.y - p0.y }, d2) / den;
    const t = cross({ x: q0.x - p0.x, y: q0.y - p0.y }, d1) / den;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return [s, t];
  }
  // 交わらない: 4 つの端点から相手への最近点のうち最も近いもの
  const a2 = dot(d1, d1);
  const b2 = dot(d2, d2);
  const proj = (v: number, len2: number) => (len2 > 0 ? clamp01(v / len2) : 0);
  const options: [number, number][] = [
    [0, proj(dot({ x: -r.x, y: -r.y }, d2), b2)],
    [1, proj(dot({ x: p1.x - q0.x, y: p1.y - q0.y }, d2), b2)],
    [proj(dot({ x: q0.x - p0.x, y: q0.y - p0.y }, d1), a2), 0],
    [proj(dot({ x: q1.x - p0.x, y: q1.y - p0.y }, d1), a2), 1],
  ];
  let best = options[0]!;
  let bestD = Infinity;
  for (const [s, t] of options) {
    const d = Math.hypot(p0.x + d1.x * s - (q0.x + d2.x * t), p0.y + d1.y * s - (q0.y + d2.y * t));
    if (d < bestD) {
      bestD = d;
      best = [s, t];
    }
  }
  return best;
}

/**
 * A(t) = B(u) を (t, u) の Newton 法で詰める。向きがほぼ平行で行列が潰れるときは、交互の射影に切り替える。
 * 距離が `tol` 以下になれば返す。
 */
function refinePair(a: Segment, b: Segment, t0: number, u0: number, tol: number): Candidate | null {
  let t = clamp01(t0);
  let u = clamp01(u0);
  let P = pointAt(a, t);
  let Q = pointAt(b, u);
  let err = distance(P, Q);
  for (let iter = 0; iter < 60; iter++) {
    if (err === 0) break;
    const Ja = derivativeAt(a, t);
    const Jb = derivativeAt(b, u);
    const F = { x: P.x - Q.x, y: P.y - Q.y };
    const det = cross(Ja, Jb);
    const na = Math.hypot(Ja.x, Ja.y);
    const nb = Math.hypot(Jb.x, Jb.y);
    let dt: number;
    let du: number;
    if (Math.abs(det) > 1e-9 * na * nb) {
      dt = -cross(F, Jb) / det;
      du = cross(Ja, F) / det;
    } else {
      // 交互の射影: a の上で Q に近づき、その点に b を近づける
      dt = na > 0 ? -dot(F, Ja) / (na * na) : 0;
      const P2 = pointAt(a, clamp01(t + dt));
      du = nb > 0 ? dot({ x: P2.x - Q.x, y: P2.y - Q.y }, Jb) / (nb * nb) : 0;
    }
    let scale = 1;
    let nt = clamp01(t + dt);
    let nu = clamp01(u + du);
    let nP = pointAt(a, nt);
    let nQ = pointAt(b, nu);
    let nerr = distance(nP, nQ);
    while (nerr > err && scale > 1e-6) {
      scale /= 2;
      nt = clamp01(t + dt * scale);
      nu = clamp01(u + du * scale);
      nP = pointAt(a, nt);
      nQ = pointAt(b, nu);
      nerr = distance(nP, nQ);
    }
    if (nerr > err) break;
    // 縮まらなくなったら (平行に離れた曲線など) やめる
    if (iter >= 6 && nerr > tol && nerr > err * 0.95) break;
    const moved = Math.abs(nt - t) + Math.abs(nu - u);
    t = nt;
    u = nu;
    P = nP;
    Q = nQ;
    err = nerr;
    if (moved <= 1e-16) break;
  }
  return err <= tol ? { t1: t, t2: u, residual: err } : null;
}

/**
 * 2 本の 3 次ベジェが同じ曲線の一部で重なっていれば、その区間。端点が相手の上にある組がちょうど 2 つあり、
 * その間の部分同士の制御点がそろい、途中の点も許容値以内で一致すれば重なりとする。
 */
function curveOverlap(
  a: CubicSegment,
  b: CubicSegment,
  tol: number,
  ends: readonly EndPair[],
): SegmentOverlap | null {
  const pairs: { ta: number; tb: number }[] = [];
  for (const e of ends) {
    if (!pairs.some((p) => Math.abs(p.ta - e.ta) <= PARAM_EPSILON)) pairs.push(e);
  }
  if (pairs.length !== 2) return null;
  pairs.sort((p, q) => p.ta - q.ta);
  const [p, q] = pairs as [{ ta: number; tb: number }, { ta: number; tb: number }];
  if (q.ta - p.ta <= PARAM_EPSILON || Math.abs(q.tb - p.tb) <= PARAM_EPSILON) return null;
  const subA = subSegment(a, p.ta, q.ta) as CubicSegment;
  const subB = subSegment(b, p.tb, q.tb) as CubicSegment;
  const ctrlTol = tol * 10;
  if (distance(subA.c1, subB.c1) > ctrlTol || distance(subA.c2, subB.c2) > ctrlTol) return null;
  for (const s of [0.25, 0.5, 0.75]) {
    if (distance(pointAt(subA, s), pointAt(subB, s)) > tol) return null;
  }
  return { t1: [p.ta, q.ta], t2: [p.tb, q.tb] };
}

/** 交点の候補をまとめる。媒介変数が `PARAM_EPSILON` 以内のもの、接していて 1e-4 以内のものは 1 つにする。 */
function mergeCandidates(a: Segment, b: Segment, found: Candidate[]): Candidate[] {
  const sorted = [...found].sort((p, q) => p.t1 - q.t1 || p.t2 - q.t2);
  const out: Candidate[] = [];
  for (const c of sorted) {
    const same = out.findIndex(
      (o) =>
        (Math.abs(o.t1 - c.t1) <= PARAM_EPSILON && Math.abs(o.t2 - c.t2) <= PARAM_EPSILON) ||
        (Math.abs(o.t1 - c.t1) <= 1e-4 &&
          Math.abs(o.t2 - c.t2) <= 1e-4 &&
          isTangent(a, o.t1, b, o.t2) &&
          isTangent(a, c.t1, b, c.t2)),
    );
    if (same < 0) {
      out.push(c);
      continue;
    }
    const o = out[same]!;
    // 端点ちょうどのものを優先し、次に残差の小さいもの
    if (exactness(c) > exactness(o) || (exactness(c) === exactness(o) && c.residual < o.residual)) {
      out[same] = c;
    }
  }
  return out.sort((p, q) => p.t1 - q.t1 || p.t2 - q.t2);
}

// ---------------------------------------------------------------------------
// 仕上げ
// ---------------------------------------------------------------------------

/** 点を端点に合わせ、`tangent` を求め、t1 の昇順に並べる。 */
function finish(a: Segment, b: Segment, result: IntersectionResult): IntersectionResult {
  const intersections = result.intersections
    .map((x) => {
      const point =
        x.t1 === 0
          ? { ...a.from }
          : x.t1 === 1
            ? { ...a.to }
            : x.t2 === 0
              ? { ...b.from }
              : x.t2 === 1
                ? { ...b.to }
                : x.point;
      return { t1: x.t1, t2: x.t2, point, tangent: x.tangent || isTangent(a, x.t1, b, x.t2) };
    })
    .sort((p, q) => p.t1 - q.t1 || p.t2 - q.t2);
  return {
    intersections,
    overlaps: result.overlaps.map((o) => ({
      t1: [o.t1[0], o.t1[1]] as [number, number],
      t2: [o.t2[0], o.t2[1]] as [number, number],
    })),
    complete: result.complete,
  };
}

function isTangent(a: Segment, t: number, b: Segment, u: number): boolean {
  const ta = tangentAt(a, t);
  const tb = tangentAt(b, u);
  if (!ta || !tb) return true;
  return Math.abs(cross(ta, tb)) <= TANGENT_EPSILON;
}

function swap(result: IntersectionResult): IntersectionResult {
  const overlaps = result.overlaps.map((o) => {
    // a と b を入れ替える。t1 (新しい a の区間) を昇順にそろえる
    const t1: [number, number] = [o.t2[0], o.t2[1]];
    const t2: [number, number] = [o.t1[0], o.t1[1]];
    return t1[0] <= t1[1]
      ? { t1, t2 }
      : { t1: [t1[1], t1[0]] as [number, number], t2: [t2[1], t2[0]] as [number, number] };
  });
  return {
    intersections: result.intersections.map((x) => ({ ...x, t1: x.t2, t2: x.t1 })),
    overlaps,
    complete: result.complete,
  };
}

function single(t1: number, t2: number, point: Point, tangent: boolean): IntersectionResult {
  return {
    intersections: [{ t1, t2, point: { ...point }, tangent }],
    overlaps: [],
    complete: true,
  };
}

/** t の点が曲線の端点から許容値以内なら、0 か 1 ちょうどにする。 */
function snapEnd(seg: Segment, t: number, tol: number): number {
  const p = pointAt(seg, t);
  const d0 = distance(p, seg.from);
  const d1 = distance(p, seg.to);
  if (d0 <= tol && (d0 < d1 || (d0 === d1 && t <= 0.5))) return 0;
  if (d1 <= tol) return 1;
  return t;
}

function exactness(c: { t1: number; t2: number }): number {
  return (c.t1 === 0 || c.t1 === 1 ? 1 : 0) + (c.t2 === 0 || c.t2 === 1 ? 1 : 0);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
