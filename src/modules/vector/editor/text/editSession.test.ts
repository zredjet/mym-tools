import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, createRect, createText, FIRST_PAGE_ID } from "../model/create";
import { insertNode } from "../model/structure";
import { updateNode } from "../model/transform";
import type { CanvasDocument, TextNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import {
  checkText,
  commitTextEdit,
  finishTextEditSession,
  getTextEditSession,
  openTextEditSession,
  startTextCreation,
} from "./editSession";

// 1 文字の幅は 8、行の高さは 22.4
const measurer = fixedWidthMeasurer();
const page = { kind: "page", id: FIRST_PAGE_ID } as const;

function docWithText(text = "abc"): CanvasDocument {
  let doc = createEmptyDocument();
  doc = insertNode(doc, createRect({ id: "r1" }), page);
  doc = insertNode(doc, createText({ id: "t1", text, x: 10, y: 20, width: 24, height: 23 }), page);
  return doc;
}

function textOf(doc: CanvasDocument, id = "t1"): TextNode | undefined {
  const node = doc.nodes[id];
  return node?.type === "text" ? node : undefined;
}

afterEach(() => finishTextEditSession(true));

describe("既存のテキストの編集", () => {
  it("入力のたびに文書が追従し、大きさも合う。終えると履歴 1 件", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    expect(store.getState().gestureActive).toBe(false); // 最初の入力までジェスチャーを開かない

    session.setText("abcd");
    expect(textOf(store.getState().doc)).toMatchObject({ text: "abcd", width: 32 });
    session.setText("abcd\nef");
    expect(textOf(store.getState().doc)).toMatchObject({ width: 32, height: 45 });
    expect(store.getState().revision).toBe(0);
    expect(store.getState().canUndo).toBe(false);

    session.finish();
    const state = store.getState();
    expect(state.editingTextId).toBeNull();
    expect(state.gestureActive).toBe(false);
    expect(state.revision).toBe(1);
    expect(textOf(state.doc)?.text).toBe("abcd\nef");

    state.undo();
    expect(textOf(store.getState().doc)).toMatchObject({ text: "abc", width: 24 });
    expect(store.getState().canUndo).toBe(false);
  });

  it("本文を変えずに終えたら、履歴も revision も増やさない", () => {
    const store = createEditorStore(docWithText());
    const doc = store.getState().doc;
    store.getState().startTextEdit("t1");
    openTextEditSession(store, "t1", measurer).finish();
    expect(store.getState()).toMatchObject({ doc, revision: 0, canUndo: false });
  });

  it("打ってから元の本文に戻して終えたら、履歴も revision も増やさない", () => {
    const store = createEditorStore(docWithText());
    const doc = store.getState().doc;
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    session.setText("abcx");
    session.setText("abc");
    session.finish();
    expect(store.getState()).toMatchObject({ doc, revision: 0, canUndo: false });
  });

  it("空にして終えたら、削除として履歴 1 件", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    session.setText("");
    session.finish();
    expect(store.getState().doc.nodes.t1).toBeUndefined();
    expect(store.getState().revision).toBe(1);
    store.getState().undo();
    expect(textOf(store.getState().doc)?.text).toBe("abc");
    expect(store.getState().selection).toEqual(["t1"]);
  });

  it("途中でほかの操作が確定したら、次の入力から新しいジェスチャーにする", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    session.setText("abcd");
    store.getState().apply((doc) => updateNode(doc, "r1", { opacity: 0.5 }));
    expect(store.getState().revision).toBe(2); // 本文 (確定された分) と不透明度
    session.setText("abcde");
    expect(store.getState().gestureActive).toBe(true);
    session.finish();
    expect(store.getState().revision).toBe(3);
    expect(textOf(store.getState().doc)?.text).toBe("abcde");
  });

  it("Undo でジェスチャーが取り消されたら受け入れ、文書の本文から続ける", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    const onExternalText = vi.fn();
    session.onExternalText = onExternalText;
    session.setText("abcd");
    store.getState().undo();
    expect(textOf(store.getState().doc)?.text).toBe("abc");
    expect(store.getState().editingTextId).toBe("t1");
    expect(onExternalText).toHaveBeenCalledWith("abc");
    expect(session.text).toBe("abc");
    session.finish();
    expect(store.getState().revision).toBe(0);
  });

  it("ほかの操作が編集を終えたら、開いているジェスチャーを確定するだけにする", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    session.setText("abcd");
    store.getState().endTextEdit();
    session.finish(true);
    expect(store.getState()).toMatchObject({ revision: 1, gestureActive: false });
    expect(textOf(store.getState().doc)?.text).toBe("abcd");
  });

  it("編集中に別の文書を読み込んだら、新しい文書を変えない", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    session.setText("abcd");
    const next = docWithText("other");
    store.getState().load(next);
    session.finish(true);
    expect(store.getState()).toMatchObject({ doc: next, revision: 0, canUndo: false });
  });

  it("別のノードのセッションを開くと、前のセッションを終える", () => {
    let doc = docWithText();
    doc = insertNode(doc, createText({ id: "t2", text: "x" }), page);
    const store = createEditorStore(doc);
    store.getState().startTextEdit("t1");
    const first = openTextEditSession(store, "t1", measurer);
    first.setText("abcd");
    expect(openTextEditSession(store, "t1", measurer)).toBe(first);
    store.getState().startTextEdit("t2");
    const second = openTextEditSession(store, "t2", measurer);
    expect(second).not.toBe(first);
    expect(first.isClosed).toBe(true);
    expect(store.getState().revision).toBe(1);
    expect(getTextEditSession()).toBe(second);
  });
});

