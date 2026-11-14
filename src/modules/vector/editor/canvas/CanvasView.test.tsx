import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleDocument } from "../model/testing";
import { editorStore } from "../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../state/types";
import { isHandDragging } from "../tools/handTool";
import { TOOLS } from "../tools/registry";
import type { Tool } from "../tools/types";
import { CanvasView } from "./CanvasView";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const originalSelect = TOOLS.select;
let spy: {
  onPointerDown: ReturnType<typeof vi.fn>;
  onPointerMove: ReturnType<typeof vi.fn>;
  onPointerUp: ReturnType<typeof vi.fn>;
  onKeyDown: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  spy = {
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onKeyDown: vi.fn(() => false),
    onCancel: vi.fn(),
  };
  TOOLS.select = { id: "select", cursor: "default", ...spy } as Tool;
  const state = editorStore.getState();
  state.load(sampleDocument());
  state.setViewport({ x: 5, y: 5, zoom: 2 });
  state.setView(DEFAULT_VIEW_OPTIONS);
});

afterEach(() => {
  cleanup();
  TOOLS.select = originalSelect;
  vi.unstubAllGlobals();
});

function setup() {
  const view = render(<CanvasView />);
  const canvas = view.container.querySelector<HTMLElement>("[data-canvas-view]");
  if (!canvas) throw new Error("no canvas");
  return { ...view, canvas };
}

const pointer = (button = 0, x = 10, y = 20) => ({ pointerId: 1, button, clientX: x, clientY: y });

describe("ポインターをツールへ渡す", () => {
  it("押す・動かす・離すを、ページ座標に直して現在のツールへ渡す", () => {
    const { canvas } = setup();
    fireEvent.pointerDown(canvas, pointer(0, 10, 20));
    expect(spy.onPointerDown).toHaveBeenCalledTimes(1);
    const [down, ctx] = spy.onPointerDown.mock.calls[0]!;
    expect(down).toMatchObject({
      page: { x: 10, y: 15 },
      screen: { x: 10, y: 20 },
      button: 0,
      clickCount: 1,
    });
    expect(ctx.store).toBe(editorStore);

    fireEvent.pointerMove(canvas, pointer(0, 30, 40));
    expect(spy.onPointerMove.mock.calls[0]![0]).toMatchObject({
      page: { x: 20, y: 25 },
      button: 0,
      clickCount: 1,
    });
    fireEvent.pointerUp(canvas, pointer(0, 30, 40));
    expect(spy.onPointerUp).toHaveBeenCalledTimes(1);
  });

  it("ボタンを押していない移動も渡す (clickCount 0)", () => {
    const { canvas } = setup();
    fireEvent.pointerMove(canvas, pointer(0, 4, 6));
    expect(spy.onPointerMove.mock.calls[0]![0]).toMatchObject({
      page: { x: 7, y: 8 },
      clickCount: 0,
    });
  });

  it("続けて押すと clickCount 2", () => {
    const { canvas } = setup();
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(canvas, pointer());
      fireEvent.pointerUp(canvas, pointer());
    }
    expect(spy.onPointerDown.mock.calls.map((call) => call[0].clickCount)).toEqual([1, 2]);
  });

  it("ルーラーなど data-canvas-ignore の上は渡さない", () => {
    const { canvas } = setup();
    const ruler = canvas.querySelector("[data-canvas-ruler='x']");
    expect(ruler).not.toBeNull();
    fireEvent.pointerDown(ruler!, pointer());
    expect(spy.onPointerDown).not.toHaveBeenCalled();
  });

  it("カーソルはツールの cursor", () => {
    const { canvas } = setup();
    expect(canvas.style.cursor).toBe("default");
    act(() => editorStore.getState().setTool("rect"));
    expect(canvas.style.cursor).toBe("crosshair");
  });
});

