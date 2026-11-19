/**
 * リサイズハンドル・回転のハンドル・ガイド線の当たり (純関数)。大きさは画面 px で決め、倍率で割ってページ座標にする。
 *
 * 選択枠は 2 通り (§4.11.3)。
 * - 軸に平行な矩形 (`Rect`): 複数選択・group・ブーリアン・線・回転していないノード。`handleAt` などの第 1 段階の関数
 * - 回転した枠 (`HandleBox`): 1 個だけ選んだ、ページ上の角度が 0 でない箱を持つノード。`boxHandleAt` など。
 *   軸に平行な枠を `rectHandleBox` で包んで渡すと、第 1 段階の関数と同じ値を返す
 *
 * 回転のハンドルは枠の 4 隅のすぐ外 (リサイズのハンドルの外側、`ROTATE_HIT` 画面 px 以内)。
 */
import { applyToPoint, invert, type Matrix, translate } from "../geometry/matrix";
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

/**
 * ハンドルの上のカーソル。`rotation` は枠のページ上の角度 (度)。ハンドルの向きに近い 45° 刻みのカーソルにする。
 */
export function handleCursor(handle: ResizeHandle, rotation = 0): string {
  if (rotation !== 0 && Number.isFinite(rotation)) {
    const { x, y } = handleSides(handle);
    const direction = (Math.atan2(y, x) * 180) / Math.PI + rotation;
    // 向きは 180° ごとに同じカーソル。0 → 左右、45 → 左上と右下、90 → 上下、135 → 右上と左下
    const step = ((Math.round(direction / 45) % 4) + 4) % 4;
    return (["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const)[step] as string;
  }
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

// ---------------------------------------------------------------------------
// 回転した枠
// ---------------------------------------------------------------------------

/**
 * 選択枠 (回転してよい)。`matrix` はページ ← 枠の座標系 (回転と平行移動だけ)。枠は枠の座標系の
 * (0, 0)〜(`width`, `height`)。1 個の回転したノードなら `nodePageMatrix` とノードの大きさ。
 */
export interface HandleBox {
  matrix: Matrix;
  width: number;
  height: number;
}

/** 軸に平行な矩形 (ページ座標) の枠。 */
export function rectHandleBox(rect: Rect): HandleBox {
  return { matrix: translate(rect.x, rect.y), width: rect.width, height: rect.height };
}

/** 平行移動だけの枠なら、その矩形 (ページ座標)。回転していれば null。 */
export function handleBoxRect(box: HandleBox): Rect | null {
  const m = box.matrix;
  if (m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) return null;
  return { x: m.e, y: m.f, width: box.width, height: box.height };
}

/** 枠のページ上の角度 (度、時計回りが正)。 */
export function handleBoxAngle(box: HandleBox): number {
  if (handleBoxRect(box)) return 0;
  const angle = (Math.atan2(box.matrix.b, box.matrix.a) * 180) / Math.PI;
  return angle === 0 ? 0 : angle;
}

/** 枠の座標系の点をページ座標へ。 */
export function handleBoxToPage(box: HandleBox, local: Point): Point {
  return applyToPoint(box.matrix, local);
}

/** ページ座標の点を枠の座標系へ。逆がなければ null。 */
export function pageToHandleBox(box: HandleBox, point: Point): Point | null {
  const back = invert(box.matrix);
  return back ? applyToPoint(back, point) : null;
}

/** 枠の 4 隅 (ページ座標、枠の座標系の [左上, 右上, 右下, 左下])。 */
export function handleBoxCorners(box: HandleBox): Point[] {
  return [
    { x: 0, y: 0 },
    { x: box.width, y: 0 },
    { x: box.width, y: box.height },
    { x: 0, y: box.height },
  ].map((p) => handleBoxToPage(box, p));
}

/** 枠の座標系の矩形 (原点が左上)。 */
function localRect(box: HandleBox): Rect {
  return { x: 0, y: 0, width: box.width, height: box.height };
}

/** 描くハンドル (`visibleHandles` の回転した枠の版)。 */
export function boxVisibleHandles(box: HandleBox, zoom: number): ResizeHandle[] {
  return visibleHandles(handleBoxRect(box) ?? localRect(box), zoom);
}

/** ハンドルの中心 (ページ座標)。 */
export function boxHandlePosition(box: HandleBox, handle: ResizeHandle): Point {
  const rect = handleBoxRect(box);
  if (rect) return handlePosition(rect, handle);
  return handleBoxToPage(box, handlePosition(localRect(box), handle));
}

/**
 * 点 (ページ座標) の下のリサイズハンドル (`handleAt` の回転した枠の版)。枠の座標系に直して同じ規則で判定する
 * (行列は回転と平行移動だけなので、距離は変わらない)。
 */
export function boxHandleAt(box: HandleBox, point: Point, zoom: number): ResizeHandle | null {
  const rect = handleBoxRect(box);
  if (rect) return handleAt(rect, point, zoom);
  const local = pageToHandleBox(box, point);
  return local ? handleAt(localRect(box), local, zoom) : null;
}

/** ハンドルの上のカーソル (枠の角度に合わせる)。 */
export function boxHandleCursor(box: HandleBox, handle: ResizeHandle): string {
  return handleCursor(handle, handleBoxAngle(box));
}

/** 回転のハンドルが当たる、枠の角からの距離 (画面 px)。リサイズのハンドルの外側。 */
export const ROTATE_HIT = 16;

export type RotateCorner = "nw" | "ne" | "se" | "sw";

/**
 * 点 (ページ座標) の下の回転のハンドル。枠の外で、いちばん近い角から `ROTATE_HIT` 画面 px 以内なら、その角。
 * リサイズのハンドルを先に調べること (角のハンドルと辺の近くはリサイズ)。
 */
export function rotationCornerAt(box: HandleBox, point: Point, zoom: number): RotateCorner | null {
  const local = pageToHandleBox(box, point);
  if (!local) return null;
  const { width, height } = box;
  if (local.x >= 0 && local.x <= width && local.y >= 0 && local.y <= height) return null;
  const hit = ROTATE_HIT / zoom;
  let best: RotateCorner | null = null;
  let bestDistance = Infinity;
  for (const corner of ["nw", "ne", "se", "sw"] as const) {
    const c = handlePosition(localRect(box), corner);
    const distance = Math.hypot(local.x - c.x, local.y - c.y);
    if (distance <= hit && distance < bestDistance) {
      best = corner;
      bestDistance = distance;
    }
  }
  return best;
}

/** 角の外向きの向き (枠の座標系、度)。右下が 45°。 */
export function cornerDirection(corner: RotateCorner): number {
  const { x, y } = handleSides(corner);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** 回転のカーソルの角度の刻み (度)。カーソルの文字列を作り直す回数を抑える。 */
const ROTATE_CURSOR_STEP = 15;

/**
 * 回転のカーソル。`direction` は、回転の中心からカーソルへの向き (ページ座標、度。右下が 45°)。
 * 曲がった両向きの矢印を、その向きに回して描く (CSS に回転のカーソルはないので SVG で作る)。
 */
export function rotateCursor(direction: number): string {
  const step = Math.round((direction - 45) / ROTATE_CURSOR_STEP) * ROTATE_CURSOR_STEP;
  const angle = ((step % 360) + 360) % 360;
  // 24×24、ホットスポットは中心。基本の形は右下の角の外 (弧の中心は左上)
  const arc = "M15 5.5A9.5 9.5 0 0 1 5.5 15";
  const heads = "M15 1.5L18.2 6.5L11.8 6.5Z M1.5 15L6.5 11.8L6.5 18.2Z";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
    `<g transform='rotate(${angle} 12 12)'>` +
    `<path d='${arc}' fill='none' stroke='white' stroke-width='4'/>` +
    `<path d='${heads}' fill='white' stroke='white' stroke-width='2.5' stroke-linejoin='round'/>` +
    `<path d='${arc}' fill='none' stroke='black' stroke-width='1.5'/>` +
    `<path d='${heads}' fill='black'/>` +
    `</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, auto`;
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
