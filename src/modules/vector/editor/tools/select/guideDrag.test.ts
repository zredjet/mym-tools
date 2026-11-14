import { describe, expect, it } from "vitest";
import { CANVAS_LIMITS } from "../../model/limits";
import { sampleDocument } from "../../model/testing";
import { updatePage } from "../../model/transform";
import { createEditorStore } from "../../state/store";
import {
  beginMoveGuide,
  beginNewGuide,
  endGuideDrag,
  guidePosition,
  isOverRuler,
  updateGuideDrag,
} from "./guideDrag";

const guides = (store: ReturnType<typeof createEditorStore>) =>
  store.getState().doc.pages[0]!.guides;

describe("ガイド線のドラッグ", () => {
  it("ルーラーから引き出して作る。途中はルーラーの上なら作らない。履歴 1 件", () => {
    const store = createEditorStore(sampleDocument());
    const drag = beginNewGuide(store, "y")!;
    updateGuideDrag(store, drag, { x: 0, y: 5 }, true);
    expect(guides(store)).toEqual([]);
    updateGuideDrag(store, drag, { x: 0, y: 80.4 }, false);
    expect(guides(store)).toEqual([{ axis: "y", position: 80 }]);
    endGuideDrag(store, drag, { x: 0, y: 120.6 }, false);
    expect(guides(store)).toEqual([{ axis: "y", position: 121 }]);
    expect(store.getState().revision).toBe(1);
    store.getState().undo();
    expect(guides(store)).toEqual([]);
  });

  it("ルーラーの上で離すと作らない (履歴も増えない)", () => {
    const store = createEditorStore(sampleDocument());
    const drag = beginNewGuide(store, "x")!;
    updateGuideDrag(store, drag, { x: 50, y: 0 }, false);
    endGuideDrag(store, drag, { x: 5, y: 0 }, true);
    expect(guides(store)).toEqual([]);
    expect(store.getState()).toMatchObject({ revision: 0, gestureActive: false });
  });

  it("既存のガイド線を動かす・ルーラーへ戻して消す", () => {
    const doc = updatePage(sampleDocument(), "p1", {
      guides: [
        { axis: "x", position: 10 },
        { axis: "y", position: 20 },
      ],
    });
    const store = createEditorStore(doc);
    const move = beginMoveGuide(store, 1)!;
    endGuideDrag(store, move, { x: 0, y: 44 }, false);
    expect(guides(store)).toEqual([
      { axis: "x", position: 10 },
      { axis: "y", position: 44 },
    ]);
    const remove = beginMoveGuide(store, 0)!;
    endGuideDrag(store, remove, { x: 0, y: 0 }, true);
    expect(guides(store)).toEqual([{ axis: "y", position: 44 }]);
    expect(store.getState().revision).toBe(2);
  });

  it("上限の本数に達していれば作らない", () => {
    const full = Array.from({ length: CANVAS_LIMITS.maxGuidesPerPage }, (_, i) => ({
      axis: "x" as const,
      position: i,
    }));
    const store = createEditorStore(updatePage(sampleDocument(), "p1", { guides: full }));
    expect(beginNewGuide(store, "x")).toBeNull();
    expect(store.getState().gestureActive).toBe(false);
  });

  it("位置は整数で、§3.5 の範囲に収める", () => {
    expect(guidePosition(10.6)).toBe(11);
    expect(guidePosition(-0.2)).toBe(0);
    expect(guidePosition(5_000_000)).toBe(CANVAS_LIMITS.maxCoordinate);
  });

  it("ルーラーの上か (横のガイド線は上、縦のガイド線は左)", () => {
    expect(isOverRuler("y", { x: 300, y: 10 }, true)).toBe(true);
    expect(isOverRuler("y", { x: 10, y: 300 }, true)).toBe(false);
    expect(isOverRuler("x", { x: 10, y: 300 }, true)).toBe(true);
    // ルーラーを出していなければ、キャンバスの外
    expect(isOverRuler("x", { x: 10, y: 300 }, false)).toBe(false);
    expect(isOverRuler("x", { x: -1, y: 300 }, false)).toBe(true);
  });
});
