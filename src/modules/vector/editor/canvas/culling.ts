/**
 * 描く範囲 (純関数)。画面外のページ直下のノードは描かない (§4.3)。書き出しの範囲 (`export/plan.ts`) にも使う。
 *
 * 描く範囲は、外接矩形 (`model/geometry`) に線の太さの半分と影を足し、
 * 切り抜かない frame ははみ出した子も含め、fixed のテキストははみ出した行も含めたもの。
 *
 * 回転 (§4.11.1、§4.11.2): 箱を持つノードは、ノードの座標系で求めた範囲 (箱・線・影・テキストのはみ出し) を
 * 行列で写して囲む (影は形と一緒に回る、§4.3)。楕円とパスは形を写してから曲線の範囲を求める (回した円が
 * 大きくならない)。ブーリアンは結果の形 (求められないときは子の形を並べたもの) に自分の線と影を足す。
 * 回転した frame の中のノードは、祖先の frame の行列まで掛けてからページ座標で囲む。
 * 回転していない文書では、第 1 段階と同じ値になる (平行移動だけの座標系は、足し算で求める)。
 */
import { getBooleanEvaluation } from "../boolean/result";
import { applyToPoint, applyToVector, IDENTITY, type Matrix, multiply } from "../geometry/matrix";
import {
  coordinateMatrix,
  isTranslation,
  mapRectBounds,
  nodeTransform,
  rectsIntersect,
  unionRects,
} from "../model/geometry";
import type { Rect } from "../model/geometry";
import { getNode, getPage } from "../model/tree";
import type {
  CanvasDocument,
  CanvasNode,
  NodeId,
  PageId,
  Point,
  Shadow,
  Stroke,
  Subpath,
} from "../model/types";
import { pathBounds } from "../path/measure";
import { ellipseSubpaths } from "../path/shapes";
import { textInkExtent } from "../render/buildNodeSvg";
import type { TextMeasurer } from "../render/types";
import { layoutText } from "../text/layout";

/** マイターの上限 (SVG の既定。描画と同じ)。 */
const MITER_LIMIT = 4;

function expand(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  };
}

function withShadow(rect: Rect, shadow: Shadow | null): Rect {
  if (!shadow) return rect;
  const spread = shadow.blur * 1.5;
  const cast = expand({ ...rect, x: rect.x + shadow.x, y: rect.y + shadow.y }, spread);
  return unionRects([rect, cast]) ?? rect;
}

/** 影のずれを行列 `m` の向きに回して足す (影はノードの座標系の向き。§4.3)。 */
function withShadowIn(rect: Rect, shadow: Shadow | null, m: Matrix): Rect {
  if (!shadow) return rect;
  const offset = applyToVector(m, { x: shadow.x, y: shadow.y });
  return withShadow(rect, { ...shadow, x: offset.x, y: offset.y });
}

/**
 * 曲線の形の線が届く範囲 (描画の `strokeReach` と同じ規則)。マイターの角は太さの半分 × 4、
 * 四角の端は太さの半分 × √2、それ以外は太さの半分。
 */
function strokeReach(stroke: Stroke | null): number {
  if (stroke === null) return 0;
  const half = stroke.width / 2;
  if (stroke.join === "miter") return half * MITER_LIMIT;
  return stroke.cap === "square" ? half * Math.SQRT2 : half;
}

function curveBounds(subpaths: readonly Subpath[], m: Matrix): Rect | null {
  const b = pathBounds(subpaths, m);
  return b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : null;
}

/** 葉 (frame / group 以外) の親の座標系での描く範囲は、ノードのオブジェクトをキーにして使い回す (テキストの行分割が重いため)。 */
const leafCache = new WeakMap<CanvasNode, WeakMap<TextMeasurer, Rect | null>>();

/** 線の描く範囲 (端点は `m` で写す)。 */
function lineBounds(node: Extract<CanvasNode, { type: "line" }>, m: Matrix): Rect {
  const a: Point = isTranslation(m)
    ? { x: node.x1, y: node.y1 }
    : applyToPoint(m, { x: node.x1, y: node.y1 });
  const b: Point = isTranslation(m)
    ? { x: node.x2, y: node.y2 }
    : applyToPoint(m, { x: node.x2, y: node.y2 });
  const rect = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
  // 四角の端は、角が端点から太さの半分の √2 倍まで届く (斜めの線で縦横に最も広がる)
  const half = node.stroke.width / 2;
  return expand(rect, node.stroke.cap === "square" ? half * Math.SQRT2 : half);
}

