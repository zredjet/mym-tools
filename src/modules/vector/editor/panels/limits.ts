/**
 * パネルの変更が §3.5 の座標と大きさの範囲に収まるかの確認。
 * `translateNodes` / `resizeNodes` / `moveNodes` は上限を見ないので、パネルが確定の前に確かめる。
 */
import { CANVAS_LIMITS } from "../model/limits";
import { getDescendantIds, getNode } from "../model/tree";
import type { CanvasDocument, NodeId } from "../model/types";

/**
 * 変えたノードとその子孫の座標と大きさが §3.5 の範囲に収まっているか。
 * group の位置を変えると子が範囲の外へ出ることがあるので、確定の前に確かめる。
 */
export function geometryWithinLimits(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  const { maxCoordinate, maxSize } = CANVAS_LIMITS;
  const coord = (v: number) => Number.isFinite(v) && Math.abs(v) <= maxCoordinate;
  const size = (v: number) => Number.isFinite(v) && v >= 0 && v <= maxSize;
  for (const id of ids)
    for (const nodeId of [id, ...getDescendantIds(doc, id)]) {
      const node = getNode(doc, nodeId);
      if (!node || node.type === "group") continue;
      if (node.type === "line") {
        if (![node.x1, node.y1, node.x2, node.y2].every(coord)) return false;
      } else if (!coord(node.x) || !coord(node.y) || !size(node.width) || !size(node.height))
        return false;
    }
  return true;
}
