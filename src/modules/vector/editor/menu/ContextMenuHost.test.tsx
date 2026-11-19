/**
 * 右クリックのメニュー (§5.8) を、本物の `CanvasView` とレイヤーパネルを通して確かめる。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasView } from "../canvas/CanvasView";
import { createPath, createRect, createText } from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { getPathEditSnapshot, resetPathEditSession } from "../path/editSession";
import { LayersPanel } from "../panels/LayersPanel";
import { editorStore } from "../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../state/types";
import { square } from "../tools/pathEdit/testing";
import { closeContextMenu } from "./contextMenu";
import { ContextMenuHost } from "./ContextMenuHost";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const state = () => editorStore.getState();

/** a・b: 矩形、p: パス、t: テキスト (ページ直下)。表示位置は (0, 0)、100%。 */
function menuDocument(): CanvasDocument {
  const nodes: CanvasNode[] = [
    createRect({ id: "a", x: 0, y: 0, width: 20, height: 20 }),
    createRect({ id: "b", x: 30, y: 0, width: 20, height: 20 }),
    createPath([square(20)], { id: "p", x: 0, y: 100 }),
    createText({ id: "t", text: "abc", x: 0, y: 200, width: 30, height: 23 }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["a", "b", "p", "t"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  state().load(menuDocument());
  state().setViewport({ x: 0, y: 0, zoom: 1 });
  state().setView({ ...DEFAULT_VIEW_OPTIONS, rulers: false });
});

afterEach(() => {
  act(() => closeContextMenu());
  cleanup();
  resetPathEditSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setupCanvas() {
  const view = render(
    <div data-canvas-editor="" className="relative">
      <CanvasView />
      <ContextMenuHost />
    </div>,
  );
  const canvas = view.container.querySelector<HTMLElement>("[data-canvas-view]");
  if (!canvas) throw new Error("no canvas");
  return { ...view, canvas };
}

const menu = () => screen.queryByRole("menu");
const menuItem = (name: string) => screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });
const at = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  clientX: x,
  clientY: y,
  ...extra,
});

