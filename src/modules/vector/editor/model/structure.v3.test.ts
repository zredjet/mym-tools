import { describe, expect, it } from "vitest";
import {
  createBoolean,
  createFrame,
  createGroup,
  createPath,
  createRect,
  createText,
} from "./create";
import { extractFragment, insertFragment } from "./fragment";
import { getNodeCorners, pageRotation } from "./geometry";
import { checkSavable } from "./payload";
import {
  deleteNodes,
  duplicateNodes,
  groupNodes,
  insertNode,
  moveNodes,
  ungroupNodes,
} from "./structure";
import { deepFreeze } from "./testing";
import {
  canHaveChildOfType,
  getDescendantIds,
  getParent,
  getParentNode,
  insertionParent,
  isContainer,
  isGroupLike,
  listPageNodeIds,
  outsideBooleans,
} from "./tree";
import type { BooleanNode, CanvasDocument, CanvasNode, RectNode } from "./types";

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return deepFreeze({
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  });
}

const close = (value: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(value.x).toBeCloseTo(expected.x, 9);
  expect(value.y).toBeCloseTo(expected.y, 9);
};

/*
 * f  frame (0,0) 200×200
 * ├ u  boolean union [a, inner]
 * │ ├ a      rect (0,0) 10×10
 * │ └ inner  boolean subtract [b, c]
 * │   ├ b rect (20,0) 10×10
 * │   └ c rect (25,0) 10×10
 * └ t  text
 */
const sample = () =>
  docOf(
    [
      createFrame({ id: "f", x: 0, y: 0, width: 200, height: 200, children: ["u", "t"] }),
      createBoolean("union", ["a", "inner"], { id: "u", opacity: 0.5 }),
      createRect({ id: "a", x: 0, y: 0, width: 10, height: 10 }),
      createBoolean("subtract", ["b", "c"], { id: "inner" }),
      createRect({ id: "b", x: 20, y: 0, width: 10, height: 10 }),
      createRect({ id: "c", x: 25, y: 0, width: 10, height: 10 }),
      createText({ id: "t", x: 50, y: 50 }),
    ],
    ["f"],
  );