/** 回転していない箱を持つノードの、親の座標系での描く範囲 (第 1 段階と同じ計算)。 */
function plainLeafBounds(node: CanvasNode, measurer: TextMeasurer): Rect | null {
  switch (node.type) {
    case "line":
      return lineBounds(node, IDENTITY);
    case "rect":
    case "ellipse": {
      const box = { x: node.x, y: node.y, width: node.width, height: node.height };
      return withShadow(expand(box, (node.stroke?.width ?? 0) / 2), node.shadow);
    }
    case "text":
      return withShadow(textInkExtent(node, layoutText(node, measurer)), node.shadow);
    case "image":
      return withShadow(
        { x: node.x, y: node.y, width: node.width, height: node.height },
        node.shadow,
      );
    case "svg":
      return { x: node.x, y: node.y, width: node.width, height: node.height };
    case "path":
      return pathRenderBounds(node, IDENTITY);
    default:
      return null;
  }
}

/** パスの描く範囲。`m` は対象の座標系 ← 親の座標系。 */
function pathRenderBounds(node: Extract<CanvasNode, { type: "path" }>, m: Matrix): Rect | null {
  const full = multiply(m, nodeTransform(node));
  const curve = curveBounds(node.subpaths, full);
  if (!curve) return null;
  return withShadowIn(expand(curve, strokeReach(node.stroke)), node.shadow, full);
}

/**
 * 箱を持つ葉の描く範囲を、`m` (対象の座標系 ← 親の座標系) で写した先で求める。
 * 回転していれば、ノードの座標系で求めた範囲を写して囲む。
 */
function rotatedLeafBounds(node: CanvasNode, m: Matrix, measurer: TextMeasurer): Rect | null {
  if (node.type === "line") return lineBounds(node, m);
  if (node.type === "path") return pathRenderBounds(node, m);
  if (node.type === "group" || node.type === "boolean" || node.type === "frame") return null;
  const full = multiply(m, nodeTransform(node));
  const box = { x: 0, y: 0, width: node.width, height: node.height };
  switch (node.type) {
    case "rect":
      return mapRectBounds(
        full,
        withShadow(expand(box, (node.stroke?.width ?? 0) / 2), node.shadow),
      );
    case "ellipse": {
      // 形を写してから曲線の範囲を求める (回した楕円の箱の隅を囲まない)
      const curve = curveBounds(ellipseSubpaths(node.width, node.height), full);
      if (!curve)
        return mapRectBounds(
          full,
          withShadow(expand(box, (node.stroke?.width ?? 0) / 2), node.shadow),
        );
      return withShadowIn(expand(curve, (node.stroke?.width ?? 0) / 2), node.shadow, full);
    }
    case "text": {
      const local = textInkExtent({ ...node, x: 0, y: 0 }, layoutText(node, measurer));
      return mapRectBounds(full, withShadow(local, node.shadow));
    }
    case "image":
      return mapRectBounds(full, withShadow(box, node.shadow));
    case "svg":
      return mapRectBounds(full, box);
  }
}

function leafBounds(node: CanvasNode, measurer: TextMeasurer): Rect | null {
  let byMeasurer = leafCache.get(node);
  const cached = byMeasurer?.get(measurer);
  if (cached !== undefined) return cached;
  const rotated = "rotation" in node && node.rotation !== 0;
  const result = rotated
    ? rotatedLeafBounds(node, IDENTITY, measurer)
    : plainLeafBounds(node, measurer);
  if (!byMeasurer) {
    byMeasurer = new WeakMap();
    leafCache.set(node, byMeasurer);
  }
  byMeasurer.set(measurer, result);
  return result;
}

/** ブーリアンの描く範囲。結果の形 (求められないときは子の形) に自分の線と影を足す。`m` は対象 ← 親の座標系。 */
function booleanBounds(
  doc: CanvasDocument,
  node: Extract<CanvasNode, { type: "boolean" }>,
  m: Matrix,
): Rect | null {
  const evaluation = getBooleanEvaluation(doc, node.id);
  if (!evaluation) return null;
  const subpaths = evaluation.result
    ? evaluation.result.subpaths
    : evaluation.operands.flatMap((operand) => operand.subpaths);
  const curve = curveBounds(subpaths, m);
  if (!curve) return null;
  return withShadowIn(expand(curve, strokeReach(node.stroke)), node.shadow, m);
}