describe("キャンバスの右クリック", () => {
  it("ノードの上で開き、そのノードを先に選ぶ。OS のメニューは出さない", () => {
    const { canvas } = setupCanvas();
    expect(fireEvent.contextMenu(canvas, at(10, 10))).toBe(false);
    expect(screen.getByRole("menu", { name: "選択のメニュー" })).toHaveFocus();
    expect(state().selection).toEqual(["a"]);
    expect(menuItem("削除")).not.toHaveAttribute("aria-disabled");
  });

  it("選んだ複数の上では選択を変えない。何もない所では選択を外し、貼り付けとすべて選択を出す", () => {
    const { canvas } = setupCanvas();
    act(() => state().setSelection(["a", "b"]));
    fireEvent.contextMenu(canvas, at(40, 10));
    expect(state().selection).toEqual(["a", "b"]);
    expect(menuItem("合体")).not.toHaveAttribute("aria-disabled");

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 2, ...at(500, 500) });
    fireEvent.contextMenu(canvas, at(500, 500));
    expect(state().selection).toEqual([]);
    expect(screen.getByRole("menu", { name: "キャンバスのメニュー" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "貼り付けCtrl+V",
      "すべて選択Ctrl+A",
    ]);
  });

  it("開いている間はキャンバスのショートカットを効かせない。↓ と Enter で選び、Esc で閉じてキャンバスへ戻る", () => {
    const { canvas } = setupCanvas();
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 2, ...at(10, 10) });
    fireEvent.contextMenu(canvas, at(10, 10));
    fireEvent.keyDown(document.activeElement!, { key: "r" });
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    expect(state().toolId).toBe("select");
    expect(state().doc.nodes.a).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(canvas).toHaveFocus();
    expect(state().selection).toEqual(["a"]);

    fireEvent.contextMenu(canvas, at(10, 10));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(menuItem("切り取り")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(menuItem("上下反転")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(menu()).toBeNull();
    expect(state().revision).toBe(1);
    expect(canvas).toHaveFocus();
  });

  it("項目を押すとショートカットと同じ動作をして閉じる (削除は履歴 1 件)", () => {
    const { canvas } = setupCanvas();
    fireEvent.contextMenu(canvas, at(10, 10));
    fireEvent.click(menuItem("削除"));
    expect(menu()).toBeNull();
    expect(state().doc.nodes.a).toBeUndefined();
    expect(state().revision).toBe(1);
  });

  it("外を押す・ホイール・表示位置の変化・ウィンドウのフォーカス喪失で閉じる", () => {
    const { canvas } = setupCanvas();
    const open = () => fireEvent.contextMenu(canvas, at(10, 10));
    open();
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...at(500, 500) });
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, ...at(500, 500) });
    expect(menu()).toBeNull();
    open();
    fireEvent.wheel(canvas, { deltaY: 10 });
    expect(menu()).toBeNull();
    open();
    act(() => state().setViewport({ x: 1, y: 1, zoom: 1 }));
    expect(menu()).toBeNull();
    open();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(menu()).toBeNull();
  });

  it("キーボード (Menu キー / Shift+F10) で開いたときは選択を変えない", () => {
    const { canvas } = setupCanvas();
    act(() => state().setSelection(["a"]));
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "ContextMenu" });
    fireEvent.contextMenu(canvas, at(500, 500));
    expect(state().selection).toEqual(["a"]);
    expect(screen.getByRole("menu", { name: "選択のメニュー" })).toBeInTheDocument();
    act(() => closeContextMenu());
    fireEvent.keyDown(canvas, { key: "F10", shiftKey: true });
    fireEvent.contextMenu(canvas, at(500, 500));
    expect(state().selection).toEqual(["a"]);
    act(() => closeContextMenu());
    // マウスの右クリックでは押した位置で選び直す
    fireEvent.contextMenu(canvas, at(500, 500));
    expect(state().selection).toEqual([]);
  });

  it("要素のスクロール (選んだ行をレイヤーパネルが見せるときなど) では閉じない", () => {
    const { canvas } = setupCanvas();
    fireEvent.contextMenu(canvas, at(10, 10));
    fireEvent.scroll(canvas);
    fireEvent.scroll(document);
    expect(menu()).not.toBeNull();
  });

  it("右ボタンの押下では移動・範囲選択・ペンの点・手のひらを始めない", () => {
    const { canvas } = setupCanvas();
    act(() => state().setSelection(["a"]));
    const doc = state().doc;
    const drag = (x0: number, y0: number, x1: number, y1: number) => {
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 2, ...at(x0, y0) });
      fireEvent.pointerMove(canvas, { pointerId: 1, button: 2, buttons: 2, ...at(x1, y1) });
      fireEvent.pointerUp(canvas, { pointerId: 1, button: 2, ...at(x1, y1) });
    };
    drag(10, 10, 80, 80);
    expect(state().doc).toBe(doc);
    expect(state().selection).toEqual(["a"]);
    drag(400, 400, 600, 600);
    expect(state().selection).toEqual(["a"]);

    act(() => state().setTool("pen"));
    drag(300, 300, 320, 320);
    expect(getPathEditSnapshot().pen).toBeNull();
    expect(state().doc).toBe(doc);

    act(() => state().setTool("hand"));
    drag(300, 300, 400, 400);
    expect(state().viewport).toEqual({ x: 0, y: 0, zoom: 1 });

    act(() => state().setTool("rect"));
    drag(300, 300, 400, 400);
    expect(state().doc).toBe(doc);
  });

  it("ドラッグの途中、点の編集中、本文の編集中は出さない。本文の編集欄では OS のメニューを残す", () => {
    const { canvas } = setupCanvas();
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...at(10, 10) });
    expect(fireEvent.contextMenu(canvas, at(10, 10))).toBe(false);
    expect(menu()).toBeNull();
    fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, ...at(10, 10) });

    act(() => state().startPathEdit("p"));
    fireEvent.contextMenu(canvas, at(10, 110));
    expect(menu()).toBeNull();
    act(() => state().endPathEdit());

    act(() => state().startTextEdit("t"));
    const textarea = document.querySelector<HTMLTextAreaElement>("[data-canvas-text-editor]");
    expect(textarea).not.toBeNull();
    expect(fireEvent.contextMenu(textarea!, at(5, 205))).toBe(true);
    expect(fireEvent.contextMenu(canvas, at(10, 10))).toBe(false);
    expect(menu()).toBeNull();
    expect(state().editingTextId).toBe("t");
  });

  it("画面の端では内側に収まるよう位置を直す。UI の倍率 (CSS zoom) の下でも押した位置に出す", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute("role") === "menu" ? 200 : 800;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute("role") === "menu" ? 300 : 600;
    });
    const { canvas } = setupCanvas();
    fireEvent.contextMenu(canvas, at(750, 500));
    expect(menu()).toHaveStyle({ left: "550px", top: "200px" });
    act(() => closeContextMenu());

    // 見た目の大きさが CSS の 1.25 倍 (UI の倍率 125%)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return { left: 0, top: 0, width: 1000, height: 750, right: 1000, bottom: 750 } as DOMRect;
    });
    fireEvent.contextMenu(canvas, at(500, 250));
    expect(menu()).toHaveStyle({ left: "400px", top: "200px" });
  });
});

