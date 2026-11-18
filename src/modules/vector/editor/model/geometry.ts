/**
 * 幾何。座標の規則は §3.2 と §4.11: ページ直下はページ座標、frame の子は frame の座標系 (回転の前の箱の左上が原点)、
 * group とブーリアンは座標系を作らない。外接矩形は図形の幾何だけから求める (線の太さ・影は含めない)。
 *
 * 変換は「親の座標系 ← ノードの座標系」の行列 (`geometry/matrix.ts`) で表す (§4.11)。
 * - 箱を持つノード: `T(x, y) · R(rotation, 箱の中心)`。線・group・ブーリアン: 恒等
 * - frame は平行移動と回転だけなので、どの行列も「回転 + 平行移動」(距離を変えない)
 * - 回転していない文書では、どの関数も第 1 段階と同じ値を返す (平行移動だけの行列は足し算で求める)
 *
 * E・F・G が使うもの (どれも純関数。ページ座標は表示中のページの座標):
 * - `nodeTransform(node)`: 親の座標系 ← ノードの座標系 (箱を持つノード以外は恒等)
 * - `coordinateMatrix(doc, id)`: ページ ← ノードが座標を持つ座標系 (親の座標系)
 * - `parentMatrix(doc, parent)`: ページ ← 親 (ページ / frame / group / ブーリアン) の子が座標を持つ座標系
 * - `nodePageMatrix(doc, id)`: ページ ← ノードの座標系 (= `coordinateMatrix` · `nodeTransform`)
 * - `pageRotation(doc, id)` / `parentPageRotation(doc, parent)`: ページ上の角度 φ (度、(-180, 180])
 * - `localToPage` / `pageToLocal` / `localVectorToPage` / `pageVectorToLocal`: 親の座標系とページ座標の変換
 * - `nodeOrigin` / `parentOrigin`: 座標系の原点のページ座標 (回転した frame の中では、点の変換に使えない。
 *   行列を使うこと)
 * - `getLocalBounds` / `getPageBounds` / `getSelectionBounds` / `getChildrenBounds`: 軸に平行な外接矩形 (§4.11.1)
 * - `getNodeCorners(doc, id)`: 箱を持つノードの回転した箱の 4 隅 (ページ座標、[左上, 右上, 右下, 左下]。
 *   ノードの座標系での向き)。1 個だけ選んだ回転したノードの選択枠とハンドルに使う
 * - `boxCenter(node)`: 箱の中心 (親の座標系)。`mapRectBounds(m, rect)`: 矩形を行列で写した外接矩形
 */
import { getBooleanResult } from "../boolean/result";
import {
  applyToPoint,
  applyToVector,
  IDENTITY,
  invert,
  type Matrix,
  multiply,
  nodeMatrix,
  normalizeRotation,
} from "../geometry/matrix";
import { pathBounds } from "../path/measure";
import { getChildren, getCoordinateFrame, getNode, type ParentRef } from "./tree";
import type { CanvasDocument, CanvasNode, NodeId, PathNode, Point } from "./types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 位置と大きさを持つノード (line と group とブーリアン以外)。 */
export type BoxNode = Extract<CanvasNode, { width: number }>;

/** 箱を持つノード (frame、矩形、楕円、テキスト、画像、埋め込み SVG、パス) か。ブーリアンは箱を持たない。 */
export function isBoxNode(node: CanvasNode): node is BoxNode {
  return node.type !== "line" && node.type !== "group" && node.type !== "boolean";
}

// ---------------------------------------------------------------------------
// 行列
// ---------------------------------------------------------------------------

/** 平行移動だけの行列か (回転していない座標系)。 */
export function isTranslation(m: Matrix): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
}

/** 親の座標系 ← ノードの座標系。箱を持つノードは `T(x, y) · R(rotation, 箱の中心)`、ほかは恒等。 */
export function nodeTransform(node: CanvasNode): Matrix {
  if (!isBoxNode(node)) return IDENTITY;
  return nodeMatrix(node.x, node.y, node.width, node.height, node.rotation);
}

