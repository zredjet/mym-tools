/**
 * 移動の計算 (§4.6)。純関数。
 */
import { moveNodes } from "../../model/structure";
import { mapNodes, type NodePatch } from "../../model/transform";
import { getCoordinateFrame, getNode, topLevelIds, type ParentRef } from "../../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, PageId, Point } from "../../model/types";
import { geometryWithinLimits } from "../../panels/limits";

/** `-0` を `0` にする。 */
const round = (v: number) => {
  const r = Math.round(v);
  return r === 0 ? 0 : r;
};

/** 平行移動で座標が変わる葉 (group は座標系を作らないので子を動かす。frame の子は動かさない)。 */
function movedLeaves(doc: CanvasDocument, ids: readonly NodeId[]): NodeId[] {
  const result: NodeId[] = [];
  const seen = new Set<NodeId>();
  const visit = (id: NodeId) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = getNode(doc, id);
    if (!node) return;
    if (node.type === "group") node.children.forEach(visit);
    else result.push(id);
  };
  topLevelIds(doc, ids).forEach(visit);
  return result;
}

function translatePatch(node: CanvasNode, dx: number, dy: number): NodePatch | null {
  switch (node.type) {
    case "group":
      return null;
    case "line":
      return {
        x1: round(node.x1 + dx),
        y1: round(node.y1 + dy),
        x2: round(node.x2 + dx),
        y2: round(node.y2 + dy),
      };
    default:
      return { x: round(node.x + dx), y: round(node.y + dy) };
  }
}

/**
 * ノードを (dx, dy) 動かし、動かしたノードの座標を整数に丸める (§4.6「移動の結果は整数」)。
 * 祖先も選ばれているノードは祖先と一緒に動くので重ねて動かさない。
 */
export function translateRounded(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): CanvasDocument {
  return mapNodes(doc, movedLeaves(doc, ids), (node) => translatePatch(node, dx, dy));
}

/** 移動の Shift: 動いた量の大きい方の向きだけに固定する。 */
export function constrainAxis(delta: Point): Point {
  return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
}

/** ノードの座標系の frame の ID (ページ直下の座標系なら null)。 */
export function coordinateFrameId(doc: CanvasDocument, id: NodeId): NodeId | null {
  return getCoordinateFrame(doc, id)?.id ?? null;
}

/**
 * 動かしたノードを、ドロップ先 (`target`: frame の ID、null はページ直下) の子にする。
 * 今の座標系の frame がドロップ先と同じノードは動かさない (group の中のノードは group に残る)。
 * 見た目の位置は変えない (`moveNodes` が座標系の差を直す)。
 */
export function reparentToDropTarget(
  doc: CanvasDocument,
  pageId: PageId,
  ids: readonly NodeId[],
  target: NodeId | null,
): CanvasDocument {
  const moving = topLevelIds(doc, ids).filter((id) => coordinateFrameId(doc, id) !== target);
  if (moving.length === 0) return doc;
  const parent: ParentRef =
    target === null ? { kind: "page", id: pageId } : { kind: "node", id: target };
  return moveNodes(doc, moving, parent);
}

export interface MoveInput {
  /** 動かす前の文書 (Alt で複製したときは複製した後の文書) */
  doc: CanvasDocument;
  pageId: PageId;
  /** 動かすノード */
  ids: readonly NodeId[];
  /** 動かす量 (ページ座標、吸着の後) */
  delta: Point;
  /** ドロップ先の frame (null はページ直下)。undefined なら親を変えない */
  dropTarget?: NodeId | null | undefined;
}

/**
 * 移動の結果の文書。丸めて動かし、ドロップ先が別の frame ならその子にする。
 * 結果が §3.5 の範囲を超えるなら null (当てない)。
 */
export function moveDocument(input: MoveInput): CanvasDocument | null {
  let next = translateRounded(input.doc, input.ids, input.delta.x, input.delta.y);
  if (input.dropTarget !== undefined)
    next = reparentToDropTarget(next, input.pageId, input.ids, input.dropTarget);
  if (next !== input.doc && !geometryWithinLimits(next, topLevelIds(next, input.ids))) return null;
  return next;
}
