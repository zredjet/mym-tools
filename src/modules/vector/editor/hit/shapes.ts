/**
 * 図形ごとの当たり判定に使う距離 (純関数)。座標はすべてページ座標。
 *
 * 符号付き距離は、図形の内側で負、外側で正、輪郭の上で 0。
 */
import type { Rect } from "../model/geometry";
import type { Point } from "../model/types";

/** 点と線分の距離。 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * 角丸の矩形の符号付き距離。`radius` は短い辺の半分までに収める (描画と同じ)。
 * 幅や高さが 0 の矩形は線分 (か点) になる。
 */
export function roundedRectDistance(p: Point, rect: Rect, radius: number): number {
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));
  const qx = Math.abs(p.x - (rect.x + hw)) - (hw - r);
  const qy = Math.abs(p.y - (rect.y + hh)) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/**
 * 楕円 (外接矩形 `rect`) の符号付き距離の近似。輪郭の近くで正確で、遠いほど粗い
 * (当たり判定は輪郭の近くしか見ないので十分)。幅か高さが 0 なら線分との距離。
 */
export function ellipseDistance(p: Point, rect: Rect): number {
  const a = rect.width / 2;
  const b = rect.height / 2;
  const cx = rect.x + a;
  const cy = rect.y + b;
  if (a === 0 || b === 0) {
    return distanceToSegment(
      p,
      { x: rect.x, y: rect.y },
      {
        x: rect.x + rect.width,
        y: rect.y + rect.height,
      },
    );
  }
  const x = p.x - cx;
  const y = p.y - cy;
  const k0 = Math.hypot(x / a, y / b);
  const k1 = Math.hypot(x / (a * a), y / (b * b));
  if (k1 === 0) return -Math.min(a, b); // 中心
  return (k0 * (k0 - 1)) / k1;
}
