/**
 * 鉛筆でなぞった点から、パスの輪郭を作る (`docs/canvas-editor-design.md` §8.8)。純関数。
 *
 * - 点 (親の座標系) を `fitCurve` で 3 次ベジェに当てはめ、つなぎ目を滑らかな点 (`angle`) にした輪郭にする
 * - 終点が始点から `closeDistance` 以内なら閉じる (終点を始点に置き換えて当てはめ、重なった最後の点を落とす。
 *   始点は角の点 `none`)。閉じるのは、まとめた後の点が 3 個以上のときだけ
 * - 点の数が `maxPoints` を超えるなら、誤差を 2 倍ずつ広げて当てはめ直す (最大 `MAX_WIDEN` 回)。それでも
 *   超えるなら null (作らない)
 * - 点とハンドルの先は、親の座標系で小数第 2 位に丸める (§8.6 のツールの入力の丸め)。長さ 0 のハンドルは null
 * - 点が 1 個 (まとめた後) なら null
 */
import type { PathPoint, Point, Subpath } from "../model/types";
import { dedupePoints, fitCurve, type CubicCurve } from "./fit";

/** 誤差を広げる回数の上限 (2 倍ずつ。最後は最初の 2^10 = 1024 倍)。 */
export const MAX_WIDEN = 10;

export interface PencilOptions {
  /** 当てはめの誤差 (親の座標系の長さ) */
  tolerance: number;
  /** 閉じる距離 (親の座標系の長さ) */
  closeDistance: number;
  /** 作れる点の数 */
  maxPoints: number;
}

export interface PencilResult {
  subpath: Subpath;
  /** 実際に使った誤差 (点の数の上限で広げたときは `tolerance` より大きい) */
  tolerance: number;
}

function round2(value: number): number {
  const r = Math.round(value * 100) / 100;
  return r === 0 ? 0 : r;
}

const roundPoint = (p: Point): Point => ({ x: round2(p.x), y: round2(p.y) });

/** 点 `at` (丸めた後) から、丸めた制御点 `control` へのハンドル。長さ 0 なら null。 */
function handle(at: Point, control: Point): Point | null {
  const c = roundPoint(control);
  const h = { x: round2(c.x - at.x), y: round2(c.y - at.y) };
  return h.x === 0 && h.y === 0 ? null : h;
}

/** 曲線の列を輪郭の点にする。`closed` なら最後の点 (始点と同じ) を落とし、そのハンドルを始点の `in` に移す。 */
export function curvesToSubpath(curves: readonly CubicCurve[], closed: boolean): Subpath | null {
  const firstCurve = curves[0];
  const lastCurve = curves[curves.length - 1];
  if (!firstCurve || !lastCurve) return null;
  const points: PathPoint[] = [];
  for (let i = 0; i <= curves.length; i++) {
    const before = curves[i - 1];
    const after = curves[i];
    const at = roundPoint(after ? after[0] : (before as CubicCurve)[3]);
    points.push({
      ...at,
      in: before ? handle(at, before[2]) : null,
      out: after ? handle(at, after[1]) : null,
      mirror: before && after ? "angle" : "none",
    });
  }
  if (!closed) return { closed: false, points };
  points.pop();
  const first = points[0] as PathPoint;
  points[0] = { ...first, in: handle(first, lastCurve[2]), mirror: "none" };
  return { closed: true, points };
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** 曲線を t = 0.5 で 2 本に分ける (de Casteljau)。分けた点の前後は向きがそろう。 */
function splitHalf([p0, p1, p2, p3]: CubicCurve): CubicCurve[] {
  const a = mid(p0, p1);
  const b = mid(p1, p2);
  const c = mid(p2, p3);
  const d = mid(a, b);
  const e = mid(b, c);
  const m = mid(d, e);
  return [
    [p0, a, d, m],
    [m, e, c, p3],
  ];
}

export function pencilSubpath(raw: readonly Point[], options: PencilOptions): PencilResult | null {
  let points = dedupePoints(raw);
  if (points.length < 2) return null;
  const start = points[0] as Point;
  const end = points[points.length - 1] as Point;
  const closed =
    points.length >= 3 && Math.hypot(end.x - start.x, end.y - start.y) <= options.closeDistance;
  if (closed) points = dedupePoints([...points.slice(0, -1), start]);
  // 閉じたら最後の点は始点と重なって落ちる
  const count = (curves: readonly CubicCurve[]) => curves.length + (closed ? 0 : 1);
  let tolerance = options.tolerance;
  for (let attempt = 0; attempt <= MAX_WIDEN; attempt++) {
    let curves = fitCurve(points, tolerance);
    if (curves.length === 0) return null;
    // 閉じた輪郭が 1 本の曲線になったら、点が 1 個の輪郭 (描かれない) にならないよう半分で分ける
    if (closed && curves.length === 1) curves = splitHalf(curves[0] as CubicCurve);
    if (count(curves) <= options.maxPoints) {
      const subpath = curvesToSubpath(curves, closed);
      return subpath ? { subpath, tolerance } : null;
    }
    tolerance *= 2;
  }
  return null;
}
