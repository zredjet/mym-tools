import { describe, expect, it } from "vitest";
import { createText } from "../../model/create";
import { insertNode } from "../../model/structure";
import { sampleDocument } from "../../model/testing";
import { updateNode } from "../../model/transform";
import { EditorClipboard } from "../../state/clipboard";
import { createEditorStore } from "../../state/store";
import {
  duplicateWithinLimits,
  enterSelection,
  escapeSelection,
  nudgeSelection,
  pasteWithinLimits,
  transformableIds,
} from "./actions";

const setup = (doc = sampleDocument()) => createEditorStore(doc);

describe("transformableIds", () => {
  it("祖先も選ばれたものと、ロック中・非表示 (祖先を含む) を除く", () => {
    const doc = updateNode(sampleDocument(), "f2", { locked: true });
    expect(transformableIds(doc, ["grp", "r2", "r3", "r1"])).toEqual(["r1", "grp"]);
  });
});

describe("nudgeSelection", () => {
  it("動かせるものだけを動かし、履歴に 1 件積む", () => {
    const store = setup(updateNode(sampleDocument(), "r0", { locked: true }));
    store.getState().setSelection(["r1", "r0"]);
    expect(nudgeSelection(store, 10, -1)).toBe(true);
    const s = store.getState();
    expect(s.doc.nodes.r1).toMatchObject({ x: 20, y: 9 });
    expect(s.doc.nodes.r0).toMatchObject({ x: 0, y: 0 });
    expect(s.revision).toBe(1);
  });

  it("動かせるものがなければ false。範囲を超えるなら動かさない", () => {
    const store = setup(updateNode(sampleDocument(), "r0", { x: 999_995 }));
    expect(nudgeSelection(store, 1, 0)).toBe(false);
    store.getState().setSelection(["r0"]);
    nudgeSelection(store, 10, 0);
    expect(store.getState().doc.nodes.r0).toMatchObject({ x: 999_995 });
    expect(store.getState().revision).toBe(0);
  });
});

describe("複製と貼り付け", () => {
  it("複製は範囲を超えなければ行う", () => {
    const store = setup();
    store.getState().setSelection(["r0"]);
    duplicateWithinLimits(store);
    const [copy] = store.getState().selection;
    expect(copy).not.toBe("r0");
    expect(store.getState().doc.nodes[copy!]).toMatchObject({ x: 10, y: 10 });

    const far = setup(updateNode(sampleDocument(), "r0", { x: 999_995 }));
    far.getState().setSelection(["r0"]);
    duplicateWithinLimits(far);
    expect(far.getState().revision).toBe(0);
  });

  it("貼り付けは範囲を超えなければ行う", () => {
    const store = setup();
    const clipboard = new EditorClipboard();
    clipboard.copy(store.getState().doc, ["r0"]);
    pasteWithinLimits(store, clipboard);
    expect(store.getState().revision).toBe(1);

    const far = setup(updateNode(sampleDocument(), "r0", { x: 999_995 }));
    const farClipboard = new EditorClipboard();
    farClipboard.copy(far.getState().doc, ["r0"]);
    pasteWithinLimits(far, farClipboard);
    expect(far.getState().revision).toBe(0);
    // 範囲内なら続けて貼れる (数え方が狂っていない)
    pasteWithinLimits(store, clipboard);
    expect(store.getState().revision).toBe(2);
  });
});

describe("Enter と Esc", () => {
  it("Enter: group / frame は中に入って子を選ぶ。テキストは本文の編集", () => {
    const doc = insertNode(sampleDocument(), createText({ id: "t", text: "a" }), {
      kind: "page",
      id: "p1",
    });
    const store = setup(doc);
    store.getState().setSelection(["grp"]);
    expect(enterSelection(store)).toBe(true);
    expect(store.getState()).toMatchObject({ scopeId: "grp", selection: ["r2", "l1"] });
    store.getState().setSelection(["t"]);
    expect(enterSelection(store)).toBe(true);
    expect(store.getState().editingTextId).toBe("t");
    store.getState().setSelection(["r0"]);
    expect(enterSelection(store)).toBe(false);
  });

  it("Esc: 本文の編集の終了 → スコープを 1 段外へ (出たノードを選ぶ) → 選択の解除", () => {
    const doc = insertNode(sampleDocument(), createText({ id: "t", text: "a" }), {
      kind: "node",
      id: "grp",
    });
    const store = setup(doc);
    store.getState().setScope("grp");
    store.getState().startTextEdit("t");
    expect(escapeSelection(store)).toBe(true);
    expect(store.getState()).toMatchObject({ editingTextId: null, scopeId: "grp" });
    expect(escapeSelection(store)).toBe(true);
    // grp の親はページ直下の frame なので、ページ直下まで出る
    expect(store.getState()).toMatchObject({ scopeId: null, selection: ["grp"] });
    expect(escapeSelection(store)).toBe(true);
    expect(store.getState().selection).toEqual([]);
    expect(escapeSelection(store)).toBe(false);
  });

  it("Esc: 入れ子のスコープは 1 段ずつ出る", () => {
    const store = setup();
    store.getState().setScope("f2");
    escapeSelection(store);
    expect(store.getState()).toMatchObject({ scopeId: null, selection: ["f2"] });
  });
});
