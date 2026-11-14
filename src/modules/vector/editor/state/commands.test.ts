import { describe, expect, it } from "vitest";
import { addAsset } from "../model/assets";
import { createEmptyDocument, createImage, FIRST_PAGE_ID } from "../model/create";
import { getPageBounds } from "../model/geometry";
import { insertNode } from "../model/structure";
import { deepFreeze, sampleDocument } from "../model/testing";
import { getParent } from "../model/tree";
import { EditorClipboard, PASTE_OFFSET } from "./clipboard";
import {
  alignSelection,
  copySelection,
  cutSelection,
  deleteSelection,
  distributeSelection,
  duplicateSelection,
  groupSelection,
  nudgeSelection,
  pasteClipboard,
  pasteTarget,
  reorderSelection,
  selectAll,
  ungroupSelection,
} from "./commands";
import { createEditorStore } from "./store";

const setup = (selection: string[] = []) => {
  const store = createEditorStore();
  store.getState().load(deepFreeze(sampleDocument()));
  store.getState().setSelection(selection);
  return store;
};

describe("クリップボード", () => {
  it("別の文書へ新しい ID で、少しずらして貼り付ける", () => {
    const clipboard = new EditorClipboard();
    const source = setup(["r1"]);
    expect(copySelection(source, clipboard)).toBe(true);

    const target = createEditorStore();
    pasteClipboard(target, clipboard);
    const [pasted] = target.getState().selection;
    expect(pasted).toBeDefined();
    expect(pasted).not.toBe("r1");
    expect(getPageBounds(target.getState().doc, pasted!)).toEqual({
      x: 110 + PASTE_OFFSET,
      y: 60 + PASTE_OFFSET,
      width: 20,
      height: 20,
    });
    // 続けて貼り付けると、さらにずれる
    pasteClipboard(target, clipboard);
    const [second] = target.getState().selection;
    expect(getPageBounds(target.getState().doc, second!)).toMatchObject({
      x: 110 + 2 * PASTE_OFFSET,
    });
    expect(target.getState().doc.pages[0]!.children).toHaveLength(2);
  });

  it("画像はアセットごとコピーし、同じ文書に何度貼っても 1 つを共有する", () => {
    const clipboard = new EditorClipboard();
    const { doc: withAsset, assetId } = addAsset(createEmptyDocument(), {
      kind: "image",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      width: 1,
      height: 1,
    });
    const doc = insertNode(withAsset, createImage(assetId, { id: "img" }), {
      kind: "page",
      id: FIRST_PAGE_ID,
    });
    const source = createEditorStore(doc);
    source.getState().setSelection(["img"]);
    copySelection(source, clipboard);

    const target = createEditorStore();
    pasteClipboard(target, clipboard);
    pasteClipboard(target, clipboard);
    expect(Object.keys(target.getState().doc.assets)).toEqual([assetId]);

    // 元の文書から画像を消してもクリップボードの中身は残る
    deleteSelection(source);
    pasteClipboard(source, clipboard);
    expect(Object.keys(source.getState().doc.assets)).toEqual([assetId]);
  });

  it("切り取りは消して、貼り付けで戻せる", () => {
    const clipboard = new EditorClipboard();
    const store = setup(["grp"]);
    cutSelection(store, clipboard);
    expect(store.getState().doc.nodes["grp"]).toBeUndefined();
    expect(store.getState().selection).toEqual([]);
    pasteClipboard(store, clipboard);
    expect(store.getState().selection).toHaveLength(1);
    expect(Object.keys(store.getState().doc.nodes)).toHaveLength(8);
  });

  it("frame を 1 つ選んでいればその中、スコープがあればその中へ貼り付ける", () => {
    const store = setup(["f2"]);
    expect(pasteTarget(store.getState())).toEqual({ kind: "node", id: "f2" });
    store.getState().setSelection(["r1"]);
    store.getState().setScope("f");
    expect(pasteTarget(store.getState())).toEqual({ kind: "node", id: "f" });
    store.getState().setScope(null);
    expect(pasteTarget(store.getState())).toEqual({ kind: "page", id: "p1" });

    const clipboard = new EditorClipboard();
    copySelection(store, clipboard);
    store.getState().setSelection(["f2"]);
    pasteClipboard(store, clipboard);
    const [pasted] = store.getState().selection;
    expect(getParent(store.getState().doc, pasted!)).toEqual({ kind: "node", id: "f2" });
  });

  it("空のクリップボードと、何も選んでいないコピーは何もしない", () => {
    const clipboard = new EditorClipboard();
    const store = setup();
    expect(copySelection(store, clipboard)).toBe(false);
    expect(clipboard.hasContent()).toBe(false);
    pasteClipboard(store, clipboard);
    expect(store.getState().revision).toBe(0);
  });
});

