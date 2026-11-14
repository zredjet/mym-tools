/**
 * 幾何。座標の規則は §3.2: ページ直下はページ座標、frame の子は frame の左上が原点、
 * group は座標系を作らない。外接矩形は図形の幾何だけから求める (線の太さ・影は含めない)。
 */
import { getChildren, getCoordinateFrame, getNode, type ParentRef } from "./tree";
import type { CanvasDocument, CanvasNode, NodeId, Point } from "./types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ORIGIN: Point = { x: 0, y: 0 };

/** 位置と大きさを持つノード (line と group 以外)。 */
export type BoxNode = Extract<CanvasNode, { width: number }>;

export function isBoxNode(node: CanvasNode): node is BoxNode {
  return node.type !== "line" && node.type !== "group";
}

/** frame の座標系の原点 (frame の左上) のページ座標。祖先の frame の位置を足し合わせる。 */
function frameOrigin(doc: CanvasDocument, frameId: NodeId): Point {
  const frame = getNode(doc, frameId);
  if (!frame || frame.type !== "frame") return ORIGIN;
  const outer = nodeOrigin(doc, frameId);
  return { x: outer.x + frame.x, y: outer.y + frame.y };
}

/** ノードが座標を持つ座標系 (親の座標系) の原点のページ座標。 */
export function nodeOrigin(doc: CanvasDocument, id: NodeId): Point {
  const frame = getCoordinateFrame(doc, id);
  return frame ? frameOrigin(doc, frame.id) : ORIGIN;
}

/**
 * 親 (ページ / frame / group) の子が座標を持つ座標系の原点のページ座標。
 * group の子は group の親の座標系なので、group を渡すと group の座標系の原点になる。
 */
export function parentOrigin(doc: CanvasDocument, parent: ParentRef): Point {
  if (parent.kind === "page") return ORIGIN;
  const node = getNode(doc, parent.id);
  if (!node) return ORIGIN;
  return node.type === "frame" ? frameOrigin(doc, node.id) : nodeOrigin(doc, node.id);
}

/** 親の座標系の点をページ座標へ。 */
export function localToPage(doc: CanvasDocument, parent: ParentRef, point: Point): Point {
  const origin = parentOrigin(doc, parent);
  return { x: point.x + origin.x, y: point.y + origin.y };
}

/** ページ座標の点を親の座標系へ。新しいノードを frame の中に置くときに使う。 */
export function pageToLocal(doc: CanvasDocument, parent: ParentRef, point: Point): Point {
  const origin = parentOrigin(doc, parent);
  return { x: point.x - origin.x, y: point.y - origin.y };
}

/**
 * ノードの外接矩形を親の座標系で返す。frame は自分の矩形 (子ははみ出しても含めない)、
 * line は 2 点を囲む矩形 (水平・垂直の線は幅か高さが 0)、group は子の外接矩形の和。
 * 子のない group と存在しないノードは null。
 */
export function getLocalBounds(doc: CanvasDocument, id: NodeId): Rect | null {
  const node = getNode(doc, id);
  if (!node) return null;
  switch (node.type) {
    case "line":
      return {
        x: Math.min(node.x1, node.x2),
        y: Math.min(node.y1, node.y2),
        width: Math.abs(node.x2 - node.x1),
        height: Math.abs(node.y2 - node.y1),
      };
    case "group":
      return unionRects(node.children.map((child) => getLocalBounds(doc, child)));
    default:
      return { x: node.x, y: node.y, width: node.width, height: node.height };
  }
}

/** ノードの外接矩形をページ座標で返す。 */
export function getPageBounds(doc: CanvasDocument, id: NodeId): Rect | null {
  const local = getLocalBounds(doc, id);
  if (!local) return null;
  const origin = nodeOrigin(doc, id);
  return { ...local, x: local.x + origin.x, y: local.y + origin.y };
}

/** 複数ノードの外接矩形 (ページ座標)。1 つもなければ null。 */
export function getSelectionBounds(doc: CanvasDocument, ids: readonly NodeId[]): Rect | null {
  return unionRects(ids.map((id) => getPageBounds(doc, id)));
}

/** 親の子すべての外接矩形 (ページ座標)。 */
export function getChildrenBounds(doc: CanvasDocument, parent: ParentRef): Rect | null {
  return getSelectionBounds(doc, getChildren(doc, parent));
}

/** null を飛ばして和をとる。1 つもなければ null。 */
export function unionRects(rects: readonly (Rect | null | undefined)[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 2 点から矩形を作る (向きは問わない)。範囲選択や作成ツールのドラッグに使う。 */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** 重なるか。辺が接するだけでも true (幅 0 の線も範囲選択で拾えるように)。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/** `outer` が `inner` を完全に含むか (辺が重なってもよい)。 */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
