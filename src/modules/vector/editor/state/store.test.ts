import { describe, expect, it } from "vitest";
import { createText } from "../model/create";
import { deleteNodes, insertNode } from "../model/structure";
import { deepFreeze, sampleDocument } from "../model/testing";
import { resizeNodes, translateNodes, updateNode } from "../model/transform";
import { HISTORY_LIMIT } from "./history";
import { createEditorStore, editorStore } from "./store";
import { MAX_ZOOM, MIN_ZOOM } from "./types";

const setup = () => {
  const store = createEditorStore();
  store.getState().load(deepFreeze(sampleDocument()));
  return store;
};
const move = (dx: number) => (doc: Parameters<typeof translateNodes>[0]) =>
  translateNodes(doc, ["r0"], dx, 0);

describe("editorStore", () => {
  it("モジュール内の store は空の文書で始まる", () => {
    const state = editorStore.getState();
    expect(state.doc.pages).toHaveLength(1);
    expect(state.pageId).toBe(state.doc.pages[0]!.id);
    expect(state.revision).toBe(0);
  });

  it("load は履歴・選択・スコープを捨て、revision を 0 に戻す", () => {
    const store = setup();
    const s = store.getState();
    s.setSelection(["r1"]);
    s.setScope("f");
    s.apply(move(5));
    s.setViewport({ x: 10, y: 20, zoom: 2 });
    store.getState().load(sampleDocument());
    const after = store.getState();
    expect(after).toMatchObject({
      pageId: "p1",
      selection: [],
      scopeId: null,
      hoveredId: null,
      editingTextId: null,
      revision: 0,
      canUndo: false,
      canRedo: false,
      gestureActive: false,
    });
    // 表示位置は残す
    expect(after.viewport).toEqual({ x: 10, y: 20, zoom: 2 });
  });

  it("apply は履歴に 1 件積み、同じ文書なら何もしない", () => {
    const store = setup();
    const before = store.getState().doc;
    store.getState().apply((doc) => doc);
    expect(store.getState()).toMatchObject({ revision: 0, canUndo: false });
    store.getState().apply(move(5));
    expect(store.getState()).toMatchObject({ revision: 1, canUndo: true, canRedo: false });
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: 5 });
    expect(store.getState().doc.nodes["r1"]).toBe(before.nodes["r1"]);
  });

  it("Undo / Redo は選択も戻し、スコープと本文の編集を解除し、revision を増やす", () => {
    const store = setup();
    const original = store.getState().doc;
    store.getState().setSelection(["r0"]);
    store.getState().apply(move(5));
    store.getState().setSelection(["r1"]);
    store.getState().setScope("f");
    const moved = store.getState().doc;

    store.getState().undo();
    expect(store.getState()).toMatchObject({
      selection: ["r0"],
      scopeId: null,
      revision: 2,
      canUndo: false,
      canRedo: true,
    });
    expect(store.getState().doc).toBe(original);

    store.getState().redo();
    expect(store.getState().doc).toBe(moved);
    expect(store.getState()).toMatchObject({ selection: ["r1"], revision: 3, canRedo: false });

    store.getState().redo(); // 進めるものがなければ何もしない
    expect(store.getState().revision).toBe(3);
  });

  it("新しい変更で Redo の履歴を捨てる", () => {
    const store = setup();
    store.getState().apply(move(1));
    store.getState().undo();
    store.getState().apply(move(2));
    expect(store.getState().canRedo).toBe(false);
  });

  it("履歴は 100 件まで", () => {
    const store = setup();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) store.getState().apply(move(1));
    let undone = 0;
    while (store.getState().canUndo) {
      store.getState().undo();
      undone++;
    }
    expect(undone).toBe(HISTORY_LIMIT);
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: 5 });
  });

  it("ジェスチャーは開始時点の文書から作り直し、確定で 1 件だけ積む", () => {
    const store = setup();
    const original = store.getState().doc;
    store.getState().beginGesture();
    expect(store.getState().gestureActive).toBe(true);
    store.getState().updateGesture(move(3));
    store.getState().updateGesture(move(7));
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: 7 });
    expect(store.getState().revision).toBe(0);
    store.getState().commitGesture();
    expect(store.getState()).toMatchObject({ gestureActive: false, revision: 1, canUndo: true });
    store.getState().undo();
    expect(store.getState().doc).toBe(original);
  });

  it("ジェスチャーの取消で文書と選択を開始時点へ戻す", () => {
    const store = setup();
    const original = store.getState().doc;
    store.getState().setSelection(["r0"]);
    store.getState().beginGesture();
    store.getState().updateGesture(move(3));
    store.getState().setSelection(["r1"]);
    store.getState().cancelGesture();
    expect(store.getState().doc).toBe(original);
    expect(store.getState()).toMatchObject({
      selection: ["r0"],
      gestureActive: false,
      revision: 0,
      canUndo: false,
    });
  });

  it("何も変えずに確定したジェスチャーは履歴に積まない", () => {
    const store = setup();
    store.getState().beginGesture();
    store.getState().commitGesture();
    expect(store.getState()).toMatchObject({ revision: 0, canUndo: false, gestureActive: false });
  });

  it("ジェスチャー中の Undo はジェスチャーを取り消すだけ", () => {
    const store = setup();
    store.getState().apply(move(1));
    store.getState().beginGesture();
    store.getState().updateGesture(move(5));
    store.getState().undo();
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: 1 });
    expect(store.getState()).toMatchObject({ gestureActive: false, canUndo: true, revision: 1 });
  });

  it("ジェスチャー中の apply は先にジェスチャーを確定する", () => {
    const store = setup();
    store.getState().beginGesture();
    store.getState().updateGesture(move(5));
    store.getState().apply((doc) => updateNode(doc, "r1", { name: "x" }));
    expect(store.getState()).toMatchObject({ gestureActive: false, revision: 2 });
    store.getState().undo();
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: 5 });
  });

  it("消えたノードを選択・ホバー・スコープ・編集中から外す", () => {
    const store = setup();
    const s = store.getState();
    s.setSelection(["r2", "r0"]);
    s.setHovered("r2");
    s.setScope("grp");
    store
      .getState()
      .apply((doc) =>
        insertNode(doc, createText({ id: "t", text: "abc" }), { kind: "node", id: "grp" }),
      );
    store.getState().startTextEdit("t");
    expect(store.getState().editingTextId).toBe("t");
    store.getState().setSelection(["r2", "r0"]);
    store.getState().apply((doc) => deleteNodes(doc, ["grp"]));
    expect(store.getState()).toMatchObject({
      selection: ["r0"],
      hoveredId: null,
      scopeId: null,
      editingTextId: null,
    });
    // Undo で文書が戻ると、選択も戻る
    store.getState().undo();
    expect(store.getState().selection).toEqual(["r2", "r0"]);
  });

  it("setSelection は存在しない ID と重複を除き、同じ内容なら配列を変えない", () => {
    const store = setup();
    store.getState().setSelection(["r1", "nope", "r1", "r0"]);
    const selection = store.getState().selection;
    expect(selection).toEqual(["r1", "r0"]);
    store.getState().setSelection(["r1", "r0"]);
    expect(store.getState().selection).toBe(selection);
  });

  it("スコープは frame / group だけ、本文の編集はテキストだけ", () => {
    const store = setup();
    store.getState().setScope("r1");
    expect(store.getState().scopeId).toBeNull();
    store.getState().setScope("grp");
    expect(store.getState().scopeId).toBe("grp");
    store.getState().startTextEdit("r1");
    expect(store.getState().editingTextId).toBeNull();
    store.getState().endTextEdit();
    expect(store.getState().editingTextId).toBeNull();
  });

  it("倍率を範囲に収め、表示の設定を部分更新する", () => {
    const store = setup();
    store.getState().setViewport({ x: 0, y: 0, zoom: 1000 });
    expect(store.getState().viewport.zoom).toBe(MAX_ZOOM);
    store.getState().setViewport({ x: 0, y: 0, zoom: 0 });
    expect(store.getState().viewport.zoom).toBe(MIN_ZOOM);
    const view = store.getState().view;
    store.getState().setView({ grid: false });
    expect(store.getState().view).toBe(view);
    store.getState().setView({ grid: true, gridSize: 16 });
    expect(store.getState().view).toMatchObject({ grid: true, gridSize: 16, rulers: true });
    store.getState().setTool("rect");
    expect(store.getState().toolId).toBe("rect");
  });
});

