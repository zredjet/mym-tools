/**
 * 描く範囲 (純関数)。画面外のページ直下のノードは描かない (§4.3)。
 *
 * 描く範囲は、外接矩形 (`model/geometry`) に線の太さの半分と影を足し、
 * 切り抜かない frame ははみ出した子も含め、fixed のテキストははみ出した行も含めたもの。
 */
import { nodeOrigin } from "../model/geometry";
import type { Rect } from "../model/geometry";
import { rectsIntersect, unionRects } from "../model/geometry";
import { getNode, getPage } from "../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, PageId, Shadow } from "../model/types";
import type { TextMeasurer } from "../render/types";
import { layoutText } from "../text/layout";
import { textInkExtent } from "../render/buildNodeSvg";

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

/** 葉 (frame / group 以外) の描く範囲は、ノードのオブジェクトをキーにして使い回す (テキストの行分割が重いため)。 */
const leafCache = new WeakMap<CanvasNode, WeakMap<TextMeasurer, Rect | null>>();

function leafBounds(node: CanvasNode, measurer: TextMeasurer): Rect | null {
  let byMeasurer = leafCache.get(node);
  const cached = byMeasurer?.get(measurer);
  if (cached !== undefined) return cached;
  let result: Rect | null;
  switch (node.type) {
    case "line": {
      const rect = {
        x: Math.min(node.x1, node.x2),
        y: Math.min(node.y1, node.y2),
        width: Math.abs(node.x2 - node.x1),
        height: Math.abs(node.y2 - node.y1),
      };
      result = expand(rect, node.stroke.width / 2);
      break;
    }
    case "rect":
    case "ellipse": {
      const box = { x: node.x, y: node.y, width: node.width, height: node.height };
      result = withShadow(expand(box, (node.stroke?.width ?? 0) / 2), node.shadow);
      break;
    }
    case "text":
      result = withShadow(textInkExtent(node, layoutText(node, measurer)), node.shadow);
      break;
    case "image":
      result = withShadow(
        { x: node.x, y: node.y, width: node.width, height: node.height },
        node.shadow,
      );
      break;
    case "svg":
      result = { x: node.x, y: node.y, width: node.width, height: node.height };
      break;
    default:
      return null;
  }
  if (!byMeasurer) {
    byMeasurer = new WeakMap();
    leafCache.set(node, byMeasurer);
  }
  byMeasurer.set(measurer, result);
  return result;
}

/** 親の座標系での描く範囲。非表示なら null。 */
export function localRenderBounds(
  doc: CanvasDocument,
  id: NodeId,
  measurer: TextMeasurer,
  ancestors: Set<NodeId> = new Set(),
): Rect | null {
  const node = getNode(doc, id);
  if (!node || !node.visible || ancestors.has(id)) return null;
  if (node.type === "group") {
    ancestors.add(id);
    const result = unionRects(
      node.children.map((child) => localRenderBounds(doc, child, measurer, ancestors)),
    );
    ancestors.delete(id);
    return result;
  }
  if (node.type !== "frame") return leafBounds(node, measurer);
  const box = { x: node.x, y: node.y, width: node.width, height: node.height };
  const own = withShadow(expand(box, (node.stroke?.width ?? 0) / 2), node.shadow);
  if (node.clip) return own;
  ancestors.add(id);
  const children = node.children.map((child) => {
    const rect = localRenderBounds(doc, child, measurer, ancestors);
    return rect && { ...rect, x: rect.x + node.x, y: rect.y + node.y };
  });
  ancestors.delete(id);
  return unionRects([own, ...children]);
}

/** ページ座標での描く範囲。非表示なら null。 */
export function renderBounds(doc: CanvasDocument, id: NodeId, measurer: TextMeasurer): Rect | null {
  const local = localRenderBounds(doc, id, measurer);
  if (!local) return null;
  const origin = nodeOrigin(doc, id);
  return { ...local, x: local.x + origin.x, y: local.y + origin.y };
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
