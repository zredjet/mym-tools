import { describe, expect, it } from "vitest";
import { getPageBounds } from "../../model/geometry";
import { deepFreeze, sampleDocument } from "../../model/testing";
import { updateNode } from "../../model/transform";
import { getParent } from "../../model/tree";
import {
  constrainAxis,
  coordinateFrameId,
  moveDocument,
  reparentToDropTarget,
  translateRounded,
} from "./move";

const doc = deepFreeze(sampleDocument());

describe("translateRounded", () => {
  it("動かした座標を整数に丸める。group は子を動かし、frame の子は動かさない", () => {
    const next = translateRounded(doc, ["grp", "f2"], 2.4, -1.6);
    expect(next.nodes.r2).toMatchObject({ x: 52, y: 58 });
    expect(next.nodes.l1).toMatchObject({ x1: 42, y1: 38, x2: 82, y2: 38 });
    expect(next.nodes.f2).toMatchObject({ x: 202, y: 98 });
    expect(next.nodes.r3).toBe(doc.nodes.r3);
  });

  it("小数の座標も整数にする。祖先と一緒に選ばれた子は重ねて動かさない", () => {
    const fractional = updateNode(doc, "r1", { x: 10.5 });
    expect(translateRounded(fractional, ["r1"], 1, 0).nodes.r1).toMatchObject({ x: 12 });
    expect(translateRounded(doc, ["grp", "r2"], 5, 0).nodes.r2).toMatchObject({ x: 55 });
  });

  it("丸めるのは動かした向きだけ。動かしていない向きの小数は変えない", () => {
    const fractional = updateNode(doc, "r1", { x: 10.5, y: 0.5 });
    expect(translateRounded(fractional, ["r1"], 3, 0).nodes.r1).toMatchObject({ x: 14, y: 0.5 });
    expect(translateRounded(fractional, ["r1"], 0, 2).nodes.r1).toMatchObject({ x: 10.5, y: 3 });
    expect(translateRounded(fractional, ["r1"], 0, 0)).toBe(fractional);
    const line = updateNode(doc, "l1", { y1: 40.5, y2: 40.5 });
    expect(translateRounded(line, ["l1"], 1, 0).nodes.l1).toMatchObject({
      x1: 41,
      y1: 40.5,
      x2: 81,
      y2: 40.5,
    });
  });

  it("変わらなければ同じ文書", () => {
    expect(translateRounded(doc, ["r1"], 0, 0)).toBe(doc);
    expect(translateRounded(doc, ["r1"], 0.2, -0.3)).toBe(doc);
  });

  it("Shift の固定", () => {
    expect(constrainAxis({ x: 10, y: -3 })).toEqual({ x: 10, y: 0 });
    expect(constrainAxis({ x: 2, y: -3 })).toEqual({ x: 0, y: -3 });
  });
});

describe("reparentToDropTarget", () => {
  it("座標系の frame が違えば、見た目の位置を変えずにドロップ先の子にする", () => {
    const before = getPageBounds(doc, "r1");
    const next = reparentToDropTarget(doc, "p1", ["r1"], "f2");
    expect(getParent(next, "r1")).toEqual({ kind: "node", id: "f2" });
    expect(getPageBounds(next, "r1")).toEqual(before);
    const out = reparentToDropTarget(doc, "p1", ["r1"], null);
    expect(getParent(out, "r1")).toEqual({ kind: "page", id: "p1" });
    expect(getPageBounds(out, "r1")).toEqual(before);
  });

  it("座標系の frame が同じなら親を変えない (group の中のノードは group に残る)", () => {
    expect(coordinateFrameId(doc, "r2")).toBe("f");
    expect(reparentToDropTarget(doc, "p1", ["r2"], "f")).toBe(doc);
    expect(reparentToDropTarget(doc, "p1", ["r0"], null)).toBe(doc);
  });
});

describe("moveDocument", () => {
  it("丸めて動かし、ドロップ先へ移す", () => {
    const next = moveDocument({
      doc,
      pageId: "p1",
      ids: ["r1"],
      delta: { x: 200.4, y: 100 },
      dropTarget: "f2",
    });
    expect(next && getParent(next, "r1")).toEqual({ kind: "node", id: "f2" });
    expect(next && getPageBounds(next, "r1")).toEqual({ x: 310, y: 160, width: 20, height: 20 });
  });

  it("§3.5 の範囲を超えるなら null", () => {
    expect(
      moveDocument({ doc, pageId: "p1", ids: ["r0"], delta: { x: 2_000_000, y: 0 } }),
    ).toBeNull();
  });
});
