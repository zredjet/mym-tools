/**
 * 整列と等間隔 (§5.3 の「整列」の節)。結果の位置は整数に丸める。
 */
import { DocDraft } from "./draft";
import { getPageBounds, getSelectionBounds, type Rect } from "./geometry";
import { translateInDraft } from "./transform";
import { getCoordinateFrame, topLevelIds } from "./tree";
import type { CanvasDocument, NodeId } from "./types";

export type AlignKind = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

/**
 * 整列の基準 (ページ座標)。2 個以上なら選択の外接矩形、frame の中の 1 個だけなら親の frame の矩形。
 * 整列できないとき (何も選んでいない、ページ直下の 1 個だけ) は null。
 */
export function getAlignTarget(doc: CanvasDocument, ids: readonly NodeId[]): Rect | null {
  const tops = topLevelIds(doc, ids);
  if (tops.length >= 2) return getSelectionBounds(doc, tops);
  const only = tops[0];
  if (only === undefined) return null;
  const frame = getCoordinateFrame(doc, only);
  return frame ? getPageBounds(doc, frame.id) : null;
}

/** 整列のボタンを有効にするか。 */
export function canAlign(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  return getAlignTarget(doc, ids) !== null;
}

/** 選んだノードを基準に揃える。group は子ごと動く。 */
export function alignNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  kind: AlignKind,
): CanvasDocument {
  const target = getAlignTarget(doc, ids);
  if (!target) return doc;
  const draft = new DocDraft(doc);
  for (const id of topLevelIds(doc, ids)) {
    const b = getPageBounds(doc, id);
    if (!b) continue;
    let dx = 0;
    let dy = 0;
    switch (kind) {
      case "left":
        dx = Math.round(target.x) - b.x;
        break;
      case "hcenter":
        dx = Math.round(target.x + target.width / 2 - b.width / 2) - b.x;
        break;
      case "right":
        dx = Math.round(target.x + target.width - b.width) - b.x;
        break;
      case "top":
        dy = Math.round(target.y) - b.y;
        break;
      case "vcenter":
        dy = Math.round(target.y + target.height / 2 - b.height / 2) - b.y;
        break;
      case "bottom":
        dy = Math.round(target.y + target.height - b.height) - b.y;
        break;
    }
    translateInDraft(draft, id, dx, dy);
  }
  return draft.finish();
}

/** 等間隔のボタンを有効にするか (3 個以上)。 */
export function canDistribute(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  return topLevelIds(doc, ids).length >= 3;
}

/**
 * 間隔をそろえる。左 (上) 端の順に並べ、両端のノードは動かさずに、
 * 間のノードを隣との隙間が等しくなるように動かす。3 個未満なら何もしない。
 */
export function distributeNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  axis: DistributeAxis,
): CanvasDocument {
  const horizontal = axis === "horizontal";
  const items = topLevelIds(doc, ids)
    .map((id) => ({ id, bounds: getPageBounds(doc, id) }))
    .filter((item): item is { id: NodeId; bounds: Rect } => item.bounds !== null)
    .map(({ id, bounds }) => ({
      id,
      start: horizontal ? bounds.x : bounds.y,
      size: horizontal ? bounds.width : bounds.height,
    }))
    .sort((a, b) => a.start - b.start || a.start + a.size - (b.start + b.size));
  const first = items[0];
  const last = items[items.length - 1];
  if (items.length < 3 || !first || !last) return doc;
  const sizes = items.reduce((sum, item) => sum + item.size, 0);
  const gap = (last.start + last.size - first.start - sizes) / (items.length - 1);
  const draft = new DocDraft(doc);
  let cursor = first.start + first.size + gap;
  for (const item of items.slice(1, -1)) {
    const delta = Math.round(cursor) - item.start;
    translateInDraft(draft, item.id, horizontal ? delta : 0, horizontal ? 0 : delta);
    cursor += item.size + gap;
  }
  return draft.finish();
}
