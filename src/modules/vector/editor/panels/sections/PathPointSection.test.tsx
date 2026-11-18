import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { applyToPoint } from "../../geometry/matrix";
import { getNode } from "../../model/tree";
import type { PathNode } from "../../model/types";
import { resetPathEditSession, selectedPoints, setSelectedPoints } from "../../path/editSession";
import { editorStore } from "../../state/store";
import { pageGeometry, pullHandles, withSubpaths } from "../../tools/pathEdit/ops";
import { pathEditDocument } from "../../tools/pathEdit/testing";
import { PathPointSection } from "./PathPointSection";

const state = () => editorStore.getState();
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const type = (input: HTMLElement, value: string) => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};
const selectPoints = (id: string, ...indices: number[]) =>
  act(() =>
    setSelectedPoints(
      state().doc,
      id,
      indices.map((index) => ({ subpath: 0, index })),
    ),
  );

beforeEach(() => {
  resetPathEditSession();
  state().load(pathEditDocument());
});

describe("点の節", () => {
  it("点の編集中に点を選んでいるときだけ出す", () => {
    render(<PathPointSection />);
    expect(screen.queryByRole("region", { name: "点" })).toBeNull();
    act(() => state().startPathEdit("sq"));
    expect(screen.queryByRole("region", { name: "点" })).toBeNull();
    selectPoints("sq", 2);
    expect(screen.getByRole("region", { name: "点" })).toBeInTheDocument();
    expect(field("点の X 座標").value).toBe("200");
    expect(field("点の Y 座標").value).toBe("200");
  });

  it("X / Y は親の座標系。入力すると選んだ点を置く (履歴 1 件、点は選んだまま)", () => {
    render(<PathPointSection />);
    act(() => state().startPathEdit("rot"));
    selectPoints("rot", 1);
    // 90° 回したパスの点 1 はページの (400, 200)
    expect(field("点の X 座標").value).toBe("400");
    type(field("点の X 座標"), "420.5");
    const g = pageGeometry(state().doc, "rot")!;
    const at = applyToPoint(g.space.localToPage, g.node.subpaths[0]!.points[1]!);
    expect(at.x).toBeCloseTo(420.5, 9);
    expect(at.y).toBeCloseTo(200, 9);
    expect(state().revision).toBe(1);
    expect(selectedPoints(state().doc, "rot")).toEqual([{ subpath: 0, index: 1 }]);
  });

  it("複数の点はそろっていなければ混在。入力でそろえる", () => {
    render(<PathPointSection />);
    act(() => state().startPathEdit("sq"));
    selectPoints("sq", 0, 1);
    expect(screen.getByRole("region", { name: "点 (2 個)" })).toBeInTheDocument();
    expect(field("点の X 座標").placeholder).toBe("混在");
    expect(field("点の Y 座標").value).toBe("100");
    type(field("点の X 座標"), "150");
    const sq = getNode(state().doc, "sq") as PathNode;
    expect(sq.subpaths[0]!.points.slice(0, 2).map((p) => p.x + sq.x)).toEqual([150, 150]);
  });

  it("連動の種類を変えると反対のハンドルをそろえる", () => {
    const doc = withSubpaths(
      state().doc,
      "sq",
      pullHandles(
        (getNode(state().doc, "sq") as PathNode).subpaths,
        { subpath: 0, index: 1 },
        {
          x: 0,
          y: 20,
        },
      ).map((sub) => ({
        ...sub,
        points: sub.points.map((p, i) =>
          i === 1 ? { ...p, in: { x: -10, y: 0 }, mirror: "none" as const } : p,
        ),
      })),
    )!;
    act(() => state().load(doc));
    render(<PathPointSection />);
    act(() => state().startPathEdit("sq"));
    selectPoints("sq", 1);
    const select = screen.getByRole("combobox", { name: "ハンドルの連動" }) as HTMLSelectElement;
    expect(select.value).toBe("none");
    fireEvent.change(select, { target: { value: "angle-length" } });
    const point = (getNode(state().doc, "sq") as PathNode).subpaths[0]!.points[1]!;
    expect(point).toMatchObject({
      in: { x: -10, y: 0 },
      out: { x: 10, y: 0 },
      mirror: "angle-length",
    });
    expect(state().revision).toBe(1);
  });
});
