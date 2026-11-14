import { describe, expect, it } from "vitest";
import { sampleDocument } from "../model/testing";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { createFrameLabelsSelector, createVisibleTopLevelIdsSelector } from "./selectors";

describe("キャンバスの selector", () => {
  const store = createEditorStore(sampleDocument());
  const measurer = fixedWidthMeasurer();

  it("別の大きさで呼ぶ購読者が交互に呼んでも、それぞれ同じ配列を返す", () => {
    const small = createFrameLabelsSelector(measurer);
    const large = createFrameLabelsSelector(measurer);
    const state = store.getState();
    const a1 = small(state, { width: 200, height: 200 });
    const b1 = large(state, { width: 1000, height: 800 });
    const a2 = small(state, { width: 200, height: 200 });
    const b2 = large(state, { width: 1000, height: 800 });
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(b1.map((label) => label.id)).toEqual(["f"]);
  });

  it("表示位置か文書が変わったら求め直す", () => {
    const select = createVisibleTopLevelIdsSelector(measurer);
    const size = { width: 1000, height: 800 };
    const first = select(store.getState(), size);
    expect(first).toEqual(["f", "r0"]);
    expect(select(store.getState(), size)).toBe(first);
    store.getState().setViewport({ x: 5000, y: 0, zoom: 1 });
    expect(select(store.getState(), size)).toEqual([]);
  });
});
