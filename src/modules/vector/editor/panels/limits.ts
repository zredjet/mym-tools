/**
 * パネルの変更が §3.5 の座標と大きさの範囲に収まるかの確認。
 * `translateNodes` / `resizeNodes` / `moveNodes` は上限を見ないので、パネルが確定の前に確かめる。
 */
import { CANVAS_LIMITS } from "../model/limits";
import { getNode, topLevelIds } from "../model/tree";
import type { CanvasDocument, NodeId } from "../model/types";

/**
 * 自分と子孫の ID。frame・group に加えてブーリアンの子へも下りる (`tree.ts` の `getDescendantIds` は
 * ブーリアンの子へ下りないため)。壊れた文書の循環でも止まる。
 */
function selfAndDescendants(doc: CanvasDocument, id: NodeId): NodeId[] {
  const result: NodeId[] = [];
  const seen = new Set<NodeId>();
  const visit = (nodeId: NodeId) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    result.push(nodeId);
    const node = getNode(doc, nodeId);
    if (node && (node.type === "frame" || node.type === "group" || node.type === "boolean"))
      node.children.forEach(visit);
  };
  visit(id);
  return result;
}

/**
 * 変えたノードとその子孫の座標と大きさが §3.5 の範囲に収まっているか。
 * group やブーリアンの位置を変えると子が範囲の外へ出ることがあるので、確定の前に確かめる。
 */
export function geometryWithinLimits(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  const { maxCoordinate, maxSize } = CANVAS_LIMITS;
  const coord = (v: number) => Number.isFinite(v) && Math.abs(v) <= maxCoordinate;
  const size = (v: number) => Number.isFinite(v) && v >= 0 && v <= maxSize;
  for (const id of ids)
    for (const nodeId of selfAndDescendants(doc, id)) {
      const node = getNode(doc, nodeId);
      if (!node || node.type === "group" || node.type === "boolean") continue;
      if (node.type === "line") {
        if (![node.x1, node.y1, node.x2, node.y2].every(coord)) return false;
      } else if (!coord(node.x) || !coord(node.y) || !size(node.width) || !size(node.height))
        return false;
    }
  return true;
}

/**
 * 選択への変更の結果が §3.5 の範囲を超えるなら、元の文書を返す。親の座標系が違うノードを
 * 整列すると、frame の中での座標が上限を超えることがある (§5.3)。
 */
export function withinLimitsOrSame(
  doc: CanvasDocument,
  selection: readonly NodeId[],
  next: CanvasDocument,
): CanvasDocument {
  return next !== doc && !geometryWithinLimits(next, topLevelIds(doc, selection)) ? doc : next;
}
