/**
 * 作成ツールの位置と大きさの計算 (§4.4 / §4.6)。純関数。
 *
 * - 入力はページ座標、結果は親の座標系 (`origin` は親の座標系の原点のページ座標) の整数
 * - Shift で正方形・正円 (線は 45° 刻み)、Alt で押した点を中心にする
 * - 幅か高さが 0 になる矩形 (まっすぐ横や縦に引いた) は 1 以上にする。線は長さ 0 なら作らない
 */
import type { Rect } from "../../model/geometry";
import type { Point } from "../../model/types";
import { moveLineEnd } from "../select/resize";

/** `-0` を `0` にする丸め。 */
export function roundInt(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

export interface BoxModifiers {
  /** Shift: 正方形・正円 */
  square: boolean;
  /** Alt: 押した点を中心にする */
  fromCenter: boolean;
}

export interface Size {
  width: number;
  height: number;
}

/** 押した点 (ページ座標) を親の座標系の整数にする。小数の押下点 (100% 以外の倍率やパンの後) でも、
 * 丸めた始点から整数の差を足すので、吸着した辺や 45° の線が崩れない。 */
export function localStart(start: Point, origin: Point): Point {
  return { x: roundInt(start.x - origin.x), y: roundInt(start.y - origin.y) };
}

/**
 * ドラッグで作る矩形 (親の座標系、整数)。`start` は押した点 (吸着の後)、`pointer` は今の点。
 * 押した点を先に親の座標系の整数にし、ポインターの側の辺も整数に丸めてから大きさを決める
 * (吸着した辺がそのまま辺になる)。Shift の正方形は、大きい方の差に合わせる。
 */
export function dragBox(start: Point, pointer: Point, origin: Point, mods: BoxModifiers): Rect {
  const s = localStart(start, origin);
  const px = pointer.x - origin.x;
  const py = pointer.y - origin.y;
  // ポインターの側の辺 (整数) までの差。0 なら引いた向きだけを見る
  const dx = roundInt(px) - s.x;
  const dy = roundInt(py) - s.y;
  const signX = dx < 0 || (dx === 0 && px < s.x) ? -1 : 1;
  const signY = dy < 0 || (dy === 0 && py < s.y) ? -1 : 1;
  const k = mods.fromCenter ? 2 : 1;
  let width = Math.max(1, k * Math.abs(dx));
  let height = Math.max(1, k * Math.abs(dy));
  if (mods.square) width = height = Math.max(width, height);
  if (mods.fromCenter)
    return { x: roundInt(s.x - width / 2), y: roundInt(s.y - height / 2), width, height };
  return {
    x: signX < 0 ? s.x - width : s.x,
    y: signY < 0 ? s.y - height : s.y,
    width,
    height,
  };
}

/** クリックだけで作る矩形 (親の座標系、整数)。押した点を左上にする。 */
export function clickBox(point: Point, origin: Point, size: Size): Rect {
  return {
    x: roundInt(point.x - origin.x),
    y: roundInt(point.y - origin.y),
    width: Math.max(1, roundInt(size.width)),
    height: Math.max(1, roundInt(size.height)),
  };
}

export interface LineModifiers {
  /** Shift: 45° 刻み */
  constrain: boolean;
  /** Alt: 押した点を中点にする */
  fromCenter: boolean;
}

export interface LineGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * ドラッグで作る線 (親の座標系、整数)。始点は押した点 (Alt なら終点の反対側)、終点は今の点。
 * 押した点を先に整数にし、始点からの差を整数に丸めて足すので、Shift の 45° は丸めても 45° のまま。
 * 長さが 0 になるなら null (作らない)。
 */
export function dragLine(
  start: Point,
  pointer: Point,
  origin: Point,
  mods: LineModifiers,
): LineGeometry | null {
  const s = localStart(start, origin);
  const [end] = moveLineEnd({
    from: s,
    other: s,
    pointer: { x: pointer.x - origin.x, y: pointer.y - origin.y },
    constrain: mods.constrain,
    fromCenter: false,
    snap: null,
  });
  const dx = roundInt(end.x - s.x);
  const dy = roundInt(end.y - s.y);
  if (dx === 0 && dy === 0) return null;
  const begin = mods.fromCenter ? { x: s.x - dx, y: s.y - dy } : s;
  return { x1: begin.x, y1: begin.y, x2: s.x + dx, y2: s.y + dy };
}

/** 親の座標系の矩形をページ座標へ。 */
export function boxToPage(box: Rect, origin: Point): Rect {
  return { ...box, x: box.x + origin.x, y: box.y + origin.y };
}