/** ページ ← frame の子の座標系。壊れた文書の循環でも止まる。 */
function frameSpace(doc: CanvasDocument, frameId: NodeId, guard: number): Matrix {
  const frame = getNode(doc, frameId);
  if (!frame || frame.type !== "frame" || guard > 1000) return IDENTITY;
  const outer = getCoordinateFrame(doc, frameId);
  const base = outer ? frameSpace(doc, outer.id, guard + 1) : IDENTITY;
  return multiply(base, nodeTransform(frame));
}

/** ページ ← ノードが座標を持つ座標系 (親の座標系)。ページ直下と、frame の外の group・ブーリアンの子は恒等。 */
export function coordinateMatrix(doc: CanvasDocument, id: NodeId): Matrix {
  const frame = getCoordinateFrame(doc, id);
  return frame ? frameSpace(doc, frame.id, 0) : IDENTITY;
}

/**
 * ページ ← 親の子が座標を持つ座標系。frame はその座標系、group とブーリアンは自分の親の座標系、ページは恒等。
 */
export function parentMatrix(doc: CanvasDocument, parent: ParentRef): Matrix {
  if (parent.kind === "page") return IDENTITY;
  const node = getNode(doc, parent.id);
  if (!node) return IDENTITY;
  return node.type === "frame" ? frameSpace(doc, node.id, 0) : coordinateMatrix(doc, node.id);
}

/** ページ ← ノードの座標系 (箱を持つノードは回転の前の箱の左上が原点。ほかは親の座標系と同じ)。 */
export function nodePageMatrix(doc: CanvasDocument, id: NodeId): Matrix {
  const node = getNode(doc, id);
  const space = coordinateMatrix(doc, id);
  return node ? multiply(space, nodeTransform(node)) : space;
}

/** 祖先の frame の回転の和 (度。そろえない)。 */
function frameRotationSum(doc: CanvasDocument, frame: CanvasNode | null, guard = 0): number {
  if (!frame || frame.type !== "frame" || guard > 1000) return 0;
  return frame.rotation + frameRotationSum(doc, getCoordinateFrame(doc, frame.id), guard + 1);
}

/**
 * ノードのページ上の角度 φ (§4.11)。自分の `rotation` (箱を持つノード) と祖先の frame の `rotation` の和を
 * (-180, 180] にそろえたもの。線・group・ブーリアンは祖先の和。
 */
export function pageRotation(doc: CanvasDocument, id: NodeId): number {
  const node = getNode(doc, id);
  const own = node && isBoxNode(node) ? node.rotation : 0;
  return normalizeRotation(own + frameRotationSum(doc, getCoordinateFrame(doc, id)));
}

/** 親の子の座標系のページ上の角度 (frame ならその frame までの和、group・ブーリアンは自分の座標系の角度)。 */
export function parentPageRotation(doc: CanvasDocument, parent: ParentRef): number {
  if (parent.kind === "page") return 0;
  const node = getNode(doc, parent.id);
  if (!node) return 0;
  const frame = node.type === "frame" ? node : getCoordinateFrame(doc, node.id);
  return normalizeRotation(frameRotationSum(doc, frame));
}

/** 行列で点を写す。平行移動だけなら足し算で求める (第 1 段階と同じ値)。 */
function mapPoint(m: Matrix, p: Point): Point {
  if (isTranslation(m)) return { x: p.x + m.e, y: p.y + m.f };
  return applyToPoint(m, p);
}

/** 逆の行列で点を写す。平行移動だけなら引き算で求める。逆がなければ点のまま。 */
function unmapPoint(m: Matrix, p: Point): Point {
  if (isTranslation(m)) return { x: p.x - m.e, y: p.y - m.f };
  const inverse = invert(m);
  return inverse ? applyToPoint(inverse, p) : { x: p.x, y: p.y };
}

/** ノードが座標を持つ座標系 (親の座標系) の原点のページ座標。 */
export function nodeOrigin(doc: CanvasDocument, id: NodeId): Point {
  const m = coordinateMatrix(doc, id);
  return { x: m.e, y: m.f };
}

/**
 * 親 (ページ / frame / group / ブーリアン) の子が座標を持つ座標系の原点のページ座標。
 * group とブーリアンの子は自分の親の座標系なので、渡すとその座標系の原点になる。
 */
export function parentOrigin(doc: CanvasDocument, parent: ParentRef): Point {
  const m = parentMatrix(doc, parent);
  return { x: m.e, y: m.f };
}

