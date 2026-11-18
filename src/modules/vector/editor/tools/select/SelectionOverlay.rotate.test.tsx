/**
 * 回転した選択枠と角度の表示 (§8.5.3)。回転していない文書の表示は SelectionOverlay.test.tsx。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBoolean,
  createFrame,
  createLine,
  createPath,
  createRect,
  solidPaint,
} from "../../model/create";
import { deepFreeze } from "../../model/testing";
import type { CanvasDocument, CanvasNode } from "../../model/types";
import { editorStore } from "../../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../../state/types";
import { resetSelectOverlay, setSelectOverlay } from "./overlayState";
import { SelectionOverlay, SelectionScreenLabels } from "./SelectionOverlay";

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return deepFreeze({
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  });
}

beforeEach(() => {
  const doc = docOf(
    [
      createRect({ id: "r", x: 100, y: 100, width: 100, height: 50, rotation: 30 }),
      createFrame({
        id: "f",
        x: 400,
        y: 100,
        width: 200,
        height: 200,
        rotation: 90,
        children: ["c", "ln"],
      }),
      createRect({ id: "c", x: 20, y: 20, width: 40, height: 20 }),
      createLine({ id: "ln", x1: 10, y1: 150, x2: 90, y2: 150 }),
      createRect({ id: "a", x: 0, y: 400, width: 50, height: 50 }),
      createPath(
        [
          {
            closed: true,
            points: [
              { x: 0, y: 0, in: null, out: null, mirror: "none" },
              { x: 40, y: 0, in: null, out: null, mirror: "none" },
              { x: 0, y: 40, in: null, out: null, mirror: "none" },
            ],
          },
        ],
        { id: "p", x: 300, y: 400 },
      ),
      createBoolean("union", ["u1"], { id: "u", fill: solidPaint("#000000") }),
      createRect({ id: "u1", x: 500, y: 400, width: 30, height: 30 }),
    ],
    ["r", "f", "a", "p", "u"],
  );
  editorStore.getState().load(doc);
  editorStore.getState().setViewport({ x: 0, y: 0, zoom: 1 });
  editorStore.getState().setView(DEFAULT_VIEW_OPTIONS);
  editorStore.getState().setTool("select");
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

const handles = (container: HTMLElement) => [...container.querySelectorAll("[data-canvas-handle]")];

describe("回転した選択枠", () => {
  it("1 個の回転したノードは、回転した箱に沿った枠とハンドル", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setSelection(["r"]));
    const box = container.querySelector("[data-canvas-selection-box]");
    expect(box?.getAttribute("data-canvas-selection-box")).toBe("rotated");
    expect(box?.getAttribute("width")).toBe("100");
    expect(box?.getAttribute("transform")).toMatch(/^matrix\(/);
    // 8 個のハンドルを枠の向きに回す
    expect(handles(container)).toHaveLength(8);
    expect(handles(container)[0]?.getAttribute("transform")).toMatch(/^rotate\(30 /);
  });

  it("回転した frame の中のノードは、frame の向きの枠", () => {
    const { container } = renderOverlay();
    act(() => {
      editorStore.getState().setScope("f");
      editorStore.getState().setSelection(["c"]);
    });
    const box = container.querySelector("[data-canvas-selection-box]");
    expect(box?.getAttribute("data-canvas-selection-box")).toBe("rotated");
    expect(handles(container)[0]?.getAttribute("transform")).toMatch(/^rotate\(90 /);
  });

  it("複数選択は軸に平行な外接矩形 (回転したノードの枠は回した箱)", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setSelection(["r", "a"]));
    const box = container.querySelector("[data-canvas-selection-box]");
    expect(box?.getAttribute("data-canvas-selection-box")).toBe("");
    expect(box?.getAttribute("transform")).toBeNull();
    // ノードの枠: 回転した r は行列を掛け、回転していない a はページ座標のまま
    const outlines = [...container.querySelectorAll("[data-canvas-selection] > rect")].filter(
      (el) =>
        !el.hasAttribute("data-canvas-selection-box") && !el.hasAttribute("data-canvas-handle"),
    );
    expect(outlines.map((el) => el.getAttribute("transform") !== null)).toEqual([true, false]);
    expect(handles(container).every((el) => el.getAttribute("transform") === null)).toBe(true);
  });

  it("回転した frame の中の線の端点は、frame の向きで写した位置", () => {
    const { container } = renderOverlay();
    act(() => {
      editorStore.getState().setScope("f");
      editorStore.getState().setSelection(["ln"]);
    });
    const line = container.querySelector("[data-canvas-selection] line");
    // frame (400, 100, 200×200) を中心 (500, 200) のまわりに 90°: (10, 150) → (450, 110)
    expect(Number(line?.getAttribute("x1"))).toBeCloseTo(450, 9);
    expect(Number(line?.getAttribute("y1"))).toBeCloseTo(110, 9);
    expect(handles(container)).toHaveLength(2);
  });

  it("パスとブーリアンの枠は形の輪郭", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setSelection(["p"]));
    expect(container.querySelector("[data-canvas-selection] > path")?.getAttribute("d")).toBe(
      "M0 0 L40 0 L0 40 L0 0 Z",
    );
    act(() => editorStore.getState().setSelection(["u"]));
    expect(container.querySelector("[data-canvas-selection] > path")).not.toBeNull();
    act(() => {
      editorStore.getState().setSelection([]);
      editorStore.getState().setHovered("p");
    });
    expect(container.querySelector("[data-canvas-hover] path")).not.toBeNull();
  });
});

describe("点の編集中のパス", () => {
  it("枠もハンドルも出さない (輪郭と点はツールの重ね描き)。終えたら戻る", () => {
    const { container } = renderOverlay();
    act(() => editorStore.getState().setSelection(["p"]));
    expect(container.querySelector("[data-canvas-selection-box]")).not.toBeNull();
    act(() => editorStore.getState().startPathEdit("p"));
    expect(editorStore.getState().editingPathId).toBe("p");
    expect(container.querySelector("[data-canvas-selection]")).toBeNull();
    expect(handles(container)).toHaveLength(0);
    act(() => editorStore.getState().endPathEdit());
    expect(container.querySelector("[data-canvas-selection-box]")).not.toBeNull();
  });
});

describe("回転の角度の表示", () => {
  it("ドラッグの間だけ、ポインターの右下に画面座標で出す", () => {
    const viewport = { x: 50, y: 20, zoom: 2 };
    const { container } = render(
      <svg>
        <SelectionScreenLabels viewport={viewport} />
      </svg>,
    );
    expect(container.querySelector("[data-canvas-rotation-label]")).toBeNull();
    act(() => setSelectOverlay({ angle: { value: -12.5, at: { x: 100, y: 70 } } }));
    const label = container.querySelector("[data-canvas-rotation-label]");
    expect(label?.textContent).toBe("-12.5°");
    // ページ (100, 70) → 画面 (100, 100)。そこから (14, 18)
    expect(label?.querySelector("rect")?.getAttribute("x")).toBe("114");
    expect(label?.querySelector("rect")?.getAttribute("y")).toBe("118");
    act(() => resetSelectOverlay());
    expect(container.querySelector("[data-canvas-rotation-label]")).toBeNull();
  });
});
