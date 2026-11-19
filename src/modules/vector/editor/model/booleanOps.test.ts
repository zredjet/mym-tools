import { describe, expect, it } from "vitest";

import { booleanCandidates, createBooleanFromNodes, setBooleanOp } from "./booleanOps";
import {
  createBoolean,
  createEllipse,
  createFrame,
  createGroup,
  createLine,
  createRect,
  createStroke,
  createText,
  solidPaint,
} from "./create";
import { checkSavable } from "./payload";
import { ungroupNodes } from "./structure";
import type { CanvasDocument, CanvasNode } from "./types";

function docOf(children: string[], nodes: CanvasNode[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

/** 背面から a (矩形)、t (テキスト)、b (楕円)、c (矩形)。 */
function sample(): CanvasDocument {
  return docOf(
    ["a", "t", "b", "c"],
    [
      createRect({
        id: "a",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        fill: solidPaint("#FF0000"),
        stroke: createStroke("#00FF00", 3),
        shadow: { x: 1, y: 2, blur: 3, color: "#000000", opacity: 0.5 },
        opacity: 0.4,
      }),
      createText({ id: "t" }),
      createEllipse({ id: "b", x: 50, y: 50, width: 100, height: 100 }),
      createRect({ id: "c", x: 120, y: 0, width: 10, height: 10, locked: true }),
    ],
  );
}

describe("booleanCandidates", () => {
  it("同じ親の 2 個以上の矩形・楕円・パス・ブーリアンだけ", () => {
    const doc = sample();
    expect(booleanCandidates(doc, ["c", "a"])?.ids).toEqual(["a", "c"]);
    expect(booleanCandidates(doc, ["a"])).toBeNull();
    expect(booleanCandidates(doc, ["a", "t"])).toBeNull();
  });

  it("親が違えば作れない。線・group・frame は子にできない", () => {
    const doc = docOf(
      ["f", "r", "l", "g"],
      [
        createFrame({ id: "f", width: 100, height: 100, children: ["in"] }),
        createRect({ id: "in" }),
        createRect({ id: "r" }),
        createLine({ id: "l" }),
        createGroup(["gr"], { id: "g" }),
        createRect({ id: "gr" }),
      ],
    );
    expect(booleanCandidates(doc, ["in", "r"])).toBeNull();
    expect(booleanCandidates(doc, ["r", "l"])).toBeNull();
    expect(booleanCandidates(doc, ["r", "g"])).toBeNull();
    expect(booleanCandidates(doc, ["r", "f"])).toBeNull();
  });
});

describe("createBooleanFromNodes", () => {
  it("最も前面の位置に置き、子は元の重なり順。見た目は最背面の子から", () => {
    const doc = sample();
    const next = createBooleanFromNodes(doc, ["b", "a"], "subtract", "u");
    expect(next.pages[0]?.children).toEqual(["t", "u", "c"]);
    const u = next.nodes["u"];
    expect(u).toMatchObject({
      type: "boolean",
      op: "subtract",
      name: "型抜き",
      children: ["a", "b"],
      opacity: 1,
      visible: true,
      locked: false,
    });
    const a = doc.nodes["a"];
    if (u?.type !== "boolean" || a?.type !== "rect") throw new Error("型");
    expect(u.fill).toEqual(a.fill);
    expect(u.stroke).toEqual(a.stroke);
    expect(u.shadow).toEqual(a.shadow);
    // 子のデータは残す
    expect(next.nodes["a"]).toBe(a);
    expect(checkSavable(next)).toBeNull();
  });

  it("ブーリアンの中でも作れる (入れ子のブーリアン)", () => {
    const doc = docOf(
      ["u"],
      [
        createBoolean("union", ["a", "b", "c"], { id: "u" }),
        createRect({ id: "a", width: 10, height: 10 }),
        createRect({ id: "b", x: 5, width: 10, height: 10 }),
        createEllipse({ id: "c", x: 20, width: 10, height: 10 }),
      ],
    );
    const next = createBooleanFromNodes(doc, ["a", "b"], "intersect", "i");
    const u = next.nodes["u"];
    expect(u?.type === "boolean" && u.children).toEqual(["i", "c"]);
    expect(checkSavable(next)).toBeNull();
    // 中身をすべて入れても、外のブーリアンは子を 1 個持つ
    const all = createBooleanFromNodes(doc, ["a", "b", "c"], "exclude", "x");
    const outer = all.nodes["u"];
    expect(outer?.type === "boolean" && outer.children).toEqual(["x"]);
    expect(checkSavable(all)).toBeNull();
  });

  it("作れない選択や使われている ID では何もしない", () => {
    const doc = sample();
    expect(createBooleanFromNodes(doc, ["a", "t"], "union", "u")).toBe(doc);
    expect(createBooleanFromNodes(doc, ["a", "b"], "union", "c")).toBe(doc);
  });

  it("解除すると子が元の位置へ戻る", () => {
    const doc = sample();
    const next = createBooleanFromNodes(doc, ["a", "b"], "union", "u");
    const back = ungroupNodes(next, ["u"]);
    expect(back.pages[0]?.children).toEqual(["t", "a", "b", "c"]);
    expect(back.nodes["u"]).toBeUndefined();
  });
});

describe("setBooleanOp", () => {
  it("演算を変え、既定の名前なら名前も変える", () => {
    const doc = docOf(
      ["u", "v"],
      [
        createBoolean("union", ["a"], { id: "u" }),
        createBoolean("union", ["b"], { id: "v", name: "ロゴ" }),
        createRect({ id: "a" }),
        createRect({ id: "b" }),
      ],
    );
    const next = setBooleanOp(doc, ["u", "v", "a"], "exclude");
    expect(next.nodes["u"]).toMatchObject({ op: "exclude", name: "中マド" });
    expect(next.nodes["v"]).toMatchObject({ op: "exclude", name: "ロゴ" });
    expect(next.nodes["a"]).toBe(doc.nodes["a"]);
    expect(setBooleanOp(next, ["u", "v"], "exclude")).toBe(next);
  });
});