describe("手のひら", () => {
  it("Space を押している間はどのツールでも手のひら", () => {
    const { canvas } = setup();
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    expect(canvas.style.cursor).toBe("grab");
    fireEvent.pointerDown(canvas, pointer(0, 100, 100));
    expect(canvas.style.cursor).toBe("grabbing");
    fireEvent.pointerMove(canvas, pointer(0, 120, 90));
    fireEvent.pointerUp(canvas, pointer(0, 120, 90));
    expect(spy.onPointerDown).not.toHaveBeenCalled();
    expect(spy.onPointerMove).not.toHaveBeenCalled();
    // 画面で (+20, -10) 動かす → 表示位置は (-10, +5) ページ px
    expect(editorStore.getState().viewport).toEqual({ x: -5, y: 10, zoom: 2 });
    act(() => {
      fireEvent.keyUp(window, { key: " ", code: "Space" });
    });
    expect(canvas.style.cursor).toBe("default");
  });

  it("中ボタンのドラッグは手のひら", () => {
    const { canvas } = setup();
    fireEvent.pointerDown(canvas, pointer(1, 100, 100));
    fireEvent.pointerMove(canvas, pointer(1, 80, 100));
    fireEvent.pointerUp(canvas, pointer(1, 80, 100));
    expect(spy.onPointerDown).not.toHaveBeenCalled();
    expect(editorStore.getState().viewport).toEqual({ x: 15, y: 5, zoom: 2 });
  });

  it("手のひらツール", () => {
    const { canvas } = setup();
    act(() => editorStore.getState().setTool("hand"));
    fireEvent.pointerDown(canvas, pointer(0, 0, 0));
    fireEvent.pointerMove(canvas, pointer(0, 0, 40));
    fireEvent.pointerUp(canvas, pointer(0, 0, 40));
    expect(editorStore.getState().viewport).toEqual({ x: 5, y: -15, zoom: 2 });
  });
});

