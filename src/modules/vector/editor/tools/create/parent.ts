/**
 * 新しく作るノードの親 (§4.4 / §4.6)。純関数。
 *
 * 1. スコープ (`scopeId`) があって押した点がその中なら、スコープの中。ただし押した点の下の
 *    最も前面の frame がスコープの中の frame なら、その frame
 * 2. そうでなければ、押した点の下の最も前面の frame (`hit/marquee.ts` の `dropFrames` / `dropTargetAt`)
 * 3. どちらでもなければページ直下
 *
 * 非表示・ロック中の frame (祖先が非表示・ロック中のものを含む) は親にしない。
 * frame の中かどうかは、祖先の frame が切り抜く分を除いた見えている範囲で決める。
 */
import { isInteractive, isTopLevelFrame } from "../../hit/hitTest";
import { dropFrames, dropTargetAt, type DropFrame } from "../../hit/marquee";
import { getPageBounds, rectContains, rectContainsPoint, type Rect } from "../../model/geometry";
import {
  getCoordinateFrame,
  getNode,
  getPageOf,
  isAncestorOf,
  type ParentRef,
} from "../../model/tree";
import type { CanvasDocument, NodeId, PageId, Point } from "../../model/types";

const NO_EXCLUDE: ReadonlySet<NodeId> = new Set();

/** 親になれる frame を集める (押したときに 1 回だけ。ドラッグのたびには集めない)。 */
export function creationFrames(doc: CanvasDocument, pageId: PageId): DropFrame[] {
  return dropFrames(doc, pageId, NO_EXCLUDE);
}

/**
 * スコープが点 (または矩形) を含むか。frame は見えている範囲、group は外接矩形 (§4.5 と同じ扱い)。
 * `inside(rect)` は、スコープの範囲 `rect` の中かを返す。
 */
function scopeContains(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId,
  inside: (rect: Rect) => boolean,
  frames: readonly DropFrame[],
): boolean {
  const scope = getNode(doc, scopeId);
  if (!scope || getPageOf(doc, scopeId)?.id !== pageId || !isInteractive(doc, scopeId))
    return false;
  if (scope.type === "frame") {
    const visible = frames.find((frame) => frame.id === scopeId);
    return visible !== undefined && inside(visible.rect);
  }
  if (scope.type !== "group") return false;
  const bounds = getPageBounds(doc, scopeId);
  if (!bounds || !inside(bounds)) return false;
  // group の座標系の frame が切り抜いて見えない所は、スコープの外とする
  const frame = getCoordinateFrame(doc, scopeId);
  if (!frame) return true;
  const visible = frames.find((item) => item.id === frame.id);
  return visible !== undefined && inside(visible.rect);
}

/** 押した点 (ページ座標) に作るノードの親。 */
export function creationParent(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId | null,
  point: Point,
  frames: readonly DropFrame[] = creationFrames(doc, pageId),
): ParentRef {
  const under = dropTargetAt(frames, point);
  const inside = (rect: Rect) => rectContainsPoint(rect, point);
  if (scopeId !== null && scopeContains(doc, pageId, scopeId, inside, frames)) {
    if (under !== null && (under === scopeId || isAncestorOf(doc, scopeId, under)))
      return { kind: "node", id: under };
    return { kind: "node", id: scopeId };
  }
  return under === null ? { kind: "page", id: pageId } : { kind: "node", id: under };
}

/**
 * 矩形 (ページ座標) を丸ごと入れられる親。表示範囲の中央に画像を置くときに使う
 * (点の下の frame に入れると、frame より大きな画像が切り抜かれて見えるため)。
 * スコープが矩形を含むならスコープの中、そうでなければ矩形を丸ごと含む最も前面の frame、
 * どちらでもなければページ直下。
 */
export function containingParent(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId | null,
  rect: Rect,
  frames: readonly DropFrame[] = creationFrames(doc, pageId),
): ParentRef {
  const inside = (outer: Rect) => rectContains(outer, rect);
  const fits = frames.filter((frame) => inside(frame.rect));
  const frontmost = (candidates: readonly DropFrame[]) =>
    candidates.length === 0 ? null : (candidates[candidates.length - 1] as DropFrame).id;
  if (scopeId !== null && scopeContains(doc, pageId, scopeId, inside, frames)) {
    const within = frontmost(
      fits.filter((frame) => frame.id === scopeId || isAncestorOf(doc, scopeId, frame.id)),
    );
    return { kind: "node", id: within ?? scopeId };
  }
  const front = frontmost(fits);
  return front === null ? { kind: "page", id: pageId } : { kind: "node", id: front };
}

/**
 * 作ったノードを選んだときのスコープ。ページ直下とページ直下の frame の子はスコープなし
 * (ページ直下の frame の子は直接選べる)。group と入れ子の frame の子は、その親の中。
 */
export function scopeForParent(doc: CanvasDocument, parent: ParentRef): NodeId | null {
  if (parent.kind === "page" || isTopLevelFrame(doc, parent.id)) return null;
  return parent.id;
}

/** スナップの候補を集める frame (親の座標系の frame)。 */
export function parentCoordinateFrame(doc: CanvasDocument, parent: ParentRef): NodeId | null {
  if (parent.kind === "page") return null;
  const node = getNode(doc, parent.id);
  if (node?.type === "frame") return node.id;
  return getCoordinateFrame(doc, parent.id)?.id ?? null;
}