describe("テキストツールで作ったテキストの編集", () => {
  const created = () =>
    createText({ id: "new", x: 5, y: 6, text: "", width: 0, height: 0, sizing: "auto-width" });

  it("作ってすぐ空のまま終えたら、履歴にも revision にも何も残さず、選択も戻す", () => {
    const store = createEditorStore(docWithText());
    store.getState().setSelection(["r1"]);
    const doc = store.getState().doc;
    expect(startTextCreation(store, created(), page, measurer)).toBe(true);
    expect(store.getState()).toMatchObject({ editingTextId: "new", selection: ["new"] });
    expect(textOf(store.getState().doc, "new")).toMatchObject({ width: 0, height: 23 });

    getTextEditSession()?.finish();
    expect(store.getState()).toMatchObject({
      doc,
      revision: 0,
      canUndo: false,
      gestureActive: false,
      editingTextId: null,
      selection: ["r1"],
    });
  });

  it("打って終えたら、作成と本文で履歴 1 件", () => {
    const store = createEditorStore(docWithText());
    startTextCreation(store, created(), page, measurer);
    getTextEditSession()?.setText("hello");
    getTextEditSession()?.finish();
    expect(textOf(store.getState().doc, "new")).toMatchObject({ text: "hello", width: 40 });
    expect(store.getState().revision).toBe(1);
    store.getState().undo();
    expect(store.getState().doc.nodes.new).toBeUndefined();
    expect(store.getState().canUndo).toBe(false);
  });

  it("打ってから全部消して終えても、何も残さない", () => {
    const store = createEditorStore(docWithText());
    const doc = store.getState().doc;
    startTextCreation(store, created(), page, measurer);
    getTextEditSession()?.setText("a");
    getTextEditSession()?.setText("");
    getTextEditSession()?.finish();
    expect(store.getState()).toMatchObject({ doc, revision: 0, canUndo: false });
  });

  it("Undo で作成ごと取り消されたら、編集を終える (何も残さない)", () => {
    const store = createEditorStore(docWithText());
    const doc = store.getState().doc;
    startTextCreation(store, created(), page, measurer);
    getTextEditSession()?.setText("ab");
    store.getState().undo();
    expect(store.getState()).toMatchObject({ doc, editingTextId: null, gestureActive: false });
    finishTextEditSession(true);
    expect(store.getState()).toMatchObject({ doc, revision: 0, canUndo: false });
  });

  it("入れられなければ (親がないなど) false を返し、何も変えない", () => {
    const store = createEditorStore(docWithText());
    const doc = store.getState().doc;
    const missing = { kind: "node", id: "nothing" } as const;
    expect(startTextCreation(store, created(), missing, measurer)).toBe(false);
    expect(store.getState()).toMatchObject({ doc, gestureActive: false, editingTextId: null });
    expect(getTextEditSession()).toBeNull();
  });
});