/** 親の座標系の点をページ座標へ。 */
export function localToPage(doc: CanvasDocument, parent: ParentRef, point: Point): Point {
  return mapPoint(parentMatrix(doc, parent), point);
}

/** ページ座標の点を親の座標系へ。新しいノードを frame の中に置くときに使う。 */
export function pageToLocal(doc: CanvasDocument, parent: ParentRef, point: Point): Point {
  return unmapPoint(parentMatrix(doc, parent), point);
}

/** 親の座標系のずれ (ベクトル) をページ座標のずれへ。 */
export function localVectorToPage(doc: CanvasDocument, parent: ParentRef, vector: Point): Point {
  const m = parentMatrix(doc, parent);
  return isTranslation(m) ? { x: vector.x, y: vector.y } : applyToVector(m, vector);
}

/** ページ座標のずれ (ベクトル) を親の座標系のずれへ。 */
export function pageVectorToLocal(doc: CanvasDocument, parent: ParentRef, vector: Point): Point {
  const m = parentMatrix(doc, parent);
  if (isTranslation(m)) return { x: vector.x, y: vector.y };
  const inverse = invert(m);
  return inverse ? applyToVector(inverse, vector) : { x: vector.x, y: vector.y };
}

// ---------------------------------------------------------------------------
// 外接矩形
// ---------------------------------------------------------------------------

/** 矩形の 4 隅 ([左上, 右上, 右下, 左下])。 */
export function rectCorners(rect: Rect): Point[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [
    { x: rect.x, y: rect.y },
    { x: right, y: rect.y },
    { x: right, y: bottom },
    { x: rect.x, y: bottom },
  ];
}

