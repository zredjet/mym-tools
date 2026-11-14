/**
 * テキストツールで作るテキスト (§4.7)。どこに、どの大きさで作るかを決める純関数と、ドラッグ中の矩形の状態。
 */
import { getPageBounds, pageToLocal, rectContainsPoint, rectFromPoints } from "../model/geometry";
import { CANVAS_LIMITS } from "../model/limits";
import { createText } from "../model/create";
import { createId } from "../model/ids";
import { getNode, getPage, isContainer, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, PageId, Point, TextNode } from "../model/types";

/**
 * 新しいテキストの親。スコープ (`scopeId`) があればその中。なければ、位置を含むページ直下の frame のうち
 * 最前面のもの (表示中でロックしていないもの)。それもなければページ直下。
 */
export function textParentAt(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId | null,
  point: Point,
): ParentRef {
  if (scopeId !== null) {
    const scope = getNode(doc, scopeId);
    if (scope && isContainer(scope)) return { kind: "node", id: scope.id };
  }
  const page = getPage(doc, pageId);
  const children = page?.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const id = children[i] as NodeId;
    const node = getNode(doc, id);
    if (node?.type !== "frame" || !node.visible || node.locked) continue;
    const bounds = getPageBounds(doc, id);
    if (bounds && rectContainsPoint(bounds, point)) return { kind: "node", id };
  }
  return { kind: "page", id: pageId };
}

const clampCoordinate = (value: number) =>
  Math.min(CANVAS_LIMITS.maxCoordinate, Math.max(-CANVAS_LIMITS.maxCoordinate, Math.round(value)));

/**
 * テキストツールで作るノード。`end` が null ならクリック (`auto-width`、左上が押した位置)、
 * あればドラッグ (幅を決めた `auto-height`、左上がドラッグした矩形の左上)。座標は親の座標系に直し、整数にする。
 * 大きさは編集の開始時に `fitTextNodes` が求める。
 */
export function newTextNode(
  doc: CanvasDocument,
  parent: ParentRef,
  start: Point,
  end: Point | null,
  fontFamily: string,
): TextNode {
  const rect = end ? rectFromPoints(start, end) : null;
  const width = rect ? Math.min(CANVAS_LIMITS.maxSize, Math.round(rect.width)) : 0;
  const drag = rect !== null && width >= 1;
  const local = pageToLocal(doc, parent, drag && rect ? rect : start);
  return createText({
    id: createId(doc.nodes),
    x: clampCoordinate(local.x),
    y: clampCoordinate(local.y),
    width: drag ? width : 0,
    height: 0,
    text: "",
    fontFamily,
    sizing: drag ? "auto-height" : "auto-width",
  });
}

// ---------------------------------------------------------------------------
// ドラッグ中の矩形 (ツールの重ね描きが読む)
// ---------------------------------------------------------------------------

export interface TextToolDrag {
  /** ページ座標 */
  start: Point;
  current: Point;
  /** 押した位置 (画面座標)。クリックかドラッグかの判定に使う */
  startScreen: Point;
  /** しきい値を超えて動かしたか */
  dragged: boolean;
}

let drag: TextToolDrag | null = null;
const listeners = new Set<() => void>();

export function getTextToolDrag(): TextToolDrag | null {
  return drag;
}

export function setTextToolDrag(next: TextToolDrag | null): void {
  if (next === drag) return;
  drag = next;
  for (const listener of listeners) listener();
}

export function subscribeTextToolDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
