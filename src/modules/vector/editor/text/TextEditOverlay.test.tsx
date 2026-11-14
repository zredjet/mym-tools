import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageLayer } from "../canvas/DocumentLayer";
import { createEmptyDocument, createFrame, createText, FIRST_PAGE_ID } from "../model/create";
import { insertNode } from "../model/structure";
import type { CanvasDocument, TextNode } from "../model/types";
import { canvasTextMeasurer } from "../render/measureText";
import { editorStore } from "../state/store";
import { finishTextEditSession, getTextEditSession, startTextCreation } from "./editSession";
import { editorTextColor } from "./editorStyle";
import { TextEditOverlay } from "./TextEditOverlay";

const page = { kind: "page", id: FIRST_PAGE_ID } as const;
const state = () => editorStore.getState();
const textOf = (id = "t1") => state().doc.nodes[id] as TextNode | undefined;

function documentWithText(): CanvasDocument {
  let doc = createEmptyDocument();
  doc = insertNode(doc, createFrame({ id: "f1", x: 100, y: 50, width: 400, height: 300 }), page);
  doc = insertNode(
    doc,
    createText({
      id: "t1",
      text: "abc",
      x: 10,
      y: 20,
      width: 30,
      height: 23,
      fontFamily: "Hiragino Sans",
      fontWeight: 700,
      letterSpacing: 1,
      align: "center",
    }),
    { kind: "node", id: "f1" },
  );
  return doc;
}

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector<HTMLTextAreaElement>("[data-canvas-text-editor]");
  if (!element) throw new Error("no textarea");
  return element;
}

const flushMicrotasks = () => act(async () => {});

beforeEach(() => {
  state().load(documentWithText());
  state().setViewport({ x: 0, y: 0, zoom: 1 });
});

afterEach(() => {
  cleanup();
  finishTextEditSession(true);
  vi.restoreAllMocks();
});

describe("TextEditOverlay: 表示", () => {
  it("編集中だけ入力欄を出し、テキストの位置・倍率・書式に合わせる", () => {
    render(<TextEditOverlay />);
    expect(document.querySelector("[data-canvas-text-editor]")).toBeNull();
    act(() => state().setViewport({ x: 50, y: 20, zoom: 2 }));
    act(() => state().startTextEdit("t1"));
    const element = textarea();
    expect(element.value).toBe("abc");
    // ページ座標 (110, 70) → 画面 ((110 - 50) × 2, (70 - 20) × 2) = (120, 100)。余白 2 px の分だけ左上へ
    expect(element.style.left).toBe("118px");
    expect(element.style.top).toBe("98px");
    expect(element.style.transform).toBe("scale(2)");
    expect(element.style.width).toBe("30px");
    expect(element.style.fontFamily).toContain("Hiragino Sans");
    expect(element.style.fontWeight).toBe("700");
    expect(element.style.letterSpacing).toBe("1px");
    expect(element.style.textAlign).toBe("center");
    expect(element.style.whiteSpace).toBe("pre");
    expect(element.style.pointerEvents).toBe("auto");
    // 禁則 (line-break: strict) はページの言語に関係なく日本語の規則
    expect(element.getAttribute("lang")).toBe("ja");
    expect(document.activeElement).toBe(element);

    act(() => state().setViewport({ x: 0, y: 0, zoom: 1 }));
    expect(textarea().style.left).toBe("108px");
  });

  it("auto-height と fixed は折り返す。fixed で本文が高さを超えたら、はみ出した行も見せる", () => {
    act(() =>
      state().apply((doc) => ({
        ...doc,
        nodes: {
          ...doc.nodes,
          t1: { ...(doc.nodes.t1 as TextNode), sizing: "fixed", height: 5, text: "a\nb\nc" },
        },
      })),
    );
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    expect(textarea().style.whiteSpace).toBe("pre-wrap");
    expect(Number.parseFloat(textarea().style.height)).toBeGreaterThan(60);
  });

  it("編集中のテキストを文書の層で描かない", () => {
    const { container } = render(
      <svg>
        <PageLayer size={{ width: 1000, height: 1000 }} />
      </svg>,
    );
    expect(container.querySelectorAll("text")).toHaveLength(1);
    act(() => state().startTextEdit("t1"));
    expect(container.querySelectorAll("text")).toHaveLength(0);
    act(() => state().endTextEdit());
    expect(container.querySelectorAll("text")).toHaveLength(1);
  });

  it("文字の色は塗りの色。塗りがなければ薄い前景色、グラデーションは先頭の色", () => {
    expect(editorTextColor({ type: "solid", color: "#FF8000", opacity: 0.5 }, 1)).toBe(
      "rgba(255, 128, 0, 0.5)",
    );
    expect(editorTextColor(null, 1)).toBe("var(--fg-muted)");
    expect(
      editorTextColor(
        {
          type: "linear",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 0 },
          stops: [
            { offset: 0, color: "#000010", opacity: 1 },
            { offset: 1, color: "#FFFFFF", opacity: 1 },
          ],
        },
        0.5,
      ),
    ).toBe("rgba(0, 0, 16, 0.5)");
  });
});

