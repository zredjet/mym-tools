/**
 * パネルと変換の操作の結果が §3.5 と §8.3.2 の範囲に収まるかの確認。
 * `translateNodes` / `resizeNodes` / `moveNodes` / 回転・反転は上限を見ないので、確定の前に確かめる。
 *
 * - `geometryWithinLimits(doc, ids)`: 変えたノードと子孫 (ブーリアンの子を含む) の座標と大きさ。パスは点と
 *   ハンドルも見る (点の座標、ハンドルの相対値、点 + ハンドルの位置。どれも絶対値が `maxCoordinate` 以下)
 * - `pathPointsWithinLimits(doc, ids)`: 変えたパスの輪郭の数・点の数と、文書の全パスの点の合計 (§8.3.2)
 */
import { CANVAS_LIMITS } from "../model/limits";
import { getDescendantIds, getNode, topLevelIds } from "../model/tree";
import type { CanvasDocument, NodeId, PathNode } from "../model/types";

const coord = (v: number) => Number.isFinite(v) && Math.abs(v) <= CANVAS_LIMITS.maxCoordinate;
const size = (v: number) => Number.isFinite(v) && v >= 0 && v <= CANVAS_LIMITS.maxSize;

/** 自分と子孫の ID (frame・group・ブーリアンの子へ下りる)。 */
function selfAndDescendants(doc: CanvasDocument, id: NodeId): NodeId[] {
  return [id, ...getDescendantIds(doc, id)];
}

/**
 * パスの点とハンドルが座標の範囲に収まっているか。保存の検証 (§8.3.2) は点の `x` `y` と、`in` `out` の
 * 各成分 (点からの相対) を見る。ハンドルの先 (点 + ハンドル) も、画面と書き出しで座標として使うので確かめる。
 */
export function pathPointsInRange(node: PathNode): boolean {
  for (const sub of node.subpaths)
    for (const p of sub.points) {
      if (!coord(p.x) || !coord(p.y)) return false;
      for (const h of [p.in, p.out])
        if (h && (!coord(h.x) || !coord(h.y) || !coord(p.x + h.x) || !coord(p.y + h.y)))
          return false;
    }
  return true;
}

/**
 * 変えたノードとその子孫の座標と大きさが §3.5 の範囲に収まっているか。
 * group やブーリアンの位置を変えると子が範囲の外へ出ることがあるので、確定の前に確かめる。
 * パスは点とハンドルも確かめる (リサイズ・反転・回転でハンドルの先が外へ出ることがある)。
 */
export function geometryWithinLimits(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  for (const id of ids)
    for (const nodeId of selfAndDescendants(doc, id)) {
      const node = getNode(doc, nodeId);
      if (!node || node.type === "group" || node.type === "boolean") continue;
      if (node.type === "line") {
        if (![node.x1, node.y1, node.x2, node.y2].every(coord)) return false;
      } else if (!coord(node.x) || !coord(node.y) || !size(node.width) || !size(node.height))
        return false;
      if (node.type === "path" && !pathPointsInRange(node)) return false;
    }
  return true;
}

/** パスの点の数。 */
export function pathPointCount(node: PathNode): number {
  let count = 0;
  for (const sub of node.subpaths) count += sub.points.length;
  return count;
}

/**
 * 変えたパス (`ids` と子孫) の輪郭の数と点の数が上限以下で、文書の全パスの点の合計も上限以下か (§8.3.2)。
 */
export function pathPointsWithinLimits(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  const L = CANVAS_LIMITS;
  for (const id of ids)
    for (const nodeId of selfAndDescendants(doc, id)) {
      const node = getNode(doc, nodeId);
      if (node?.type !== "path") continue;
      if (node.subpaths.length === 0 || node.subpaths.length > L.maxSubpaths) return false;
      if (node.subpaths.some((sub) => sub.points.length === 0)) return false;
      if (pathPointCount(node) > L.maxPathPoints) return false;
    }
  let total = 0;
  for (const node of Object.values(doc.nodes))
    if (node.type === "path") {
      total += pathPointCount(node);
      if (total > L.maxTotalPathPoints) return false;
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
