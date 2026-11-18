import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetPathEditSession, setPenDrawing, setSelectedPoints } from "../../path/editSession";
import { editorStore } from "../../state/store";
import { PathEditOverlay } from "./PathEditOverlay";
import { PAGE_ID, pathEditDocument } from "./testing";

const state = () => editorStore.getState();

function renderOverlay() {
  return render(
    <svg>
      <PathEditOverlay />
    </svg>,
  );
}

beforeEach(() => {
  resetPathEditSession();
  state().load(pathEditDocument());
});

describe("点の編集の重ね描き", () => {
  it("編集中のパスの点を描き、選んだ点を区別する", () => {
    const { container } = renderOverlay();
    expect(container.querySelector("[data-path-edit-overlay]")).toBeNull();
    act(() => state().startPathEdit("sq"));
    expect(container.querySelectorAll("[data-path-edit-point]")).toHaveLength(4);
    act(() => setSelectedPoints(state().doc, "sq", [{ subpath: 0, index: 1 }]));
    expect(container.querySelectorAll('[data-path-edit-point="selected"]')).toHaveLength(1);
    expect(container.querySelectorAll("[data-path-edit-handle]")).toHaveLength(0);
  });

  it("ペンの最初の点と予定の線を描く", () => {
    const { container } = renderOverlay();
    act(() =>
      setPenDrawing({
        pathId: null,
        parent: { kind: "page", id: PAGE_ID },
        subpath: 0,
        end: "end",
        origin: { x: 10, y: 20, out: { x: 5, y: 0 } },
        created: "path",
        baseCount: 0,
        subpathCount: 0,
        commits: [],
        fromEdit: false,
        pointer: { x: 50, y: 20 },
      }),
    );
    expect(container.querySelector("[data-pen-preview]")?.getAttribute("d")).toBe(
      "M10 20C15 20 50 20 50 20",
    );
    expect(container.querySelectorAll("[data-path-edit-handle]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-path-edit-point]")).toHaveLength(1);
  });

  it("描いている輪郭の端の点から予定の線を引く (回転したパスもページ座標)", () => {
    const { container } = renderOverlay();
    act(() =>
      setPenDrawing({
        pathId: "open",
        parent: { kind: "page", id: PAGE_ID },
        subpath: 0,
        end: "end",
        origin: { x: 500, y: 100, out: null },
        created: null,
        baseCount: 3,
        subpathCount: 1,
        commits: [],
        fromEdit: false,
        pointer: { x: 700, y: 250 },
      }),
    );
    expect(container.querySelector("[data-pen-preview]")?.getAttribute("d")).toBe(
      "M600 200L700 250",
    );
    expect(container.querySelectorAll("[data-path-edit-point]")).toHaveLength(3);
  });
});