describe("ジェスチャーと履歴の境界 (レビューの指摘)", () => {
  it("beginGesture を 2 回呼ぶと、1 回目を確定して 2 回目を始める", () => {
    const store = setup();
    store.getState().beginGesture();
    store.getState().updateGesture(move(3));
    store.getState().beginGesture();
    // 2 回目の recipe には 1 回目を確定した文書が渡る
    store.getState().updateGesture((doc) => translateNodes(doc, ["r0"], 2, 0));
    store.getState().commitGesture();
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: 5 });
    expect(store.getState().revision).toBe(2);
    store.getState().undo();
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: 3 });
  });

  it("ジェスチャー中の load はジェスチャーを捨てる", () => {
    const store = setup();
    store.getState().beginGesture();
    store.getState().updateGesture(move(3));
    const next = sampleDocument();
    store.getState().load(next);
    expect(store.getState()).toMatchObject({ doc: next, gestureActive: false, revision: 0 });
    store.getState().updateGesture(move(9));
    store.getState().commitGesture();
    expect(store.getState()).toMatchObject({ doc: next, revision: 0, canUndo: false });
  });

  it("Redo の履歴も 100 件まで", () => {
    const store = setup();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) store.getState().apply(move(1));
    while (store.getState().canUndo) store.getState().undo();
    let redone = 0;
    while (store.getState().canRedo) {
      store.getState().redo();
      redone++;
    }
    expect(redone).toBe(HISTORY_LIMIT);
    expect(store.getState().doc.nodes["r0"]).toMatchObject({ x: HISTORY_LIMIT + 5 });
  });

  it("中身が変わらないリサイズは履歴も revision も増やさない", () => {
    const store = setup();
    store
      .getState()
      .apply((doc) =>
        resizeNodes(
          doc,
          ["l1"],
          { x: 140, y: 90, width: 40, height: 0 },
          { x: 140, y: 90, width: 40.2, height: 0 },
          { round: true },
        ),
      );
    expect(store.getState()).toMatchObject({ revision: 0, canUndo: false });
  });
});