describe("TextEditOverlay: 入力と終了", () => {
  it("入力のたびに文書が追従し、Esc で終えると履歴 1 件", () => {
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    fireEvent.change(textarea(), { target: { value: "abcd" } });
    fireEvent.change(textarea(), { target: { value: "abcde" } });
    expect(textOf()?.text).toBe("abcde");
    expect(state().revision).toBe(0);
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(state().editingTextId).toBeNull();
    expect(state().revision).toBe(1);
    expect(document.querySelector("[data-canvas-text-editor]")).toBeNull();
    act(() => state().undo());
    expect(textOf()?.text).toBe("abc");
  });

  it("フォーカスが外れたら終える", () => {
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    fireEvent.change(textarea(), { target: { value: "x" } });
    act(() => textarea().blur());
    expect(state()).toMatchObject({ editingTextId: null, revision: 1 });
  });

  it("日本語入力の変換中の Esc と Enter では終えない", () => {
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    const element = textarea();
    fireEvent.compositionStart(element);
    fireEvent.change(element, { target: { value: "abcに" } });
    fireEvent.keyDown(element, { key: "Escape", isComposing: true });
    fireEvent.keyDown(element, { key: "Escape", keyCode: 229 });
    fireEvent.keyDown(element, { key: "Enter", keyCode: 229 });
    expect(state().editingTextId).toBe("t1");
    fireEvent.change(element, { target: { value: "abc日本" } });
    fireEvent.compositionEnd(element);
    expect(textOf()?.text).toBe("abc日本");
    // 変換を確定した直後の Esc (Safari は compositionend の後に keydown を送る) でも終えない
    fireEvent.keyDown(element, { key: "Escape" });
    expect(state().editingTextId).toBe("t1");
  });

  it("変換を終えてしばらくたった Esc では終える", () => {
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    const element = textarea();
    const at = (event: Event, timeStamp: number) => {
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      act(() => {
        element.dispatchEvent(event);
      });
    };
    fireEvent.compositionStart(element);
    at(new CompositionEvent("compositionend", { bubbles: true }), 1000);
    at(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }), 1010);
    expect(state().editingTextId).toBe("t1");
    at(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }), 2000);
    expect(state().editingTextId).toBeNull();
  });

  it("上限を超える入力と対になっていないサロゲートは文書に入れず、入力欄を戻す", () => {
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    const element = textarea();
    fireEvent.change(element, { target: { value: "ab\uD800c" } });
    expect(element.value).toBe("abc");
    expect(textOf()?.text).toBe("abc");
    fireEvent.change(element, { target: { value: "a".repeat(100_001) } });
    expect(element.value).toBe("abc");
  });

  it("StrictMode の後片付けが余分に走っても、編集を終えない", async () => {
    render(
      <StrictMode>
        <TextEditOverlay />
      </StrictMode>,
    );
    act(() => state().startTextEdit("t1"));
    await flushMicrotasks();
    expect(state().editingTextId).toBe("t1");
    expect(getTextEditSession()?.isClosed).toBe(false);
    fireEvent.change(textarea(), { target: { value: "abcd" } });
    expect(textOf()?.text).toBe("abcd");
  });

  it("ほかの操作が編集を終えたら入力欄を閉じ、開いているジェスチャーを確定する", async () => {
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    fireEvent.change(textarea(), { target: { value: "abcd" } });
    act(() => state().endTextEdit());
    await flushMicrotasks();
    expect(document.querySelector("[data-canvas-text-editor]")).toBeNull();
    expect(state()).toMatchObject({ gestureActive: false, revision: 1 });
  });

  it("作ったテキストが Undo で消えたら入力欄を閉じ、何も残さない", async () => {
    const doc = state().doc;
    render(<TextEditOverlay />);
    act(() => {
      startTextCreation(
        editorStore,
        createText({ id: "n1", text: "", x: 0, y: 0 }),
        page,
        canvasTextMeasurer,
      );
    });
    fireEvent.change(textarea(), { target: { value: "hi" } });
    act(() => state().undo());
    await flushMicrotasks();
    expect(document.querySelector("[data-canvas-text-editor]")).toBeNull();
    expect(state()).toMatchObject({ doc, revision: 0, canUndo: false, editingTextId: null });
  });

  it("既存のテキストの編集中に Undo で本文が戻ったら、入力欄も戻す", () => {
    render(<TextEditOverlay />);
    act(() => state().startTextEdit("t1"));
    fireEvent.change(textarea(), { target: { value: "abcd" } });
    act(() => state().undo());
    expect(textarea().value).toBe("abc");
    expect(state().editingTextId).toBe("t1");
  });
});
