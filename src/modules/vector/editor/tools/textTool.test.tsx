import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument, createFrame, FIRST_PAGE_ID } from "../model/create";
import { insertNode } from "../model/structure";
import type { CanvasDocument, Point, TextNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { getTextToolDrag, newTextNode, textParentAt } from "../text/creation";
import { finishTextEditSession, getTextEditSession } from "../text/editSession";
import { fontDetector } from "../text/fonts";
import { textTool } from "./textTool";
import type { CanvasPointerEvent, ToolContext } from "./types";

const page = { kind: "page", id: FIRST_PAGE_ID } as const;

function documentWithFrames(): CanvasDocument {
  let doc = createEmptyDocument();
  doc = insertNode(doc, createFrame({ id: "back", x: 0, y: 0, width: 500, height: 500 }), page);
  doc = insertNode(
    doc,
    createFrame({ id: "front", x: 100, y: 100, width: 100, height: 100 }),
    page,
  );
  doc = insertNode(
    doc,
    createFrame({ id: "hidden", x: 120, y: 120, width: 50, height: 50, visible: false }),
    page,
  );
  return doc;
}

function pointer(page: Point, screen: Point = page): CanvasPointerEvent {
  return { page, screen, button: 0, clickCount: 1, shift: false, alt: false, mod: false };
}

let store = createEditorStore();
let ctx: ToolContext;

beforeEach(() => {
  store = createEditorStore(documentWithFrames());
  store.getState().setTool("text");
  ctx = { store, measurer: fixedWidthMeasurer(), setCursor: vi.fn() };
  vi.spyOn(fontDetector, "defaultFamily").mockReturnValue("Hiragino Sans");
});

afterEach(() => {
  cleanup();
  textTool.onCancel?.(ctx);
  finishTextEditSession(true);
  vi.restoreAllMocks();
});

const createdText = (): TextNode => {
  const id = store.getState().editingTextId;
  const node = id ? store.getState().doc.nodes[id] : undefined;
  if (node?.type !== "text") throw new Error("no text");
  return node;
};

describe("textTool", () => {
  it("クリックで auto-width のテキストを作り、すぐ本文の編集を始め、選択ツールへ戻る", () => {
    textTool.onPointerDown?.(pointer({ x: 620.4, y: 30.6 }), ctx);
    textTool.onPointerUp?.(pointer({ x: 620.4, y: 30.6 }), ctx);
    const node = createdText();
    expect(node).toMatchObject({
      x: 620,
      y: 31,
      sizing: "auto-width",
      text: "",
      fontFamily: "Hiragino Sans",
      fontSize: 16,
      fontWeight: 400,
      width: 0,
      height: 23,
    });
    expect(store.getState().doc.pages[0]?.children).toContain(node.id);
    expect(store.getState()).toMatchObject({ toolId: "select", selection: [node.id] });
    expect(getTextEditSession()?.nodeId).toBe(node.id);
    // 作成はジェスチャーの中 (空のまま終えたら何も残らない)
    expect(store.getState()).toMatchObject({ gestureActive: true, revision: 0 });
  });

  it("ドラッグで幅を決めた auto-height のテキストを作る (左上はドラッグした矩形の左上)", () => {
    textTool.onPointerDown?.(pointer({ x: 300, y: 260 }), ctx);
    textTool.onPointerMove?.(pointer({ x: 260, y: 270 }), ctx);
    textTool.onPointerUp?.(pointer({ x: 240, y: 280 }), ctx);
    expect(createdText()).toMatchObject({
      x: 240,
      y: 260,
      width: 60,
      sizing: "auto-height",
      height: 23,
    });
  });

  it("しきい値より小さい動きはクリックとして扱う", () => {
    textTool.onPointerDown?.(pointer({ x: 10, y: 10 }), ctx);
    textTool.onPointerMove?.(pointer({ x: 11, y: 11 }), ctx);
    textTool.onPointerUp?.(pointer({ x: 11, y: 11 }), ctx);
    expect(createdText()).toMatchObject({ x: 10, y: 10, sizing: "auto-width" });
  });

  it("押した位置を含む最前面の frame の中に、frame の座標で作る", () => {
    textTool.onPointerDown?.(pointer({ x: 150, y: 160 }), ctx);
    textTool.onPointerUp?.(pointer({ x: 150, y: 160 }), ctx);
    const node = createdText();
    expect(node).toMatchObject({ x: 50, y: 60 });
    const front = store.getState().doc.nodes.front;
    expect(front?.type === "frame" && front.children).toEqual([node.id]);
  });

  it("ボタン以外の押下と取消では作らない", () => {
    textTool.onPointerDown?.({ ...pointer({ x: 1, y: 1 }), button: 2 }, ctx);
    textTool.onPointerUp?.(pointer({ x: 1, y: 1 }), ctx);
    expect(store.getState().editingTextId).toBeNull();
    textTool.onPointerDown?.(pointer({ x: 1, y: 1 }), ctx);
    textTool.onCancel?.(ctx);
    expect(getTextToolDrag()).toBeNull();
    textTool.onPointerUp?.(pointer({ x: 1, y: 1 }), ctx);
    expect(store.getState()).toMatchObject({ editingTextId: null, toolId: "text" });
  });

  it("ドラッグ中だけ、しきい値を超えたら矩形を重ね描きする", () => {
    const Overlay = textTool.Overlay;
    if (!Overlay) throw new Error("no overlay");
    const { container } = render(
      <svg>
        <Overlay />
      </svg>,
    );
    act(() => textTool.onPointerDown?.(pointer({ x: 10, y: 10 }), ctx));
    expect(container.querySelector("[data-text-tool-preview]")).toBeNull();
    act(() => textTool.onPointerMove?.(pointer({ x: 50, y: 30 }), ctx));
    const rect = container.querySelector("[data-text-tool-preview]");
    expect(rect?.getAttribute("width")).toBe("40");
    expect(rect?.getAttribute("height")).toBe("20");
    act(() => textTool.onCancel?.(ctx));
    expect(container.querySelector("[data-text-tool-preview]")).toBeNull();
  });
});

describe("textParentAt / newTextNode", () => {
  const doc = documentWithFrames();

  it("非表示・ロック中の frame は親にしない。どの frame にも入らなければページ直下", () => {
    expect(textParentAt(doc, FIRST_PAGE_ID, null, { x: 130, y: 130 })).toEqual({
      kind: "node",
      id: "front",
    });
    expect(textParentAt(doc, FIRST_PAGE_ID, null, { x: 400, y: 400 })).toEqual({
      kind: "node",
      id: "back",
    });
    expect(textParentAt(doc, FIRST_PAGE_ID, null, { x: 900, y: 900 })).toEqual(page);
    const locked = {
      ...doc,
      nodes: { ...doc.nodes, front: { ...doc.nodes.front, locked: true } },
    } as CanvasDocument;
    expect(textParentAt(locked, FIRST_PAGE_ID, null, { x: 130, y: 130 })).toEqual({
      kind: "node",
      id: "back",
    });
  });

  it("スコープがあればその中", () => {
    expect(textParentAt(doc, FIRST_PAGE_ID, "front", { x: 900, y: 900 })).toEqual({
      kind: "node",
      id: "front",
    });
  });

  it("位置は親の座標系の整数にし、上限に収める", () => {
    const node = newTextNode(doc, { kind: "node", id: "front" }, { x: 110.6, y: 99.2 }, null, "A");
    expect(node).toMatchObject({ x: 11, y: -1, fontFamily: "A", sizing: "auto-width" });
    const far = newTextNode(doc, page, { x: 5e6, y: -5e6 }, null, "A");
    expect(far).toMatchObject({ x: 1_000_000, y: -1_000_000 });
    // 縦にだけ引いた (幅が 1 未満の) ドラッグはクリックと同じ
    const thin = newTextNode(doc, page, { x: 5, y: 5 }, { x: 5.3, y: 80 }, "A");
    expect(thin).toMatchObject({ x: 5, y: 5, sizing: "auto-width", width: 0 });
  });
});
