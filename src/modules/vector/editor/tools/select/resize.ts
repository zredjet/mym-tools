/**
 * リサイズの矩形と線の端点の計算 (§4.6)。純関数。
 *
 * - ハンドルの反対側の辺 (Alt なら中心) を固定し、ハンドルの辺をポインターへ動かす
 * - 縦横比の固定は、角では変化の大きい方の向きに合わせ、辺では反対の向きを中心から伸ばす
 * - 反対側を越えて引いたら、向きを入れ替えた矩形にする (中身は反転しない)
 * - スナップはハンドルが動かす辺だけに効かせる
 */
import type { Rect } from "../../model/geometry";
import type { Point } from "../../model/types";
import { handleSides, type ResizeHandle } from "../../hit/handles";
import { snapValue, type SnapOptions, type SnapTargets } from "../../snap/snap";

export interface ResizeInput {
  /** 開始時の外接矩形 (ページ座標) */
  start: Rect;
  handle: ResizeHandle;
  /**
   * ハンドルの辺の、ポインターに対する位置 (ページ座標)。押した位置とハンドルの辺の差を
   * 開始時に求めて足すので、ハンドルの中心からずれた所を押しても矩形が跳ねない
   */
  pointer: Point;
  /** 縦横比を固定する */
  keepAspect: boolean;
  /** 中心を固定する (Alt) */
  fromCenter: boolean;
  /** 吸着。null なら吸着しない */
  snap: { targets: SnapTargets; options: SnapOptions } | null;
}

function normalize(left: number, top: number, right: number, bottom: number): Rect {
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(bottom - top),
  };
}

/** リサイズ後の矩形 (ページ座標、丸める前)。 */
export function resizeRect(input: ResizeInput): Rect {
  const { start, handle, pointer, keepAspect, fromCenter, snap } = input;
  const sides = handleSides(handle);
  const cx = start.x + start.width / 2;
  const cy = start.y + start.height / 2;
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;

  // ハンドルの辺をポインターへ (吸着してから)
  if (sides.x !== 0) {
    let edge = pointer.x;
    if (snap) edge += snapValue(edge, snap.targets.x, snap.options);
    if (sides.x > 0) right = edge;
    else left = edge;
    if (fromCenter) {
      if (sides.x > 0) left = 2 * cx - right;
      else right = 2 * cx - left;
    }
  }
  if (sides.y !== 0) {
    let edge = pointer.y;
    if (snap) edge += snapValue(edge, snap.targets.y, snap.options);
    if (sides.y > 0) bottom = edge;
    else top = edge;
    if (fromCenter) {
      if (sides.y > 0) top = 2 * cy - bottom;
      else bottom = 2 * cy - top;
    }
  }

  if (!keepAspect || start.width === 0 || start.height === 0) {
    return normalize(left, top, right, bottom);
  }

  // 縦横比を固定する。倍率は符号付き (反対側を越えたら負)
  const scaleX = (right - left) / start.width;
  const scaleY = (bottom - top) / start.height;
  let scale: number;
  if (sides.x !== 0 && sides.y !== 0)
    scale = Math.abs(scaleX) >= Math.abs(scaleY) ? scaleX : scaleY;
  else scale = sides.x !== 0 ? scaleX : scaleY;
  const width = start.width * Math.abs(scale);
  const height = start.height * Math.abs(scale);
  const flip = scale < 0;

  // 固定する点 (アンカー) から、ハンドルの向きへ伸ばす
  const place = (
    side: -1 | 0 | 1,
    startMin: number,
    startMax: number,
    center: number,
    size: number,
  ): [number, number] => {
    if (side === 0 || fromCenter) return [center - size / 2, center + size / 2];
    const direction = flip ? -side : side;
    const anchor = side > 0 ? startMin : startMax;
    return direction > 0 ? [anchor, anchor + size] : [anchor - size, anchor];
  };
  const [x0, x1] = place(sides.x, start.x, start.x + start.width, cx, width);
  const [y0, y1] = place(sides.y, start.y, start.y + start.height, cy, height);
  return normalize(x0, y0, x1, y1);
}

/** 辺のハンドルを押した位置から、ハンドルの辺までの差 (ページ座標)。 */
export function grabOffset(start: Rect, handle: ResizeHandle, press: Point): Point {
  const sides = handleSides(handle);
  const edgeX = sides.x > 0 ? start.x + start.width : start.x;
  const edgeY = sides.y > 0 ? start.y + start.height : start.y;
  return {
    x: sides.x === 0 ? 0 : edgeX - press.x,
    y: sides.y === 0 ? 0 : edgeY - press.y,
  };
}

export interface LineEndInput {
  /** 動かす端点の開始時の位置 (ページ座標) */
  from: Point;
  /** 動かさない端点 (ページ座標) */
  other: Point;
  /** 動かす端点の行き先 (ポインター + 押した位置の差) */
  pointer: Point;
  /** Shift: 角度を 45° 刻みに */
  constrain: boolean;
  /** Alt: 中点を固定して両端を動かす */
  fromCenter: boolean;
  snap: { targets: SnapTargets; options: SnapOptions } | null;
}

/** 線の端点を動かした後の 2 点 (ページ座標、丸める前)。`[動かす端点, 反対の端点]`。 */
export function moveLineEnd(input: LineEndInput): [Point, Point] {
  const { other, constrain, fromCenter, snap } = input;
  const mid = { x: (input.from.x + other.x) / 2, y: (input.from.y + other.y) / 2 };
  const anchor = fromCenter ? mid : other;
  let p = { ...input.pointer };
  if (constrain) {
    const dx = p.x - anchor.x;
    const dy = p.y - anchor.y;
    const length = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    p = {
      x: anchor.x + Math.round(Math.cos(angle) * length * 1e9) / 1e9,
      y: anchor.y + Math.round(Math.sin(angle) * length * 1e9) / 1e9,
    };
  } else if (snap) {
    p = {
      x: p.x + snapValue(p.x, snap.targets.x, snap.options),
      y: p.y + snapValue(p.y, snap.targets.y, snap.options),
    };
  }
  const opposite = fromCenter ? { x: 2 * mid.x - p.x, y: 2 * mid.y - p.y } : other;
  return [p, opposite];
}
