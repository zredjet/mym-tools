/**
 * 選択枠の形 (§8.5.3)。選択ツールの当たりと `SelectionOverlay` の描画が同じものを使う。
 *
 * - 1 個だけ選んだ、ページ上の角度が 0 でない箱を持つノード (回転したノードと、回転した frame の中のノード):
 *   回転した箱に沿った枠 (`oriented`)。ハンドルも箱の向き。リサイズは自分の向きで行う (§8.5.4)
 * - それ以外 (複数選択・group・ブーリアン・線・回転していないノード): 軸に平行な外接矩形 (`rect`)。第 1 段階と同じ
 */
import { applyToPoint } from "../../geometry/matrix";
import { type HandleBox, pageToHandleBox, rectHandleBox } from "../../hit/handles";
import {
  coordinateMatrix,
  getSelectionBounds,
  isBoxNode,
  isTranslation,
  nodePageMatrix,
  pageRotation,
  rectContainsPoint,
  type Rect,
} from "../../model/geometry";
import { getNode } from "../../model/tree";
import type { CanvasDocument, NodeId, Point } from "../../model/types";

export type SelectionBox =
  | { kind: "rect"; rect: Rect; box: HandleBox }
  | {
      kind: "oriented";
      /** 枠のノード */
      id: NodeId;
      /** ページ ← ノードの座標系 と、ノードの大きさ */
      box: HandleBox;
      /** ノードのページ上の角度 (度) */
      rotation: number;
    };

/**
 * 動かせる選択 (`transformableIds` の結果) の枠。`ids` が空か外接矩形が求められなければ null。
 */
export function selectionBoxOf(doc: CanvasDocument, ids: readonly NodeId[]): SelectionBox | null {
  if (ids.length === 1) {
    const id = ids[0] as NodeId;
    const node = getNode(doc, id);
    if (node && isBoxNode(node)) {
      const rotation = pageRotation(doc, id);
      if (rotation !== 0)
        return {
          kind: "oriented",
          id,
          box: { matrix: nodePageMatrix(doc, id), width: node.width, height: node.height },
          rotation,
        };
    }
  }
  const rect = getSelectionBounds(doc, ids);
  return rect ? { kind: "rect", rect, box: rectHandleBox(rect) } : null;
}

/** 点 (ページ座標) が枠の中か (辺の上を含む)。 */
export function selectionBoxContains(selection: SelectionBox, point: Point): boolean {
  if (selection.kind === "rect") return rectContainsPoint(selection.rect, point);
  const local = pageToHandleBox(selection.box, point);
  return (
    local !== null &&
    rectContainsPoint(
      { x: 0, y: 0, width: selection.box.width, height: selection.box.height },
      local,
    )
  );
}

/**
 * 線の端点のページ座標 ([始点, 終点])。回転した frame の中では frame の行列で写す
 * (平行移動だけなら足し算。第 1 段階と同じ値)。線でなければ null。
 */
export function lineEndsOnPage(doc: CanvasDocument, id: NodeId): [Point, Point] | null {
  const line = getNode(doc, id);
  if (line?.type !== "line") return null;
  const space = coordinateMatrix(doc, id);
  const p1 = { x: line.x1, y: line.y1 };
  const p2 = { x: line.x2, y: line.y2 };
  if (isTranslation(space))
    return [
      { x: space.e + p1.x, y: space.f + p1.y },
      { x: space.e + p2.x, y: space.f + p2.y },
    ];
  return [applyToPoint(space, p1), applyToPoint(space, p2)];
}
