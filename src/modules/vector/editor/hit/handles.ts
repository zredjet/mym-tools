/**
 * リサイズハンドルとガイド線の当たり (純関数)。大きさは画面 px で決め、倍率で割ってページ座標にする。
 */
import type { Rect } from "../model/geometry";
import type { Guide, Point } from "../model/types";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const RESIZE_HANDLES: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 描くハンドルの一辺 (画面 px)。 */
export const HANDLE_SIZE = 8;
/** 角のハンドルが当たる範囲の半分 (画面 px)。 */
export const CORNER_HIT = 6;
/** 辺のハンドルが当たる、辺からの距離 (画面 px)。辺の全体で当たる。 */
export const EDGE_HIT = 4;
/**
 * 画面上の幅か高さがこれより小さい選択は、枠の内側でハンドルに当てない
 * (小さな図形でも中を押せば動かせるように。§4.6)。
 */
export const SMALL_SELECTION = 32;
/** ガイド線が当たる距離 (画面 px)。 */
export const GUIDE_HIT = 3;

/** ハンドルが動かす辺。-1 は左 (上)、1 は右 (下)、0 は動かさない。 */
export function handleSides(handle: ResizeHandle): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  return {
    x: handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0,
    y: handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0,
  };
}

/** 辺の中央のハンドルを描く、辺の画面上の長さの下限 (画面 px)。短い辺では角のハンドルと重なるので描かない (辺は引ける)。 */
export const MIN_EDGE_HANDLE_SPAN = 32;

/** 描くハンドル。角は常に、辺の中央は辺が `MIN_EDGE_HANDLE_SPAN` 画面 px 以上のときだけ。 */
export function visibleHandles(bounds: Rect, zoom: number): ResizeHandle[] {
  const wide = bounds.width * zoom >= MIN_EDGE_HANDLE_SPAN;
  const tall = bounds.height * zoom >= MIN_EDGE_HANDLE_SPAN;
  return RESIZE_HANDLES.filter((handle) => {
    if (handle === "n" || handle === "s") return wide;
    if (handle === "e" || handle === "w") return tall;
    return true;
  });
}

/** ハンドルの中心 (ページ座標)。 */
export function handlePosition(bounds: Rect, handle: ResizeHandle): Point {
  const { x, y } = handleSides(handle);
  return {
    x: bounds.x + ((x + 1) / 2) * bounds.width,
    y: bounds.y + ((y + 1) / 2) * bounds.height,
  };
}

function inside(bounds: Rect, p: Point): boolean {
  return (
    p.x > bounds.x &&
    p.x < bounds.x + bounds.width &&
    p.y > bounds.y &&
    p.y < bounds.y + bounds.height
  );
}

/** 点 (ページ座標) の下のリサイズハンドル。角を辺より先に調べる。なければ null。 */
export function handleAt(bounds: Rect, point: Point, zoom: number): ResizeHandle | null {
  const unit = 1 / zoom;
  const small = bounds.width * zoom < SMALL_SELECTION || bounds.height * zoom < SMALL_SELECTION;
  if (small && inside(bounds, point)) return null;

  let best: ResizeHandle | null = null;
  let bestDistance = Infinity;
  for (const handle of ["nw", "ne", "se", "sw"] as const) {
    const c = handlePosition(bounds, handle);
    const dx = Math.abs(point.x - c.x);
    const dy = Math.abs(point.y - c.y);
    if (dx > CORNER_HIT * unit || dy > CORNER_HIT * unit) continue;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  }
  if (best) return best;

  const hit = EDGE_HIT * unit;
  const withinX = point.x >= bounds.x && point.x <= bounds.x + bounds.width;
  const withinY = point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  const top = Math.abs(point.y - bounds.y);
  const bottom = Math.abs(point.y - (bounds.y + bounds.height));
  const left = Math.abs(point.x - bounds.x);
  const right = Math.abs(point.x - (bounds.x + bounds.width));
  const candidates: [ResizeHandle, number, boolean][] = [
    ["n", top, withinX],
    ["s", bottom, withinX],
    ["w", left, withinY],
    ["e", right, withinY],
  ];
  for (const [handle, distance, within] of candidates)
    if (within && distance <= hit && distance < bestDistance) {
      best = handle;
      bestDistance = distance;
    }
  return best;
}

/** ハンドルの上のカーソル。 */
export function handleCursor(handle: ResizeHandle): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    default:
      return "ew-resize";
  }
}

export type LineEnd = "start" | "end";

/** 線の端点のハンドル (線を 1 本だけ選んだとき)。`start` は (x1, y1)。近い方を返す。 */
export function lineEndAt(start: Point, end: Point, point: Point, zoom: number): LineEnd | null {
  const hit = CORNER_HIT / zoom;
  const ds = Math.max(Math.abs(point.x - start.x), Math.abs(point.y - start.y));
  const de = Math.max(Math.abs(point.x - end.x), Math.abs(point.y - end.y));
  if (ds > hit && de > hit) return null;
  return ds <= de ? "start" : "end";
}

/** 線の端点の上のカーソル。 */
export const LINE_END_CURSOR = "crosshair";

/** 点 (ページ座標) の近くのガイド線の番号。いちばん近いものを返す。なければ null。 */
export function guideAt(guides: readonly Guide[], point: Point, zoom: number): number | null {
  const hit = GUIDE_HIT / zoom;
  let best: number | null = null;
  let bestDistance = Infinity;
  guides.forEach((guide, index) => {
    const distance = Math.abs((guide.axis === "x" ? point.x : point.y) - guide.position);
    if (distance <= hit && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** ガイド線の上のカーソル。`x` は縦の線なので左右に動かす。 */
export function guideCursor(axis: Guide["axis"]): string {
  return axis === "x" ? "ew-resize" : "ns-resize";
}