describe("選択に対する操作", () => {
  it("削除と Undo", () => {
    const store = setup(["r1", "r0"]);
    deleteSelection(store);
    expect(store.getState().selection).toEqual([]);
    store.getState().undo();
    expect(store.getState().selection).toEqual(["r1", "r0"]);
    expect(store.getState().doc.nodes["r1"]).toBeDefined();
  });

  it("複製は複製を選ぶ", () => {
    const store = setup(["r1"]);
    duplicateSelection(store);
    const [copy] = store.getState().selection;
    expect(copy).not.toBe("r1");
    expect(store.getState().doc.nodes[copy!]).toMatchObject({ x: 20, y: 20 });
  });

  it("グループ化は group を選び、解除は子を選ぶ。どちらも 1 回の Undo で戻る", () => {
    const store = setup(["r1", "f2"]);
    groupSelection(store);
    const [group] = store.getState().selection;
    expect(store.getState().doc.nodes[group!]?.type).toBe("group");
    ungroupSelection(store);
    expect(store.getState().selection).toEqual(["r1", "f2"]);
    store.getState().undo();
    expect(store.getState().selection).toEqual([group]);
    store.getState().undo();
    expect(store.getState().selection).toEqual(["r1", "f2"]);
    expect(store.getState().doc).toEqual(sampleDocument());
  });

  it("移動・重なり順・整列・等間隔", () => {
    const store = setup(["r1"]);
    nudgeSelection(store, 10, 0);
    expect(store.getState().doc.nodes["r1"]).toMatchObject({ x: 20 });
    reorderSelection(store, "front");
    expect(store.getState().doc.nodes["f"]).toMatchObject({ children: ["grp", "f2", "r1"] });
    alignSelection(store, "left");
    expect(store.getState().doc.nodes["r1"]).toMatchObject({ x: 0 });
    const revision = store.getState().revision;
    distributeSelection(store, "horizontal"); // 1 個では何もしない
    expect(store.getState().revision).toBe(revision);
  });

  it("すべて選択はスコープの中の、表示中でロックしていないノード", () => {
    const store = setup();
    selectAll(store);
    expect(store.getState().selection).toEqual(["f", "r0"]);
    store.getState().apply((doc) => ({
      ...doc,
      nodes: { ...doc.nodes, r1: { ...doc.nodes["r1"]!, locked: true } },
    }));
    store.getState().setScope("f");
    selectAll(store);
    expect(store.getState().selection).toEqual(["grp", "f2"]);
  });
});

describe("貼り付け先と位置 (§4.10)", () => {
  it("frame をコピーしてそのまま貼ると、入れ子にならず兄弟になる", () => {
    const clipboard = new EditorClipboard();
    const store = setup(["f2"]);
    copySelection(store, clipboard);
    pasteClipboard(store, clipboard);
    const [first] = store.getState().selection;
    expect(getParent(store.getState().doc, first!)).toEqual({ kind: "node", id: "f" });
    // 貼ったものを選んだまま続けて貼っても、その中には入らない
    pasteClipboard(store, clipboard);
    const [second] = store.getState().selection;
    expect(getParent(store.getState().doc, second!)).toEqual({ kind: "node", id: "f" });
    expect(getPageBounds(store.getState().doc, second!)).toMatchObject({ x: 320, y: 170 });
  });

  it("frame の子をコピーして貼ると、同じ frame の中に入る", () => {
    const clipboard = new EditorClipboard();
    const store = setup(["r1"]);
    copySelection(store, clipboard);
    pasteClipboard(store, clipboard);
    const [pasted] = store.getState().selection;
    expect(getParent(store.getState().doc, pasted!)).toEqual({ kind: "node", id: "f" });
    expect(store.getState().doc.nodes[pasted!]).toMatchObject({ x: 20, y: 20 });
  });

  it("選んだ frame と重ならない位置なら、frame の中央に置く", () => {
    const clipboard = new EditorClipboard();
    const store = setup(["r0"]);
    copySelection(store, clipboard);
    store.getState().setSelection(["f2"]);
    pasteClipboard(store, clipboard);
    const [pasted] = store.getState().selection;
    expect(getParent(store.getState().doc, pasted!)).toEqual({ kind: "node", id: "f2" });
    // f2 はページ座標で (300, 150) 100×100。中央に 10×10 を置く
    expect(getPageBounds(store.getState().doc, pasted!)).toEqual({
      x: 345,
      y: 195,
      width: 10,
      height: 10,
    });
  });

  it("コピー元の親がない文書では、スコープかページの直下", () => {
    const clipboard = new EditorClipboard();
    copySelection(setup(["r3"]), clipboard);
    const target = createEditorStore();
    expect(pasteTarget(target.getState(), clipboard)).toEqual({
      kind: "page",
      id: FIRST_PAGE_ID,
    });
  });
});

describe("Object.prototype と同じ名前の ID のコピー・切り取り・貼り付け", () => {
  it("__proto__ と constructor を切り取って貼ると、2 個とも新しい ID で戻る", () => {
    const json = JSON.stringify({
      pages: [{ id: "p", name: "", children: ["PROTO", "CTOR"], guides: [] }],
      nodes: {
        PROTO: { ...sampleDocument().nodes["r0"]!, id: "PROTO" },
        CTOR: { ...sampleDocument().nodes["r1"]!, id: "CTOR" },
      },
      assets: {},
    })
      .split('"PROTO"')
      .join('"__proto__"')
      .split('"CTOR"')
      .join('"constructor"');
    const store = createEditorStore(deepFreeze(JSON.parse(json)));
    store.getState().setSelection(["__proto__", "constructor"]);
    expect(store.getState().selection).toEqual(["__proto__", "constructor"]);

    const clipboard = new EditorClipboard();
    cutSelection(store, clipboard);
    expect(Object.keys(store.getState().doc.nodes)).toEqual([]);
    pasteClipboard(store, clipboard);
    const pasted = store.getState().selection;
    expect(pasted).toHaveLength(2);
    expect(store.getState().doc.pages[0]!.children).toEqual(pasted);
    expect(getPageBounds(store.getState().doc, pasted[0]!)).toMatchObject({ x: 10, y: 10 });
  });
});
