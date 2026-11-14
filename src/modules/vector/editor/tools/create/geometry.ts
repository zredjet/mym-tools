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

/**
 * ドラッグで作る矩形 (親の座標系、整数)。`start` は押した点 (吸着の後)、`pointer` は今の点。
 * 押した点の側の辺 (Alt なら中心) を固定し、大きさを整数にしてから位置を決めるので、
 * Shift の正方形は丸めても正方形のまま。
 */
export function dragBox(start: Point, pointer: Point, origin: Point, mods: BoxModifiers): Rect {
  const s = { x: start.x - origin.x, y: start.y - origin.y };
  let dx = pointer.x - start.x;
  let dy = pointer.y - start.y;
  if (mods.square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * m;
    dy = (dy < 0 ? -1 : 1) * m;
  }
  const span = (d: number) =>
    Math.max(1, roundInt(mods.fromCenter ? 2 * Math.abs(d) : Math.abs(d)));
  let width = span(dx);
  let height = span(dy);
  if (mods.square) width = height = Math.max(width, height);
  if (mods.fromCenter)
    return { x: roundInt(s.x - width / 2), y: roundInt(s.y - height / 2), width, height };
  const left = roundInt(s.x);
  const top = roundInt(s.y);
  return {
    x: dx < 0 ? left - width : left,
    y: dy < 0 ? top - height : top,
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
 * 長さが 0 になるなら null (作らない)。
 */
export function dragLine(
  start: Point,
  pointer: Point,
  origin: Point,
  mods: LineModifiers,
): LineGeometry | null {
  const [end, begin] = moveLineEnd({
    from: start,
    other: start,
    pointer,
    constrain: mods.constrain,
    fromCenter: mods.fromCenter,
    snap: null,
  });
  const line = {
    x1: roundInt(begin.x - origin.x),
    y1: roundInt(begin.y - origin.y),
    x2: roundInt(end.x - origin.x),
    y2: roundInt(end.y - origin.y),
  };
  return line.x1 === line.x2 && line.y1 === line.y2 ? null : line;
}

/** 親の座標系の矩形をページ座標へ。 */
export function boxToPage(box: Rect, origin: Point): Rect {
  return { ...box, x: box.x + origin.x, y: box.y + origin.y };
}
