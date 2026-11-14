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
 * 楕円 (外接矩形 `rect`) の半径に `grow` を足した楕円の中 (輪郭を含む) に点があるか。
 * 負の `grow` は内側へ縮める。縮めた半径が 0 以下なら、どの点も中にない。
 *
 * 線の帯は「外側へ広げた楕円の中で、内側へ縮めた楕円の外」で判定する。
 * 距離の近似を使わないので、縦横比の大きい細長い楕円でも、見えている線の上の点を外さない。
 * 幅か高さが 0 の楕円 (線分) も、広げれば線分を囲む細い楕円になる。
 */
export function insideGrownEllipse(p: Point, rect: Rect, grow: number): boolean {
  const rx = rect.width / 2 + grow;
  const ry = rect.height / 2 + grow;
  if (rx <= 0 || ry <= 0) return false;
  const nx = (p.x - (rect.x + rect.width / 2)) / rx;
  const ny = (p.y - (rect.y + rect.height / 2)) / ry;
  return nx * nx + ny * ny <= 1;
}