describe("ブーリアンの木 (§8.9.1)", () => {
  const doc = sample();

  it("子を持つノードと、座標系を作らない入れ物の述語", () => {
    expect(isContainer(doc.nodes.u!)).toBe(true);
    expect(isGroupLike(doc.nodes.u!)).toBe(true);
    expect(isGroupLike(doc.nodes.f!)).toBe(false);
    expect(isContainer(doc.nodes.a!)).toBe(false);
  });

  it("ブーリアンの子が木の参照から見える", () => {
    expect(getParent(doc, "a")).toEqual({ kind: "node", id: "u" });
    expect(getParentNode(doc, "b")?.id).toBe("inner");
    expect(getDescendantIds(doc, "u")).toEqual(["a", "inner", "b", "c"]);
    expect(listPageNodeIds(doc, "p1")).toEqual(["f", "u", "a", "inner", "b", "c", "t"]);
  });

  it("子にできる種類と、ブーリアンの外の親", () => {
    expect(canHaveChildOfType(doc, { kind: "node", id: "u" }, "path")).toBe(true);
    expect(canHaveChildOfType(doc, { kind: "node", id: "u" }, "text")).toBe(false);
    expect(canHaveChildOfType(doc, { kind: "node", id: "f" }, "text")).toBe(true);
    expect(canHaveChildOfType(doc, { kind: "node", id: "a" }, "rect")).toBe(false);
    const inner = { kind: "node", id: "inner" } as const;
    expect(insertionParent(doc, inner, ["rect"])).toEqual(inner);
    expect(insertionParent(doc, inner, ["rect", "text"])).toEqual({ kind: "node", id: "f" });
    expect(outsideBooleans(doc, inner)).toEqual({ kind: "node", id: "f" });
    expect(outsideBooleans(doc, { kind: "page", id: "p1" })).toEqual({ kind: "page", id: "p1" });
  });

  it("ブーリアンを消すと子孫も消え、保存できる", () => {
    const next = deleteNodes(doc, ["u"]);
    expect(Object.keys(next.nodes).sort()).toEqual(["f", "t"]);
    expect(checkSavable(next)).toBeNull();
  });

  it("子がなくなったブーリアンは消える (入れ子も)", () => {
    const next = deleteNodes(doc, ["b", "c"]);
    expect(next.nodes.inner).toBeUndefined();
    expect((next.nodes.u as BooleanNode).children).toEqual(["a"]);
    expect(checkSavable(next)).toBeNull();
    const out = moveNodes(doc, ["a", "inner"], { kind: "node", id: "f" });
    expect(out.nodes.u).toBeUndefined();
    expect(checkSavable(out)).toBeNull();
  });

  it("複製は子にも新しい ID を振り、ブーリアンの中の複製は中に置く", () => {
    const dup = duplicateNodes(doc, ["u"], { x: 10, y: 10 });
    expect(dup.ids).toHaveLength(1);
    const copy = dup.doc.nodes[dup.ids[0]!] as BooleanNode;
    expect(copy.children).toHaveLength(2);
    expect(copy.children).not.toContain("a");
    expect(checkSavable(dup.doc)).toBeNull();
    const child = duplicateNodes(doc, ["b"], { x: 0, y: 0 });
    expect(getParent(child.doc, child.ids[0]!)).toEqual({ kind: "node", id: "inner" });
    expect(checkSavable(child.doc)).toBeNull();
  });

  it("子にできない種類はブーリアンに入れない (挿入・付け替え・断片)", () => {
    const u = { kind: "node", id: "u" } as const;
    expect(insertNode(doc, createText({ id: "t2" }), u)).toBe(doc);
    expect(insertNode(doc, createRect({ id: "r2" }), u)).not.toBe(doc);
    expect(moveNodes(doc, ["t"], u)).toBe(doc);
    const moved = moveNodes(
      insertNode(doc, createRect({ id: "r2" }), { kind: "node", id: "f" }),
      ["r2"],
      u,
    );
    expect((moved.nodes.u as BooleanNode).children).toContain("r2");
    expect(checkSavable(moved)).toBeNull();
    const fragment = extractFragment(doc, ["t", "a"])!;
    expect(insertFragment(doc, fragment, u).ids).toEqual([]);
    const shapes = extractFragment(doc, ["a"])!;
    expect(insertFragment(doc, shapes, u).ids).toHaveLength(1);
  });

  it("子のない group とブーリアンは insertNode で入れない (検証に通らない)", () => {
    const page = { kind: "page", id: "p1" } as const;
    expect(insertNode(doc, createBoolean("union", [], { id: "e" }), page)).toBe(doc);
    expect(insertNode(doc, createGroup([], { id: "g0" }), page)).toBe(doc);
  });

  it("ブーリアンの中ではグループ化できない", () => {
    expect(groupNodes(doc, ["b", "c"], "g1")).toBe(doc);
    // ブーリアンの子を外の親へまとめるのはできる (空になったブーリアンは消える)
    const grouped = groupNodes(doc, ["b", "c", "t"], "g1");
    expect(grouped.nodes.inner).toBeUndefined();
    expect(checkSavable(grouped)).toBeNull();
  });

  it("解除は group とブーリアンの両方。不透明度・非表示・ロックを子へ写す", () => {
    const next = ungroupNodes(doc, ["u"]);
    expect(next.nodes.u).toBeUndefined();
    expect((next.nodes.f as { children: string[] }).children).toEqual(["a", "inner", "t"]);
    expect((next.nodes.a as RectNode).opacity).toBe(0.5);
    expect((next.nodes.inner as BooleanNode).opacity).toBe(0.5);
    expect(checkSavable(next)).toBeNull();
  });
});

describe("回転の向きが同じ座標系の間の付け替え (§8.5.2)", () => {
  const corners = (d: CanvasDocument, id: string) => getNodeCorners(d, id)!;

  it.each([30, 90, 180, 17])("同じ角度 (%s°) の 2 つの frame の間で見た目を変えない", (rot) => {
    const d = docOf(
      [
        createFrame({
          id: "f1",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          rotation: rot,
          children: ["r"],
        }),
        createFrame({
          id: "f2",
          x: 500,
          y: 0,
          width: 400,
          height: 300,
          rotation: rot,
          children: [],
        }),
        createRect({ id: "r", x: 20, y: 30, width: 100, height: 50 }),
      ],
      ["f1", "f2"],
    );
    const next = moveNodes(d, ["r"], { kind: "node", id: "f2" });
    expect(getParent(next, "r")).toEqual({ kind: "node", id: "f2" });
    expect((next.nodes.r as RectNode).rotation).toBe(0);
    corners(next, "r").forEach((p, i) => close(p, corners(d, "r")[i]!));
  });

  const nested = (children: string[], gChildren: string[], extra: CanvasNode[] = []) =>
    docOf(
      [
        createFrame({ id: "F", x: 100, y: 100, width: 600, height: 400, rotation: 30, children }),
        createFrame({ id: "G", x: 300, y: 50, width: 200, height: 200, children: gChildren }),
        createRect({ id: "r", x: 20, y: 30, width: 100, height: 50 }),
        ...extra,
      ],
      ["F"],
    );

  it("回転した frame から、その中の回転していない frame へ入れても見た目を変えない", () => {
    const d = nested(["r", "G"], []);
    const next = moveNodes(d, ["r"], { kind: "node", id: "G" });
    expect(getParent(next, "r")).toEqual({ kind: "node", id: "G" });
    expect(next.nodes.r).toMatchObject({ x: -280, y: -20, rotation: 0 });
    corners(next, "r").forEach((p, i) => close(p, corners(d, "r")[i]!));
    const back = moveNodes(next, ["r"], { kind: "node", id: "F" });
    expect(back.nodes.r).toMatchObject({ x: 20, y: 30, rotation: 0 });
  });

  it("その 2 つにまたがるグループ化で、どちらの子も動かない", () => {
    const d = nested(
      ["G", "r"],
      ["s"],
      [createRect({ id: "s", x: 5, y: 5, width: 10, height: 10 })],
    );
    const next = groupNodes(d, ["s", "r"], "GG");
    expect(getParent(next, "GG")).toEqual({ kind: "node", id: "F" });
    corners(next, "s").forEach((p, i) => close(p, corners(d, "s")[i]!));
    corners(next, "r").forEach((p, i) => close(p, corners(d, "r")[i]!));
  });
});

