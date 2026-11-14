import { describe, expect, it } from "vitest";
import {
  getLocalBounds,
  getPageBounds,
  getSelectionBounds,
  localToPage,
  nodeOrigin,
  pageToLocal,
  rectContains,
  rectContainsPoint,
  rectFromPoints,
  rectsIntersect,
  unionRects,
} from "./geometry";
import { sampleDocument } from "./testing";

describe("幾何", () => {
  const doc = sampleDocument();

  it("座標系の原点 (group は座標系を作らない)", () => {
    expect(nodeOrigin(doc, "r0")).toEqual({ x: 0, y: 0 });
    expect(nodeOrigin(doc, "r1")).toEqual({ x: 100, y: 50 });
    expect(nodeOrigin(doc, "r2")).toEqual({ x: 100, y: 50 });
    expect(nodeOrigin(doc, "r3")).toEqual({ x: 300, y: 150 });
  });

  it("親の座標系とページ座標の変換", () => {
    const f2 = { kind: "node", id: "f2" } as const;
    expect(localToPage(doc, f2, { x: 5, y: 5 })).toEqual({ x: 305, y: 155 });
    expect(pageToLocal(doc, f2, { x: 305, y: 155 })).toEqual({ x: 5, y: 5 });
    expect(pageToLocal(doc, { kind: "node", id: "grp" }, { x: 150, y: 110 })).toEqual({
      x: 50,
      y: 60,
    });
    expect(localToPage(doc, { kind: "page", id: "p1" }, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });

  it("外接矩形: line、group、frame", () => {
    expect(getLocalBounds(doc, "l1")).toEqual({ x: 40, y: 40, width: 40, height: 0 });
    expect(getLocalBounds(doc, "grp")).toEqual({ x: 40, y: 40, width: 40, height: 30 });
    expect(getPageBounds(doc, "grp")).toEqual({ x: 140, y: 90, width: 40, height: 30 });
    // frame は子がはみ出しても自分の矩形
    expect(getPageBounds(doc, "f")).toEqual({ x: 100, y: 50, width: 400, height: 300 });
    expect(getPageBounds(doc, "r3")).toEqual({ x: 305, y: 155, width: 10, height: 10 });
    expect(getPageBounds(doc, "nope")).toBeNull();
  });

  it("複数ノードの外接矩形", () => {
    expect(getSelectionBounds(doc, ["r0", "r3"])).toEqual({ x: 0, y: 0, width: 315, height: 165 });
    expect(getSelectionBounds(doc, [])).toBeNull();
    expect(unionRects([null, { x: 1, y: 2, width: 3, height: 4 }])).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("矩形の交差と包含", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 10, y: 10, width: 5, height: 5 })).toBe(true);
    expect(rectsIntersect(a, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
    // 幅 0 の線も拾える
    expect(rectsIntersect(a, { x: 5, y: -5, width: 0, height: 20 })).toBe(true);
    expect(rectContains(a, { x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(rectContains(a, { x: 1, y: 1, width: 10, height: 1 })).toBe(false);
    expect(rectContainsPoint(a, { x: 10, y: 0 })).toBe(true);
    expect(rectFromPoints({ x: 5, y: 8 }, { x: 1, y: 2 })).toEqual({
      x: 1,
      y: 2,
      width: 4,
      height: 6,
    });
  });
});
