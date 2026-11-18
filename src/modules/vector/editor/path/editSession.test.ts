import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../model/create";
import { createEditorStore, editorStore } from "../state/store";
import { corner, pathEditDocument } from "../tools/pathEdit/testing";
import { withSubpaths } from "../tools/pathEdit/ops";
import { updateNode } from "../model/transform";
import type { PathNode } from "../model/types";
import {
  allPointRefs,
  beginPathEdit,
  clearSelectedPoints,
  getPathEditSnapshot,
  normalizeRefs,
  resetPathEditSession,
  selectedPoints,
  setPathEditHover,
  setPenDrawing,
  setSelectedPoints,
  subscribePathEdit,
  syncSelectedPoints,
} from "./editSession";

beforeEach(() => resetPathEditSession());

describe("選んでいる点", () => {
  it("編集中のパスと形が選んだ時点と同じときだけ有効", () => {
    const doc = pathEditDocument();
    setSelectedPoints(doc, "sq", [{ subpath: 0, index: 2 }]);
    expect(selectedPoints(doc, "sq")).toEqual([{ subpath: 0, index: 2 }]);
    expect(selectedPoints(doc, "rot")).toEqual([]);
    expect(selectedPoints(doc, null)).toEqual([]);
    // 形が変わった (Undo など) ら無効
    const moved = withSubpaths(doc, "sq", [
      { closed: true, points: [corner(0, 0), corner(10, 0), corner(10, 10)] },
    ])!;
    expect(selectedPoints(moved, "sq")).toEqual([]);
    // 形以外の変更 (線の色など) では残る
    const recolored = updateNode(doc, "sq", { opacity: 0.5 });
    expect(selectedPoints(recolored, "sq")).toEqual([{ subpath: 0, index: 2 }]);
    // 自分の操作の後に覚え直す。範囲の外の点は落とす
    syncSelectedPoints(moved, "sq");
    expect(selectedPoints(moved, "sq")).toEqual([{ subpath: 0, index: 2 }]);
    syncSelectedPoints(moved, "sq", [{ subpath: 0, index: 9 }]);
    expect(selectedPoints(moved, "sq")).toEqual([]);
  });

  it("並べ直し、重複と範囲の外を落とす", () => {
    const doc = pathEditDocument();
    const subpaths = (doc.nodes.sq as PathNode).subpaths;
    expect(
      normalizeRefs(subpaths, [
        { subpath: 0, index: 3 },
        { subpath: 0, index: 1 },
        { subpath: 0, index: 3 },
        { subpath: 1, index: 0 },
        { subpath: 0, index: -1 },
      ]),
    ).toEqual([
      { subpath: 0, index: 1 },
      { subpath: 0, index: 3 },
    ]);
    expect(allPointRefs(subpaths)).toHaveLength(4);
  });

  it("変わったときだけ購読者に知らせ、スナップショットは変わるまで同じ", () => {
    const doc = pathEditDocument();
    const listener = vi.fn();
    const unsubscribe = subscribePathEdit(listener);
    setSelectedPoints(doc, "sq", [{ subpath: 0, index: 0 }]);
    const snapshot = getPathEditSnapshot();
    setSelectedPoints(doc, "sq", [{ subpath: 0, index: 0 }]);
    setPathEditHover(null);
    expect(getPathEditSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    setPathEditHover({ kind: "point", ref: { subpath: 0, index: 1 } });
    setPathEditHover({ kind: "point", ref: { subpath: 0, index: 1 } });
    expect(listener).toHaveBeenCalledTimes(2);
    clearSelectedPoints();
    expect(getPathEditSnapshot().selected).toEqual([]);
    unsubscribe();
  });
});

describe("ツールの切替", () => {
  it("エディタの store でペンから別のツールになったら、描きかけを捨てる (キャンバスが無いときの load も)", () => {
    editorStore.getState().load(pathEditDocument());
    editorStore.getState().setTool("pen");
    setPenDrawing({
      pathId: null,
      parent: { kind: "page", id: editorStore.getState().pageId },
      subpath: 0,
      end: "end",
      origin: { x: 0, y: 0, out: null },
      created: "path",
      baseCount: 0,
      subpathCount: 0,
      commits: [],
      fromEdit: false,
      pointer: null,
    });
    editorStore.getState().load(createEmptyDocument());
    expect(getPathEditSnapshot().pen).toBeNull();
  });
});

describe("beginPathEdit", () => {
  it("前の点の選択とペンの描きかけを捨ててから点の編集に入る。パスでなければ何もしない", () => {
    const store = createEditorStore(pathEditDocument());
    setSelectedPoints(store.getState().doc, "sq", [{ subpath: 0, index: 0 }]);
    setPenDrawing({
      pathId: null,
      parent: { kind: "page", id: store.getState().pageId },
      subpath: 0,
      end: "end",
      origin: { x: 0, y: 0, out: null },
      created: "path",
      baseCount: 0,
      subpathCount: 0,
      commits: [],
      fromEdit: false,
      pointer: null,
    });
    expect(beginPathEdit(store, "r")).toBe(false);
    expect(beginPathEdit(store, "sq")).toBe(true);
    expect(store.getState()).toMatchObject({ toolId: "pathEdit", editingPathId: "sq" });
    expect(getPathEditSnapshot()).toMatchObject({ selected: [], pen: null });
  });
});