/** 点を囲む軸に平行な矩形。点がなければ null。 */
export function boundsOfPoints(points: readonly Point[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 矩形を行列で写した形の、軸に平行な外接矩形。平行移動だけなら大きさを変えずに動かす。 */
export function mapRectBounds(m: Matrix, rect: Rect): Rect {
  if (isTranslation(m))
    return m.e === 0 && m.f === 0 ? rect : { ...rect, x: rect.x + m.e, y: rect.y + m.f };
  return boundsOfPoints(rectCorners(rect).map((p) => applyToPoint(m, p))) ?? rect;
}

/** 箱の中心 (親の座標系)。 */
export function boxCenter(node: BoxNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/** パスの曲線の範囲 (自分の座標系) を、ノードのオブジェクトをキーに使い回す。 */
const pathLocalCache = new WeakMap<PathNode, Rect | null>();

function pathLocalBounds(node: PathNode): Rect | null {
  if (pathLocalCache.has(node)) return pathLocalCache.get(node) ?? null;
  const b = pathBounds(node.subpaths);
  const rect = b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : null;
  pathLocalCache.set(node, rect);
  return rect;
}

/**
 * ノードの軸に平行な外接矩形を、`space` (ある座標系 ← ノードの親の座標系) で写した先の座標系で求める。
 * `space` が恒等なら親の座標系、`coordinateMatrix` ならページ座標。
 */
function boundsIn(
  doc: CanvasDocument,
  node: CanvasNode,
  space: Matrix,
  seen: Set<NodeId>,
): Rect | null {
  switch (node.type) {
    case "line":
      if (isTranslation(space))
        return mapRectBounds(space, {
          x: Math.min(node.x1, node.x2),
          y: Math.min(node.y1, node.y2),
          width: Math.abs(node.x2 - node.x1),
          height: Math.abs(node.y2 - node.y1),
        });
      return boundsOfPoints([
        applyToPoint(space, { x: node.x1, y: node.y1 }),
        applyToPoint(space, { x: node.x2, y: node.y2 }),
      ]);
    case "group":
      return childrenBoundsIn(doc, node.children, space, seen);
    case "boolean": {
      // 結果の範囲。空か求められないときは子の外接矩形の和 (§4.11.1)
      const result = getBooleanResult(doc, node.id);
      if (result && result.bounds && result.subpaths.length > 0) {
        if (isTranslation(space)) return mapRectBounds(space, result.bounds);
        const b = pathBounds(result.subpaths, space);
        if (b) return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
      }
      return childrenBoundsIn(doc, node.children, space, seen);
    }
    case "path": {
      // 形を行列で写してから曲線の範囲を求める (4 隅を囲むのではない。§4.11.1)
      if (node.rotation === 0 && isTranslation(space)) {
        const local = pathLocalBounds(node);
        if (!local) return null;
        return mapRectBounds(space, { ...local, x: local.x + node.x, y: local.y + node.y });
      }
      const b = pathBounds(node.subpaths, multiply(space, nodeTransform(node)));
      return b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : null;
    }
    default: {
      const box = { x: node.x, y: node.y, width: node.width, height: node.height };
      if (node.rotation === 0 && isTranslation(space)) return mapRectBounds(space, box);
      // 回転した箱の 4 隅を囲む (楕円とテキストも。選択枠に見える箱と同じ)
      const m = multiply(space, nodeTransform(node));
      return (
        boundsOfPoints(
          rectCorners({ x: 0, y: 0, width: node.width, height: node.height }).map((p) =>
            applyToPoint(m, p),
          ),
        ) ?? box
      );
    }
  }
}

function childrenBoundsIn(
  doc: CanvasDocument,
  children: readonly NodeId[],
  space: Matrix,
  seen: Set<NodeId>,
): Rect | null {
  return unionRects(
    children.map((child) => {
      const node = getNode(doc, child);
      if (!node || seen.has(child)) return null; // 壊れた文書の循環でも止まる
      seen.add(child);
      const rect = boundsIn(doc, node, space, seen);
      seen.delete(child);
      return rect;
    }),
  );
}

/**
 * ノードの軸に平行な外接矩形を親の座標系で返す (§4.11.1)。
 * - 箱を持つノード (frame・楕円・テキストを含む) は回転した箱の 4 隅を囲む矩形。frame は子がはみ出しても含めない
 * - パスは形を写してから曲線の範囲 (ハンドルの先は含めない)
 * - ブーリアンは結果の範囲。空か求められないときは子の外接矩形の和
 * - line は 2 点を囲む矩形 (水平・垂直の線は幅か高さが 0)、group は子の外接矩形の和
 * 子のない group と存在しないノードは null。
 */
export function getLocalBounds(doc: CanvasDocument, id: NodeId): Rect | null {
  const node = getNode(doc, id);
  if (!node) return null;
  return boundsIn(doc, node, IDENTITY, new Set([id]));
}

/** ノードの軸に平行な外接矩形をページ座標で返す (祖先の frame の回転も掛けてから囲む)。 */
export function getPageBounds(doc: CanvasDocument, id: NodeId): Rect | null {
  const node = getNode(doc, id);
  if (!node) return null;
  const space = coordinateMatrix(doc, id);
  if (isTranslation(space)) {
    // 回転した frame の中でなければ、親の座標系の矩形を平行移動する (第 1 段階と同じ値)
    const local = boundsIn(doc, node, IDENTITY, new Set([id]));
    return local && { ...local, x: local.x + space.e, y: local.y + space.f };
  }
  return boundsIn(doc, node, space, new Set([id]));
}

/** 複数ノードの外接矩形 (ページ座標)。1 つもなければ null。 */
export function getSelectionBounds(doc: CanvasDocument, ids: readonly NodeId[]): Rect | null {
  return unionRects(ids.map((id) => getPageBounds(doc, id)));
}

/** 親の子すべての外接矩形 (ページ座標)。 */
export function getChildrenBounds(doc: CanvasDocument, parent: ParentRef): Rect | null {
  return getSelectionBounds(doc, getChildren(doc, parent));
}

/**
 * 箱を持つノードの回転した箱の 4 隅 (ページ座標)。ノードの座標系の [左上, 右上, 右下, 左下] の順。
 * 箱を持たないノード (線・group・ブーリアン) と存在しないノードは null。
 */
export function getNodeCorners(doc: CanvasDocument, id: NodeId): Point[] | null {
  const node = getNode(doc, id);
  if (!node || !isBoxNode(node)) return null;
  const m = nodePageMatrix(doc, id);
  return rectCorners({ x: 0, y: 0, width: node.width, height: node.height }).map((p) =>
    mapPoint(m, p),
  );
}

// ---------------------------------------------------------------------------
// 矩形
// ---------------------------------------------------------------------------

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