describe("文書に入れない本文", () => {
  it("対になっていないサロゲート、上限を超える長さ、全体の上限を超える本文は入れない", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    const session = openTextEditSession(store, "t1", measurer);
    expect(session.setText("ab\uD800")).toBe(false);
    expect(session.setText("a".repeat(100_001))).toBe(false);
    expect(textOf(store.getState().doc)?.text).toBe("abc");
    expect(session.setText("😀".repeat(100_000))).toBe(true);
  });

  it("checkText: 文字数はコードポイントで数え、全体の上限は UTF-8 で数える", () => {
    expect(checkText("😀".repeat(100_000), 0)).toBeNull();
    expect(checkText("a".repeat(100_001), 0)).toBe("too-long");
    expect(checkText("\uDC00", 0)).toBe("lone-surrogate");
    expect(checkText("あ", 4 * 1024 * 1024 - 3)).toBeNull();
    expect(checkText("あ", 4 * 1024 * 1024 - 2)).toBe("total-too-large");
  });
});

describe("commitTextEdit", () => {
  it("編集中なら、打った本文をその場で確定して編集を終える (履歴 1 件)", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    openTextEditSession(store, "t1", measurer).setText("abcd");
    commitTextEdit(store, measurer);
    expect(store.getState()).toMatchObject({
      editingTextId: null,
      gestureActive: false,
      revision: 1,
    });
    expect(textOf(store.getState().doc)?.text).toBe("abcd");
    expect(getTextEditSession()).toBeNull();
  });

  it("作った直後の空のテキストは何も残さずに終える", () => {
    const store = createEditorStore(docWithText());
    const doc = store.getState().doc;
    startTextCreation(store, createText({ id: "new", text: "" }), page, measurer);
    commitTextEdit(store, measurer);
    expect(store.getState()).toMatchObject({ doc, revision: 0, editingTextId: null });
  });

  it("編集欄がまだセッションを開いていなくても終える。空の既存のテキストは消す", () => {
    const store = createEditorStore(docWithText(""));
    store.getState().startTextEdit("t1");
    commitTextEdit(store, measurer);
    expect(store.getState().doc.nodes.t1).toBeUndefined();
    expect(store.getState()).toMatchObject({ editingTextId: null, revision: 1 });
  });

  it("編集中ではないが、編集欄が閉じる前のセッションが残っていれば、開いているジェスチャーを確定する", () => {
    const store = createEditorStore(docWithText());
    store.getState().startTextEdit("t1");
    openTextEditSession(store, "t1", measurer).setText("abcd");
    // ほかの操作が編集を終えた直後 (編集欄の後片付けはまだ)
    store.getState().endTextEdit();
    expect(store.getState()).toMatchObject({ editingTextId: null, gestureActive: true });
    commitTextEdit(store, measurer);
    expect(store.getState()).toMatchObject({ gestureActive: false, revision: 1 });
    expect(textOf(store.getState().doc)?.text).toBe("abcd");
    expect(getTextEditSession()).toBeNull();
  });

  it("編集中でなければ何もしない", () => {
    const store = createEditorStore(docWithText());
    const before = store.getState();
    commitTextEdit(store, measurer);
    expect(store.getState()).toBe(before);
  });
});
