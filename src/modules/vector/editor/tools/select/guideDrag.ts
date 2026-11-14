/**
 * ガイド線のドラッグ (§4.6)。ルーラーから引き出して作る、キャンバスの上でつかんで動かす、
 * ルーラーへ戻すと消える。どれもジェスチャー 1 回で履歴 1 件。
 *
 * ルーラーからの引き出しは `canvas/Rulers.tsx`、既存のガイド線は選択ツールがポインターを受けて、
 * ここの関数で文書を変える。
 */
import type { StoreApi } from "zustand";
import { RULER_SIZE } from "../../canvas/rulerTicks";
import { CANVAS_LIMITS } from "../../model/limits";
import { addGuide, moveGuide, removeGuide } from "../../model/transform";
import { getPage } from "../../model/tree";
import type { Guide, PageId, Point } from "../../model/types";
import type { EditorStore } from "../../state/types";

export interface GuideDrag {
  pageId: PageId;
  axis: Guide["axis"];
  /** 動かすガイド線の番号。新しいガイド線は末尾に足すので、開始時の本数 */
  index: number;
  /** ルーラーから引き出している (新しいガイド線) */
  isNew: boolean;
}

/** ガイド線の位置 (整数、§3.5 の範囲)。 */
export function guidePosition(value: number): number {
  const rounded = Math.round(value);
  const clamped = Math.max(
    -CANVAS_LIMITS.maxCoordinate,
    Math.min(CANVAS_LIMITS.maxCoordinate, rounded),
  );
  return clamped === 0 ? 0 : clamped;
}

/**
 * ポインター (キャンバスの左上を原点とする画面座標) がガイド線を消す場所 (ルーラーの上) にあるか。
 * 横のガイド線 (`y`) は上のルーラー、縦のガイド線 (`x`) は左のルーラー。
 * ルーラーを出していないときは、キャンバスの外へ出したら消す。
 */
export function isOverRuler(axis: Guide["axis"], screen: Point, rulers: boolean): boolean {
  const limit = rulers ? RULER_SIZE : 0;
  return axis === "y" ? screen.y < limit : screen.x < limit;
}

/** ルーラーから新しいガイド線を引き出し始める。上限 (`maxGuidesPerPage`) に達していれば null。 */
export function beginNewGuide(store: StoreApi<EditorStore>, axis: Guide["axis"]): GuideDrag | null {
  const state = store.getState();
  const page = getPage(state.doc, state.pageId);
  if (!page || page.guides.length >= CANVAS_LIMITS.maxGuidesPerPage) return null;
  state.beginGesture();
  return { pageId: page.id, axis, index: page.guides.length, isNew: true };
}

/** 既存のガイド線をつかむ。 */
export function beginMoveGuide(store: StoreApi<EditorStore>, index: number): GuideDrag | null {
  const state = store.getState();
  const page = getPage(state.doc, state.pageId);
  const guide = page?.guides[index];
  if (!page || !guide) return null;
  state.beginGesture();
  return { pageId: page.id, axis: guide.axis, index, isNew: false };
}

/**
 * ドラッグの途中。`page` はポインターのページ座標、`remove` はルーラーの上にあるか。
 * 新しいガイド線はルーラーの上にある間は作らない。既存のガイド線はルーラーの上で消える。
 */
export function updateGuideDrag(
  store: StoreApi<EditorStore>,
  drag: GuideDrag,
  page: Point,
  remove: boolean,
): void {
  const position = guidePosition(drag.axis === "x" ? page.x : page.y);
  store.getState().updateGesture((doc) => {
    if (drag.isNew) return remove ? doc : addGuide(doc, drag.pageId, { axis: drag.axis, position });
    return remove
      ? removeGuide(doc, drag.pageId, drag.index)
      : moveGuide(doc, drag.pageId, drag.index, position);
  });
}

/** ドラッグを終える。変わらなければ履歴に積まない。 */
export function endGuideDrag(
  store: StoreApi<EditorStore>,
  drag: GuideDrag,
  page: Point,
  remove: boolean,
): void {
  if (!store.getState().gestureActive) return;
  updateGuideDrag(store, drag, page, remove);
  store.getState().commitGesture();
}