describe("回転した frame の間の付け替え (§8.5.2)", () => {
  const doc = docOf(
    [
      createFrame({
        id: "f",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        rotation: 30,
        children: ["r", "p"],
      }),
      createRect({ id: "r", x: 10, y: 20, width: 40, height: 10, rotation: 15 }),
      createPath(
        [
          {
            closed: false,
            points: [
              { x: 0, y: 0, in: null, out: null, mirror: "none" },
              { x: 30, y: 10, in: null, out: null, mirror: "none" },
            ],
          },
        ],
        { id: "p", x: 50, y: 50 },
      ),
      createFrame({ id: "g", x: 400, y: 0, width: 100, height: 100, rotation: -60, children: [] }),
      createGroup(["gr"], { id: "grp" }),
      createRect({ id: "gr", x: 0, y: 300, width: 10, height: 10 }),
    ],
    ["f", "g", "grp"],
  );

  it("ページへ出しても見た目 (4 隅と角度) を変えない", () => {
    const before = getNodeCorners(doc, "r")!;
    const next = moveNodes(doc, ["r"], { kind: "page", id: "p1" });
    expect(getParent(next, "r")).toEqual({ kind: "page", id: "p1" });
    expect((next.nodes.r as RectNode).rotation).toBe(45);
    getNodeCorners(next, "r")!.forEach((p, i) => close(p, before[i]!));
  });

  it("別の回転した frame へ入れても見た目を変えない (パスの点は変えない)", () => {
    const beforeR = getNodeCorners(doc, "r")!;
    const beforeP = getNodeCorners(doc, "p")!;
    const next = moveNodes(doc, ["r", "p"], { kind: "node", id: "g" });
    expect(pageRotation(next, "r")).toBeCloseTo(45, 9);
    expect((next.nodes.r as RectNode).rotation).toBe(105);
    getNodeCorners(next, "r")!.forEach((p, i) => close(p, beforeR[i]!));
    getNodeCorners(next, "p")!.forEach((p, i) => close(p, beforeP[i]!));
    expect(next.nodes.p).toMatchObject({
      subpaths: (doc.nodes.p as { subpaths: unknown }).subpaths,
    });
  });

  it("グループ化でほかの親から移すときも見た目を変えない", () => {
    const before = getNodeCorners(doc, "r")!;
    const next = groupNodes(doc, ["r", "gr"], "new");
    expect(getParent(next, "r")).toEqual({ kind: "node", id: "new" });
    getNodeCorners(next, "r")!.forEach((p, i) => close(p, before[i]!));
  });

  it("コピーと貼り付け: 根はページ座標に直し、貼り付け先の座標系へ戻す", () => {
    const before = getNodeCorners(doc, "r")!;
    const fragment = extractFragment(doc, ["r"])!;
    const root = fragment.nodes[fragment.roots[0]!] as RectNode;
    expect(root.rotation).toBe(45);
    const pasted = insertFragment(doc, fragment, { kind: "node", id: "g" });
    const id = pasted.ids[0]!;
    getNodeCorners(pasted.doc, id)!.forEach((p, i) => close(p, before[i]!));
    const offset = insertFragment(
      doc,
      fragment,
      { kind: "node", id: "g" },
      { offset: { x: 10, y: 0 } },
    );
    getNodeCorners(offset.doc, offset.ids[0]!)!.forEach((p, i) =>
      close(p, { x: before[i]!.x + 10, y: before[i]!.y }),
    );
  });

  it("複製のずれはページの向き", () => {
    const before = getNodeCorners(doc, "r")!;
    const dup = duplicateNodes(doc, ["r"], { x: 10, y: 10 });
    getNodeCorners(dup.doc, dup.ids[0]!)!.forEach((p, i) =>
      close(p, { x: before[i]!.x + 10, y: before[i]!.y + 10 }),
    );
  });
});
