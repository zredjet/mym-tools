import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rulers } from "../../canvas/Rulers";
import { createText } from "../../model/create";
import { insertNode } from "../../model/structure";
import { sampleDocument } from "../../model/testing";
import { editorStore } from "../../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../../state/types";
import { resetSelectOverlay, setSelectOverlay } from "./overlayState";
import { SelectionOverlay } from "./SelectionOverlay";

beforeEach(() => {
  const doc = insertNode(
    sampleDocument(),
    createText({ id: "t", x: 0, y: 400, width: 60, height: 20, text: "a" }),
    {
      kind: "page",
      id: "p1",
    },
  );
  editorStore.getState().load(doc);
  editorStore.getState().setViewport({ x: 0, y: 0, zoom: 1 });
  editorStore.getState().setView(DEFAULT_VIEW_OPTIONS);
  resetSelectOverlay();
});

afterEach(() => {
  cleanup();
  resetSelectOverlay();
});

function renderOverlay() {
  return render(
    <svg>
      <SelectionOverlay />
    </svg>,
  );
}

const handles = (container: HTMLElement) => container.querySelectorAll("[data-canvas-handle]");

describe("SelectionOverlay", () => {
  it("選択がなければ何も描かない", () => {
    const { container } = renderOverlay();
    expect(container.querySelector("[data-canvas-selection]")).toBeNull();
  });

  it("選択の枠と 8 個のハンドル (小さいときは辺の中央を省く)", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setSelection(["f2"]));
    expect(handles(container)).toHaveLength(8);
    act(() => editorStore.getState().setSelection(["r1"])); // 20×20
    expect(handles(container)).toHaveLength(4);
    act(() => editorStore.getState().setViewport({ x: 0, y: 0, zoom: 2 }));
    expect(handles(container)).toHaveLength(8);
    // ハンドルの大きさは画面 px で一定 (8 / zoom)
    expect(handles(container)[0]?.getAttribute("width")).toBe("4");
  });

  it("線を 1 本だけ選んだときは始点と終点の 2 個", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setSelection(["l1"]));
    expect(handles(container)).toHaveLength(2);
    expect(container.querySelector("[data-canvas-selection] line")).not.toBeNull();
  });

  it("本文の編集中のテキストにはハンドルを出さない", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setSelection(["t"]));
    expect(handles(container).length).toBeGreaterThan(0);
    act(() => editorStore.getState().startTextEdit("t"));
    expect(handles(container)).toHaveLength(0);
    expect(container.querySelector("[data-canvas-selection] rect")).not.toBeNull();
  });

  it("ロック中のノードは枠だけ (ハンドルなし)。選択ツール以外ではハンドルを出さない", () => {
    const { container } = renderOverlay();
    act(() => {
      editorStore.getState().apply((doc) => ({
        ...doc,
        nodes: { ...doc.nodes, r0: { ...doc.nodes.r0!, locked: true } },
      }));
      editorStore.getState().setSelection(["r0"]);
    });
    expect(container.querySelector("[data-canvas-selection]")).not.toBeNull();
    expect(handles(container)).toHaveLength(0);
    act(() => {
      editorStore.getState().setSelection(["f2"]);
      editorStore.getState().setTool("rect");
    });
    expect(handles(container)).toHaveLength(0);
    expect(container.querySelector("[data-canvas-selection-box]")).not.toBeNull();
  });

  it("ホバーの枠 (選択していないノードだけ)", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setHovered("r1"));
    expect(container.querySelector("[data-canvas-hover]")).not.toBeNull();
    act(() => editorStore.getState().setSelection(["r1"]));
    expect(container.querySelector("[data-canvas-hover]")).toBeNull();
  });

  it("範囲選択の矩形とスマートガイド", () => {
    const { container } = renderOverlay();
    act(() =>
      setSelectOverlay({
        marquee: { x: 0, y: 0, width: 10, height: 10 },
        guides: [{ axis: "x", pos: 5, start: 0, end: 100 }],
      }),
    );
    expect(container.querySelector("[data-canvas-marquee]")).not.toBeNull();
    expect(container.querySelector("[data-canvas-smart-guide='x']")?.getAttribute("y2")).toBe(
      "100",
    );
    act(() => resetSelectOverlay());
    expect(container.querySelector("[data-canvas-drag-feedback]")).toBeNull();
  });
});

describe("ルーラーからガイド線を引き出す", () => {
  const guides = () => editorStore.getState().doc.pages[0]!.guides;
  const pointer = (x: number, y: number) => ({ pointerId: 3, button: 0, clientX: x, clientY: y });

  it("上のルーラーから引き出すと横のガイド線、ルーラーの上で離すと作らない", () => {
    const { container } = render(<Rulers size={{ width: 800, height: 600 }} />);
    const top = container.querySelector("[data-canvas-ruler='x']")!;
    fireEvent.pointerDown(top, pointer(100, 10));
    fireEvent.pointerMove(top, pointer(100, 15));
    expect(guides()).toEqual([]);
    fireEvent.pointerMove(top, pointer(100, 80));
    expect(guides()).toEqual([{ axis: "y", position: 80 }]);
    fireEvent.pointerUp(top, pointer(100, 120));
    expect(guides()).toEqual([{ axis: "y", position: 120 }]);
    expect(editorStore.getState()).toMatchObject({ revision: 1, gestureActive: false });

    const left = container.querySelector("[data-canvas-ruler='y']")!;
    fireEvent.pointerDown(left, pointer(10, 300));
    fireEvent.pointerMove(left, pointer(60, 300));
    fireEvent.pointerUp(left, pointer(5, 300));
    expect(guides()).toEqual([{ axis: "y", position: 120 }]);
    expect(editorStore.getState().revision).toBe(1);
  });

  it("途中で取り消されたら (Esc など) 作らない", () => {
    const { container } = render(<Rulers size={{ width: 800, height: 600 }} />);
    const left = container.querySelector("[data-canvas-ruler='y']")!;
    fireEvent.pointerDown(left, pointer(10, 300));
    fireEvent.pointerMove(left, pointer(60, 300));
    expect(guides()).toEqual([{ axis: "x", position: 60 }]);
    act(() => editorStore.getState().cancelGesture());
    fireEvent.pointerMove(left, pointer(90, 300));
    fireEvent.pointerUp(left, pointer(90, 300));
    expect(guides()).toEqual([]);
    expect(editorStore.getState().revision).toBe(0);
  });

  it("主ボタン以外では引き出さない", () => {
    const { container } = render(<Rulers size={{ width: 800, height: 600 }} />);
    fireEvent.pointerDown(container.querySelector("[data-canvas-ruler='x']")!, {
      ...pointer(100, 10),
      button: 2,
    });
    expect(editorStore.getState().gestureActive).toBe(false);
  });
});
