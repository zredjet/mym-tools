/**
 * 本文の編集を、本物の `CanvasView` (ウィンドウの blur の処理、アンマウントの後片付け) を通して確かめる。
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasView } from "../canvas/CanvasView";
import { createEmptyDocument, createText, FIRST_PAGE_ID } from "../model/create";
import { insertNode } from "../model/structure";
import type { CanvasDocument, TextNode } from "../model/types";
import { editorStore } from "../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../state/types";
import { finishTextEditSession } from "./editSession";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const page = { kind: "page", id: FIRST_PAGE_ID } as const;
const state = () => editorStore.getState();
const textOf = (id: string) => state().doc.nodes[id] as TextNode | undefined;
const flushMicrotasks = () => act(async () => {});

function documentWithText(): CanvasDocument {
  return insertNode(
    createEmptyDocument(),
    createText({ id: "t1", text: "abc", x: 10, y: 20, width: 30, height: 23 }),
    page,
  );
}

function setup() {
  const view = render(
    <StrictMode>
      <CanvasView />
    </StrictMode>,
  );
  const canvas = view.container.querySelector<HTMLElement>("[data-canvas-view]");
  if (!canvas) throw new Error("no canvas");
  return { ...view, canvas };
}

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector<HTMLTextAreaElement>("[data-canvas-text-editor]");
  if (!element) throw new Error("no textarea");
  return element;
}

/**
 * ウィンドウが非アクティブになったときのイベント。入力欄はフォーカスを持ったまま (`activeElement` は変わらない)。
 * - chromium: 入力欄に blur と focusout、そのあと window に blur。`document.hasFocus()` は偽
 * - webkit: 入力欄に blur だけ (focusout なし。Safari 15〜17.5 相当)、そのあと window に blur
 */
function deactivateWindow(element: HTMLElement, engine: "chromium" | "webkit") {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  act(() => {
    element.dispatchEvent(new FocusEvent("blur"));
    if (engine === "chromium") element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    window.dispatchEvent(new FocusEvent("blur"));
  });
}

function activateWindow(element: HTMLElement) {
  vi.mocked(document.hasFocus).mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"));
    element.dispatchEvent(new FocusEvent("focus"));
    element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  state().load(documentWithText());
  state().setViewport({ x: 0, y: 0, zoom: 1 });
  state().setView(DEFAULT_VIEW_OPTIONS);
});

afterEach(() => {
  cleanup();
  finishTextEditSession(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ウィンドウのフォーカス喪失 (本物の CanvasView)", () => {
  for (const engine of ["chromium", "webkit"] as const) {
    it(`${engine} の順でも、既存のテキストの編集が続き、打った本文が残る`, () => {
      setup();
      act(() => state().startTextEdit("t1"));
      fireEvent.change(textarea(), { target: { value: "abcd" } });

      deactivateWindow(textarea(), engine);
      expect(state()).toMatchObject({ editingTextId: "t1", gestureActive: true });
      expect(textOf("t1")?.text).toBe("abcd");
      expect(textarea().value).toBe("abcd");

      activateWindow(textarea());
      fireEvent.change(textarea(), { target: { value: "abcde" } });
      fireEvent.keyDown(textarea(), { key: "Escape" });
      expect(state()).toMatchObject({ editingTextId: null, revision: 1 });
      expect(textOf("t1")?.text).toBe("abcde");
      act(() => state().undo());
      expect(textOf("t1")?.text).toBe("abc");
    });

    it(`${engine} の順でも、テキストツールで作ったテキストがノードごと残る`, () => {
      const { canvas } = setup();
      act(() => state().setTool("text"));
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 200, clientY: 150 });
      fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 200, clientY: 150 });
      const id = state().editingTextId;
      expect(id).not.toBeNull();
      expect(document.activeElement).toBe(textarea());
      fireEvent.change(textarea(), { target: { value: "new" } });

      deactivateWindow(textarea(), engine);
      // フォーカスを失ったあとに入力が来ても (変換の確定など)、その後の取消で戻らない
      fireEvent.change(textarea(), { target: { value: "new!" } });
      act(() => window.dispatchEvent(new FocusEvent("blur")));
      expect(state()).toMatchObject({ editingTextId: id, gestureActive: true });
      expect(textOf(id as string)?.text).toBe("new!");

      activateWindow(textarea());
      fireEvent.keyDown(textarea(), { key: "Escape" });
      expect(state().revision).toBe(1);
      expect(textOf(id as string)?.text).toBe("new!");
    });
  }

  it("入力欄の外へフォーカスが移ったら (文書はフォーカスを持ったまま) 終える", () => {
    setup();
    act(() => state().startTextEdit("t1"));
    fireEvent.change(textarea(), { target: { value: "abcd" } });
    act(() => textarea().blur());
    expect(state()).toMatchObject({ editingTextId: null, revision: 1 });
  });
});

describe("編集中にキャンバスが画面から外れる (本物の CanvasView)", () => {
  it("アンマウントの後片付けで、打った本文を確定する (履歴 1 件)", async () => {
    const { unmount } = setup();
    act(() => state().startTextEdit("t1"));
    fireEvent.change(textarea(), { target: { value: "abcd" } });
    unmount();
    await flushMicrotasks();
    expect(state()).toMatchObject({ editingTextId: null, gestureActive: false, revision: 1 });
    expect(textOf("t1")?.text).toBe("abcd");
    act(() => state().undo());
    expect(textOf("t1")?.text).toBe("abc");
  });

  it("作った直後の空のテキストは、アンマウントで何も残さない", async () => {
    const { canvas, unmount } = setup();
    const doc = state().doc;
    act(() => state().setTool("text"));
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 200, clientY: 150 });
    expect(state().editingTextId).not.toBeNull();
    unmount();
    await flushMicrotasks();
    expect(state()).toMatchObject({ doc, revision: 0, gestureActive: false, editingTextId: null });
  });
});