describe("レイヤーパネルの行の右クリック", () => {
  function setupLayers() {
    render(
      <div data-canvas-editor="" className="relative">
        <LayersPanel />
        <ContextMenuHost />
      </div>,
    );
  }
  const row = (id: string) => {
    const found = screen.getAllByRole("treeitem").find((el) => el.dataset.layerId === id);
    if (!found) throw new Error(`row not found: ${id}`);
    return found;
  };

  it("選んでいない行なら先にその行を選び、選んでいる行なら選択を変えない", () => {
    setupLayers();
    act(() => state().setSelection(["a"]));
    expect(fireEvent.contextMenu(row("b"), at(10, 10))).toBe(false);
    expect(state().selection).toEqual(["b"]);
    expect(screen.getByRole("menu", { name: "選択のメニュー" })).toBeInTheDocument();
    act(() => closeContextMenu());

    act(() => state().setSelection(["a", "b"]));
    fireEvent.contextMenu(row("a"), at(10, 10));
    expect(state().selection).toEqual(["a", "b"]);
    expect(menuItem("合体")).not.toHaveAttribute("aria-disabled");
    fireEvent.click(menuItem("合体"));
    expect(state().doc.nodes[state().selection[0]!]?.type).toBe("boolean");
  });

  it("行のない所では選択を外して何もない所のメニュー。名前の欄では OS のメニューを残す", () => {
    setupLayers();
    act(() => state().setSelection(["a"]));
    fireEvent.contextMenu(screen.getByRole("tree"), at(10, 300));
    expect(state().selection).toEqual([]);
    expect(screen.getByRole("menu", { name: "キャンバスのメニュー" })).toBeInTheDocument();
    act(() => closeContextMenu());

    fireEvent.doubleClick(row("b"));
    const input = screen.getByRole("textbox", { name: "レイヤーの名前" });
    expect(fireEvent.contextMenu(input, at(10, 10))).toBe(true);
    expect(menu()).toBeNull();
  });

  it("点の編集中は出さない", () => {
    setupLayers();
    act(() => state().startPathEdit("p"));
    expect(fireEvent.contextMenu(row("a"), at(10, 10))).toBe(false);
    expect(menu()).toBeNull();
    expect(state().editingPathId).toBe("p");
  });
});
