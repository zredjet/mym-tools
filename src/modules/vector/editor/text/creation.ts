/**
 * テキストツールで作るテキスト (§4.7)。どこに、どの大きさで作るかを決める純関数と、ドラッグ中の矩形の状態。
 *
 * 回転した frame の中 (§4.11.2): 親の判定は点を frame の座標系に直してから箱で行い、作るテキストは frame の向きに
 * そろえる (押した点と離した点を frame の座標系に直して箱にする。`rotation` は 0)。
 * ブーリアンのスコープの中では、ブーリアンの外の最も近い親に作る (§4.15.1)。
 */
import {
  getPageBounds,
  isTranslation,
  nodePageMatrix,
  pageToLocal,
  parentMatrix,
  rectContainsPoint,
  rectFromPoints,
} from "../model/geometry";
import { applyToPoint, invert } from "../geometry/matrix";
import { CANVAS_LIMITS } from "../model/limits";
import { createText } from "../model/create";
import { createId } from "../model/ids";
import { getNode, getPage, isContainer, outsideBooleans, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, PageId, Point, TextNode } from "../model/types";

/**
 * 新しいテキストの親。スコープ (`scopeId`) があればその中 (ブーリアンならその外の最も近い親)。なければ、
 * 位置を含むページ直下の frame のうち最前面のもの (表示中でロックしていないもの。回転した frame は箱で判定する)。
 * それもなければページ直下。
 */
export function textParentAt(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId | null,
  point: Point,
): ParentRef {
  if (scopeId !== null) {
    const scope = getNode(doc, scopeId);
    if (scope && isContainer(scope)) return outsideBooleans(doc, { kind: "node", id: scope.id });
  }
  const page = getPage(doc, pageId);
  const children = page?.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const id = children[i] as NodeId;
    const node = getNode(doc, id);
    if (node?.type !== "frame" || !node.visible || node.locked) continue;
    if (node.rotation === 0) {
      const bounds = getPageBounds(doc, id);
      if (bounds && rectContainsPoint(bounds, point)) return { kind: "node", id };
      continue;
    }
    const back = invert(nodePageMatrix(doc, id));
    const q = back ? applyToPoint(back, point) : null;
    if (q && q.x >= 0 && q.x <= node.width && q.y >= 0 && q.y <= node.height)
      return { kind: "node", id };
  }
  return { kind: "page", id: pageId };
}

const clampCoordinate = (value: number) =>
  Math.min(CANVAS_LIMITS.maxCoordinate, Math.max(-CANVAS_LIMITS.maxCoordinate, Math.round(value)));

/**
 * テキストツールで作るノード。`end` が null ならクリック (`auto-width`、左上が押した位置)、
 * あればドラッグ (幅を決めた `auto-height`、左上がドラッグした矩形の左上)。座標は親の座標系に直し、整数にする。
 * 回転した親の中では、押した点と離した点を先に親の座標系に直してから矩形にする (§4.11.2)。
 * 大きさは編集の開始時に `fitTextNodes` が求める。
 */
export function newTextNode(
  doc: CanvasDocument,
  parent: ParentRef,
  start: Point,
  end: Point | null,
  fontFamily: string,
): TextNode {
  // 回転していない親は、ページ座標の矩形の左上を親の座標系へ直す (第 1 段階と同じ計算)
  const plain = isTranslation(parentMatrix(doc, parent));
  const a = plain ? start : pageToLocal(doc, parent, start);
  const b = end && (plain ? end : pageToLocal(doc, parent, end));
  const rect = b ? rectFromPoints(a, b) : null;
  const width = rect ? Math.min(CANVAS_LIMITS.maxSize, Math.round(rect.width)) : 0;
  const drag = rect !== null && width >= 1;
  const corner = drag && rect ? rect : a;
  const local = plain ? pageToLocal(doc, parent, corner) : corner;
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