/**
 * ノードの描く範囲を、`space` (対象の座標系 ← ノードの親の座標系) で写した先で求める。非表示なら null。
 * 平行移動だけの `space` は、親の座標系で求めてから動かす (第 1 段階と同じ値)。
 */
function extentIn(
  doc: CanvasDocument,
  node: CanvasNode,
  space: Matrix,
  measurer: TextMeasurer,
  ancestors: Set<NodeId>,
): Rect | null {
  if (!node.visible || ancestors.has(node.id)) return null;
  if (isTranslation(space) && (space.e !== 0 || space.f !== 0)) {
    const local = extentIn(doc, node, IDENTITY, measurer, ancestors);
    return local && { ...local, x: local.x + space.e, y: local.y + space.f };
  }
  const identity = isTranslation(space);
  const children = (ids: readonly NodeId[], childSpace: Matrix) => {
    ancestors.add(node.id);
    const rects = ids.map((child) => {
      const childNode = getNode(doc, child);
      return childNode ? extentIn(doc, childNode, childSpace, measurer, ancestors) : null;
    });
    ancestors.delete(node.id);
    return rects;
  };
  switch (node.type) {
    case "group":
      return unionRects(children(node.children, space));
    case "boolean":
      return booleanBounds(doc, node, space);
    case "frame": {
      const box = { x: node.x, y: node.y, width: node.width, height: node.height };
      if (identity && node.rotation === 0) {
        const own = withShadow(expand(box, (node.stroke?.width ?? 0) / 2), node.shadow);
        if (node.clip) return own;
        const inner = children(node.children, IDENTITY).map(
          (rect) => rect && { ...rect, x: rect.x + node.x, y: rect.y + node.y },
        );
        return unionRects([own, ...inner]);
      }
      const full = multiply(space, nodeTransform(node));
      const local = { x: 0, y: 0, width: node.width, height: node.height };
      const own = mapRectBounds(
        full,
        withShadow(expand(local, (node.stroke?.width ?? 0) / 2), node.shadow),
      );
      if (node.clip) return own;
      return unionRects([own, ...children(node.children, full)]);
    }
    default:
      return identity ? leafBounds(node, measurer) : rotatedLeafBounds(node, space, measurer);
  }
}

/** 親の座標系での描く範囲。非表示なら null。 */
export function localRenderBounds(
  doc: CanvasDocument,
  id: NodeId,
  measurer: TextMeasurer,
): Rect | null {
  const node = getNode(doc, id);
  if (!node) return null;
  return extentIn(doc, node, IDENTITY, measurer, new Set());
}

/** ページ座標での描く範囲 (祖先の frame の回転も掛けてから囲む)。非表示なら null。 */
export function renderBounds(doc: CanvasDocument, id: NodeId, measurer: TextMeasurer): Rect | null {
  const node = getNode(doc, id);
  if (!node) return null;
  const space = coordinateMatrix(doc, id);
  if (isTranslation(space)) {
    const local = extentIn(doc, node, IDENTITY, measurer, new Set());
    return local && { ...local, x: local.x + space.e, y: local.y + space.f };
  }
  return extentIn(doc, node, space, measurer, new Set());
}

/** ページ直下のノードのうち、`view` (ページ座標) に描く範囲が重なるもの。重なり順のまま返す。 */
export function visibleTopLevelIds(
  doc: CanvasDocument,
  pageId: PageId,
  view: Rect,
  measurer: TextMeasurer,
): NodeId[] {
  const page = getPage(doc, pageId);
  if (!page) return [];
  return page.children.filter((id) => {
    const bounds = renderBounds(doc, id, measurer);
    return bounds !== null && rectsIntersect(bounds, view);
  });
}

/** ページ直下の表示中のノードの描く範囲の和 (全体を表示に使う)。 */
export function pageContentBounds(
  doc: CanvasDocument,
  pageId: PageId,
  measurer: TextMeasurer,
): Rect | null {
  const page = getPage(doc, pageId);
  if (!page) return null;
  return unionRects(page.children.map((id) => renderBounds(doc, id, measurer)));
}
