/**
 * 多角形と星の点 (`docs/canvas-editor-design.md` §8.8)。
 *
 * 返すもの:
 * - `polygonSubpath(sides, rect)`: 正多角形の閉じた輪郭 (角の点だけ)
 * - `starSubpath(points, innerRatio, rect)`: 星の閉じた輪郭 (外側と内側の頂点を交互に、角の点だけ)
 * - どちらも最初の頂点を上の中央に置き、時計回り (y が下向き) に並べる。頂点を囲む範囲が `rect` に
 *   ぴったり合うよう縦横に別々に拡大する (左右対称なので、最初の頂点は `rect` の上の辺の中央に来る)
 *
 * 誤差と前提:
 * - 純関数。頂点の角度は度で求め、90° の倍数は cos / sin をちょうどにする。範囲の端に来る頂点は
 *   `rect` の辺ちょうどの値にする
 * - 頂点の数は 3〜60 (`POLYGON_MIN_SIDES`〜`POLYGON_MAX_SIDES`) に、凹み (内側の半径 ÷ 外側の半径) は
 *   0.01〜1 にそろえる (整数でない頂点の数は切り捨て)。`rect` の幅・高さが 0 なら、その向きは 1 点に潰れる
 * - 点は丸めない (ツールの入力の丸め、§8.6、は呼び出し側で)
 */
import { cosSinDeg } from "../geometry/matrix";
import type { PathPoint, Point, Subpath } from "../model/types";
import type { Rect } from "./measure";

export const POLYGON_MIN_SIDES = 3;
export const POLYGON_MAX_SIDES = 60;
export const POLYGON_DEFAULT_SIDES = 3;
export const STAR_DEFAULT_POINTS = 5;
export const STAR_DEFAULT_RATIO = 0.382;
export const STAR_MIN_RATIO = 0.01;
export const STAR_MAX_RATIO = 1;

export function clampSides(sides: number): number {
  if (!Number.isFinite(sides)) return POLYGON_MIN_SIDES;
  return Math.min(POLYGON_MAX_SIDES, Math.max(POLYGON_MIN_SIDES, Math.floor(sides)));
}

export function clampStarRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return STAR_DEFAULT_RATIO;
  return Math.min(STAR_MAX_RATIO, Math.max(STAR_MIN_RATIO, ratio));
}

export function polygonSubpath(sides: number, rect: Rect): Subpath {
  const n = clampSides(sides);
  const unit: Point[] = [];
  for (let i = 0; i < n; i++) unit.push(onCircle(-90 + (360 * i) / n, 1));
  return fit(unit, rect);
}

export function starSubpath(points: number, innerRatio: number, rect: Rect): Subpath {
  const n = clampSides(points);
  const r = clampStarRatio(innerRatio);
  const unit: Point[] = [];
  for (let i = 0; i < n; i++) {
    unit.push(onCircle(-90 + (360 * i) / n, 1));
    unit.push(onCircle(-90 + (360 * (i + 0.5)) / n, r));
  }
  return fit(unit, rect);
}

function onCircle(degrees: number, radius: number): Point {
  const { cos, sin } = cosSinDeg(degrees);
  return { x: cos * radius, y: sin * radius };
}

function fit(unit: Point[], rect: Rect): Subpath {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of unit) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const map = (v: number, min: number, max: number, start: number, size: number): number => {
    if (v === min) return start;
    if (v === max) return start + size;
    return start + ((v - min) / (max - min)) * size;
  };
  const points: PathPoint[] = unit.map((p) => ({
    x: map(p.x, minX, maxX, rect.x, rect.width),
    y: map(p.y, minY, maxY, rect.y, rect.height),
    in: null,
    out: null,
    mirror: "none",
  }));
  return { closed: true, points };
}