describe("キー", () => {
  it("文字キーでツールを切り替え、前のツールの onCancel を呼ぶ", () => {
    setup();
    fireEvent.keyDown(document.body, { key: "r", code: "KeyR" });
    expect(editorStore.getState().toolId).toBe("rect");
    expect(spy.onCancel).toHaveBeenCalledTimes(1);
  });

  it("入力欄にフォーカスがある間はショートカットもツールの onKeyDown も効かない", () => {
    setup();
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "r", code: "KeyR" });
    fireEvent.keyDown(input, { key: "R", code: "KeyR", shiftKey: true });
    expect(editorStore.getState().toolId).toBe("select");
    expect(editorStore.getState().view.rulers).toBe(true);
    expect(spy.onKeyDown).not.toHaveBeenCalled();
    input.remove();
  });

  it("日本語入力の変換中は効かない", () => {
    setup();
    fireEvent.keyDown(document.body, { key: "r", code: "KeyR", isComposing: true });
    fireEvent.keyDown(document.body, { key: "Process", code: "KeyR", keyCode: 229 });
    expect(editorStore.getState().toolId).toBe("select");
  });

  it("ツールの onKeyDown が処理したら、共通のショートカットへ回さない", () => {
    setup();
    spy.onKeyDown.mockReturnValue(true);
    fireEvent.keyDown(document.body, { key: "r", code: "KeyR" });
    expect(spy.onKeyDown.mock.calls[0]![0]).toMatchObject({ key: "r", mod: false, repeat: false });
    expect(editorStore.getState().toolId).toBe("select");
  });

  it("ドラッグ中の Esc は onCancel を呼び、その後の離すを渡さない", () => {
    const { canvas } = setup();
    fireEvent.pointerDown(canvas, pointer());
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(spy.onCancel).toHaveBeenCalledTimes(1);
    expect(spy.onKeyDown).not.toHaveBeenCalled();
    fireEvent.pointerUp(canvas, pointer());
    expect(spy.onPointerUp).not.toHaveBeenCalled();
  });

  it("ジェスチャーの途中の Esc は、ツールが取り消さなくても文書を戻す", () => {
    setup();
    const before = editorStore.getState().doc;
    act(() => {
      editorStore.getState().beginGesture();
      editorStore.getState().updateGesture((doc) => ({ ...doc }));
    });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(editorStore.getState().gestureActive).toBe(false);
    expect(editorStore.getState().doc).toBe(before);
  });

  it("ウィンドウのフォーカス喪失で onCancel", () => {
    setup();
    fireEvent.blur(window);
    expect(spy.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ホイール", () => {
  it("ホイールでスクロール、Cmd/Ctrl かピンチ (ctrlKey) でズーム", () => {
    const { canvas } = setup();
    fireEvent.wheel(canvas, { deltaX: 0, deltaY: 40 });
    expect(editorStore.getState().viewport).toEqual({ x: 5, y: 25, zoom: 2 });
    fireEvent.wheel(canvas, { deltaY: -10, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(editorStore.getState().viewport.zoom).toBeGreaterThan(2);
    expect(editorStore.getState().viewport.x).toBeCloseTo(5);
  });
});

describe("層", () => {
  it("文書の SVG と重ね描きの SVG を分け、view.rulers でルーラーを出し入れする", () => {
    const { canvas } = setup();
    expect(canvas.querySelector("[data-canvas-document]")).not.toBeNull();
    expect(canvas.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
    expect(canvas.querySelector("[data-canvas-ruler]")).not.toBeNull();
    act(() => editorStore.getState().setView({ rulers: false }));
    expect(canvas.querySelector("[data-canvas-ruler]")).toBeNull();
  });
});

describe("キーを取る範囲 (§4.4)", () => {
  function setupInEditor() {
    const view = render(
      <>
        <button type="button" data-testid="outside">
          外
        </button>
        <div data-canvas-editor="">
          <button type="button" data-testid="inside">
            中
          </button>
          <input data-testid="field" />
          <CanvasView />
        </div>
      </>,
    );
    const canvas = view.container.querySelector<HTMLElement>("[data-canvas-view]")!;
    return { ...view, canvas };
  }

  it("エディタの外のボタンにフォーカスがある間は、Space・Esc・文字キーを取らない", () => {
    const { getByTestId, canvas } = setupInEditor();
    const outside = getByTestId("outside");
    outside.focus();
    const space = fireEvent.keyDown(outside, { key: " ", code: "Space" });
    expect(space).toBe(true); // preventDefault していない (ボタンが Space で押せる)
    expect(canvas.style.cursor).toBe("default");
    fireEvent.keyDown(outside, { key: "r", code: "KeyR" });
    fireEvent.keyDown(outside, { key: "Escape", code: "Escape" });
    expect(editorStore.getState().toolId).toBe("select");
    expect(spy.onKeyDown).not.toHaveBeenCalled();
  });

  it("モーダルが開いている間は、フォーカスがどこにあっても何も取らない", () => {
    setupInEditor();
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    fireEvent.keyDown(document.body, { key: "r", code: "KeyR" });
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(editorStore.getState().toolId).toBe("select");
    expect(spy.onKeyDown).not.toHaveBeenCalled();
    modal.remove();
  });

  it("エディタの中のボタンでは Space・Enter・矢印を部品に任せ、ほかのショートカットは効かせる", () => {
    const { getByTestId, canvas } = setupInEditor();
    const inside = getByTestId("inside");
    inside.focus();
    expect(fireEvent.keyDown(inside, { key: " ", code: "Space" })).toBe(true);
    expect(canvas.style.cursor).toBe("default");
    fireEvent.keyDown(inside, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(inside, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(spy.onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(inside, { key: "r", code: "KeyR" });
    expect(editorStore.getState().toolId).toBe("rect");
  });

  it("フォーカスがどこにもない (body) ときは効く", () => {
    setupInEditor();
    fireEvent.keyDown(document.body, { key: "r", code: "KeyR" });
    expect(editorStore.getState().toolId).toBe("rect");
  });

  it("入力欄にフォーカスがあってキャンバスを押したら、先に確定 (blur) させてからツールへ渡し、フォーカスをキャンバスへ移す", () => {
    const { getByTestId, canvas } = setupInEditor();
    const field = getByTestId("field");
    const order: string[] = [];
    field.addEventListener("blur", () => order.push("blur"));
    spy.onPointerDown.mockImplementation(() => order.push("tool"));
    field.focus();
    fireEvent.pointerDown(canvas, pointer());
    expect(order).toEqual(["blur", "tool"]);
    expect(document.activeElement).toBe(canvas);
  });
});

describe("カーソルの上書き (ToolContext.setCursor)", () => {
  it("上書きがあればそれを、null ならツールの cursor。ツールの切替と onCancel で戻す", () => {
    const { canvas } = setup();
    spy.onPointerMove.mockImplementation((_, ctx) => ctx.setCursor("nwse-resize"));
    fireEvent.pointerMove(canvas, pointer());
    expect(canvas.style.cursor).toBe("nwse-resize");
    act(() => spy.onPointerMove.mock.calls[0]![1].setCursor(null));
    expect(canvas.style.cursor).toBe("default");

    // ドラッグ中の Esc (onCancel) で戻す
    fireEvent.pointerMove(canvas, pointer());
    fireEvent.pointerDown(canvas, pointer());
    expect(canvas.style.cursor).toBe("nwse-resize");
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(canvas.style.cursor).toBe("default");

    // ツールの切替で戻す
    fireEvent.pointerMove(canvas, pointer());
    expect(canvas.style.cursor).toBe("nwse-resize");
    act(() => editorStore.getState().setTool("rect"));
    act(() => editorStore.getState().setTool("select"));
    expect(canvas.style.cursor).toBe("default");
  });
});

describe("Space と修飾キー", () => {
  it("Cmd/Ctrl と一緒の Space では手のひらに入らない", () => {
    const { canvas } = setup();
    fireEvent.keyDown(document.body, { key: " ", code: "Space", metaKey: true });
    fireEvent.keyDown(document.body, { key: " ", code: "Space", ctrlKey: true });
    expect(canvas.style.cursor).toBe("default");
  });

  it("Space の keyup が来なくても、Cmd / Ctrl を離したら解除する", () => {
    const { canvas } = setup();
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(canvas.style.cursor).toBe("grab");
    fireEvent.keyUp(document.body, { key: "Meta", code: "MetaLeft" });
    expect(canvas.style.cursor).toBe("default");
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    fireEvent.keyUp(document.body, { key: "Control", code: "ControlLeft" });
    expect(canvas.style.cursor).toBe("default");
  });
});

describe("ドラッグ中のホイール", () => {
  it("今の位置での移動をツールへ渡し、直前の修飾キーを保つ", () => {
    const { canvas } = setup();
    fireEvent.pointerDown(canvas, { ...pointer(0, 10, 20), shiftKey: true, altKey: true });
    fireEvent.wheel(canvas, { deltaY: 40 });
    const calls = spy.onPointerMove.mock.calls;
    const last = calls[calls.length - 1]![0];
    expect(last).toMatchObject({ shift: true, alt: true, button: 0, clickCount: 1 });
    // 表示位置が 20 ページ px 下へ動いたので、同じ画面位置のページ座標も 20 下がる
    expect(last.page).toEqual({ x: 10, y: 35 });
  });

  it("手のひらのドラッグは、途中のホイールによる表示位置の変化を打ち消さない", () => {
    const { canvas } = setup();
    act(() => editorStore.getState().setTool("hand"));
    fireEvent.pointerDown(canvas, pointer(0, 100, 100));
    fireEvent.wheel(canvas, { deltaY: 40 }); // y += 20
    fireEvent.pointerMove(canvas, pointer(0, 100, 90)); // 画面で 10 上へ → y += 5
    fireEvent.pointerUp(canvas, pointer(0, 100, 90));
    expect(editorStore.getState().viewport).toEqual({ x: 5, y: 30, zoom: 2 });
  });
});

describe("何もしていないときの Esc と、画面から外れるとき", () => {
  it("何もしていないときの Esc は onKeyDown に渡すだけで、onCancel は呼ばない", () => {
    setup();
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(spy.onKeyDown).toHaveBeenCalledTimes(1);
    expect(spy.onKeyDown.mock.calls[0]![0]).toMatchObject({ key: "Escape" });
    expect(spy.onCancel).not.toHaveBeenCalled();
  });

  it("ドラッグ中に画面から外れたら onCancel を呼び、ジェスチャーも取り消す", () => {
    const { canvas, unmount } = setup();
    const before = editorStore.getState().doc;
    spy.onPointerDown.mockImplementation((_, ctx) => {
      ctx.store.getState().beginGesture();
      ctx.store.getState().updateGesture((doc: typeof before) => ({ ...doc }));
    });
    fireEvent.pointerDown(canvas, pointer());
    expect(editorStore.getState().gestureActive).toBe(true);
    unmount();
    expect(spy.onCancel).toHaveBeenCalled();
    expect(editorStore.getState().gestureActive).toBe(false);
    expect(editorStore.getState().doc).toBe(before);
  });

  it("手のひらのドラッグ中に画面から外れたら、手のひらの状態も片付ける", () => {
    const { canvas, unmount } = setup();
    act(() => editorStore.getState().setTool("hand"));
    fireEvent.pointerDown(canvas, pointer());
    expect(isHandDragging()).toBe(true);
    unmount();
    expect(isHandDragging()).toBe(false);
  });
});
