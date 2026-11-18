/**
 * C2 (座標と木) のうち、ツール・パネル・コマンドの側の関数の第 2 段階のテスト。
 */
import { describe, expect, it } from "vitest";
import { applyToPoint } from "../geometry/matrix";
import { createBoolean, createFrame, createRect, createText } from "../model/create";
import { getNodeCorners, nodePageMatrix } from "../model/geometry";
import { checkSavable } from "../model/payload";
import { deepFreeze } from "../model/testing";
import type { CanvasDocument, CanvasNode, RectNode } from "../model/types";
import { MIXED } from "../panels/fields/values";
import {
  readPosition,
  readRotation,
  setBoundsField,
  setRotationField,
} from "../panels/sections/propertyOps";
import { EditorClipboard } from "../state/clipboard";
import { copySelection, pasteClipboard, pasteTarget, ungroupSelection } from "../state/commands";
import { createEditorStore } from "../state/store";
import { newTextNode, textParentAt } from "../text/creation";
import { creationParent, scopeForParent } from "./create/parent";
import { enterSelection } from "./select/actions";
import { moveDocument, translateRounded } from "./select/move";

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

/** 90° 回した frame (中心 (200, 150)) と、その中の矩形。ページ直下の回転した矩形。 */
const rotatedDoc = () =>
  docOf(
    [
      createFrame({
        id: "f",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        rotation: 90,
        children: ["c"],
      }),
      createRect({ id: "c", x: 10, y: 10, width: 20, height: 20 }),
      createRect({ id: "r", x: 0, y: 300, width: 40, height: 10, rotation: 30 }),
    ],
    ["f", "r"],
  );

describe("パネルの位置と大きさ (§8.5.5)", () => {
  const doc = rotatedDoc();

  it("1 個の回転した箱: W / H は回転の前、X / Y は回転した箱の左上の角", () => {
    const pos = readPosition(doc, ["r"])!;
    if (pos.mode !== "box") throw new Error("box でない");
    const corner = getNodeCorners(doc, "r")![0]!;
    expect(pos.values.width).toBe(40);
    expect(pos.values.height).toBe(10);
    expect(pos.values.x).toBeCloseTo(corner.x, 9);
    expect(pos.values.y).toBeCloseTo(corner.y, 9);
    // 回転していない 1 個は、これまでどおり
    expect(readPosition(doc, ["c"])).toEqual({
      mode: "box",
      values: { x: 10, y: 10, width: 20, height: 20 },
    });
  });

  it("X / Y は角を入力した位置へ動かし、W / H は左上の角を動かさない", () => {
    const moved = setBoundsField(doc, ["r"], "x", 5);
    close(getNodeCorners(moved, "r")![0]!, { x: 5, y: getNodeCorners(doc, "r")![0]!.y });
    const before = getNodeCorners(doc, "r")!;
    const wider = setBoundsField(doc, ["r"], "width", 80.4);
    expect(wider.nodes.r).toMatchObject({ width: 80, height: 10, rotation: 30 });
    close(getNodeCorners(wider, "r")![0]!, before[0]!);
    close(getNodeCorners(wider, "r")![3]!, before[3]!);
  });

  it("回転の欄: 同じ値ならその値、違えば混在、箱を持たないノードを含むなら null", () => {
    expect(readRotation(doc, ["r"])).toBe(30);
    expect(readRotation(doc, ["r", "c"])).toBe(MIXED);
    expect(readRotation(doc, [])).toBeNull();
    const next = setRotationField(doc, ["r", "c"], 45);
    expect((next.nodes.r as RectNode).rotation).toBe(45);
    expect((next.nodes.c as RectNode).rotation).toBe(45);
    // 回転は中心のまわりなので x y は変わらない
    expect(next.nodes.r).toMatchObject({ x: 0, y: 300 });
  });
});

describe("回転した frame の中の移動 (§8.5.2)", () => {
  const doc = rotatedDoc();

  it("ポインターのずれ (ページ座標) を親の座標系に直して足し、x と y の両方を丸める", () => {
    const pageBefore = applyToPoint(nodePageMatrix(doc, "c"), { x: 0, y: 0 });
    const next = translateRounded(doc, ["c"], 10.4, 0);
    // 90° 回した frame の中では、ページの右は frame の座標系の上 (y が減る)
    expect(next.nodes.c).toMatchObject({ x: 10, y: 0 });
    const pageAfter = applyToPoint(nodePageMatrix(next, "c"), { x: 0, y: 0 });
    close(pageAfter, { x: pageBefore.x + 10, y: pageBefore.y });
  });

  it("回転していない親では、動かした向きだけを丸める (これまでどおり)", () => {
    const d = docOf([createRect({ id: "a", x: 0.5, y: 0.25 })], ["a"]);
    expect(translateRounded(d, ["a"], 10.4, 0).nodes.a).toMatchObject({ x: 11, y: 0.25 });
  });

  it("ページへドロップしても見た目を変えない", () => {
    const before = getNodeCorners(doc, "c")!;
    const next = moveDocument({
      doc,
      pageId: "p1",
      ids: ["c"],
      delta: { x: 0, y: 0 },
      dropTarget: null,
    })!;
    expect(next.pages[0]!.children).toContain("c");
    getNodeCorners(next, "c")!.forEach((p, i) => close(p, before[i]!));
  });
});

describe("回転した frame の中の作成 (§8.5.2)", () => {
  const doc = docOf(
    [createFrame({ id: "f", x: 0, y: 0, width: 100, height: 100, rotation: 45, children: [] })],
    ["f"],
  );

  it("親は点を frame の座標系に直して判定する (外接矩形の隅は外)", () => {
    expect(creationParent(doc, "p1", null, { x: 50, y: 50 })).toEqual({ kind: "node", id: "f" });
    expect(creationParent(doc, "p1", null, { x: -18, y: 2 })).toEqual({ kind: "page", id: "p1" });
    expect(textParentAt(doc, "p1", null, { x: 50, y: 50 })).toEqual({ kind: "node", id: "f" });
    expect(textParentAt(doc, "p1", null, { x: -18, y: 2 })).toEqual({ kind: "page", id: "p1" });
  });

  it("テキストは frame の向きにそろえる (押した点と離した点を frame の座標系に直して箱にする)", () => {
    const parent = { kind: "node", id: "f" } as const;
    const m = nodePageMatrix(doc, "f");
    const start = applyToPoint(m, { x: 10, y: 20 });
    const end = applyToPoint(m, { x: 70, y: 40 });
    const node = newTextNode(doc, parent, start, end, "sans-serif");
    expect(node).toMatchObject({ x: 10, y: 20, width: 60, rotation: 0, sizing: "auto-height" });
  });
});

describe("ブーリアンのスコープ (§8.9.1)", () => {
  const doc = docOf(
    [
      createFrame({ id: "f", x: 0, y: 0, width: 300, height: 300, children: ["u"] }),
      createBoolean("union", ["a", "b"], { id: "u" }),
      createRect({ id: "a", x: 0, y: 0, width: 50, height: 50 }),
      createRect({ id: "b", x: 25, y: 25, width: 50, height: 50 }),
      createText({ id: "t", x: 200, y: 200 }),
    ],
    ["f"],
  );
  const withText = docOf(
    [
      ...Object.values(doc.nodes).filter((n) => n.id !== "f"),
      { ...doc.nodes.f!, children: ["u", "t"] } as CanvasNode,
    ],
    ["f"],
  );

  it("作成ツールとテキストは、ブーリアンの外の親に作る", () => {
    const parent = creationParent(doc, "p1", "u", { x: 10, y: 10 });
    expect(parent).toEqual({ kind: "node", id: "f" });
    expect(scopeForParent(doc, parent)).toBeNull();
    expect(textParentAt(doc, "p1", "u", { x: 10, y: 10 })).toEqual({ kind: "node", id: "f" });
  });

  it("Enter でブーリアンの中に入り、子を選ぶ", () => {
    const store = createEditorStore(doc);
    store.getState().setSelection(["u"]);
    expect(enterSelection(store)).toBe(true);
    expect(store.getState().scopeId).toBe("u");
    expect(store.getState().selection).toEqual(["a", "b"]);
  });

  it("子にできる種類だけの貼り付けはブーリアンの中、混ざればブーリアンの外", () => {
    const store = createEditorStore(withText);
    const clipboard = new EditorClipboard();
    store.getState().setSelection(["a"]);
    copySelection(store, clipboard);
    expect(pasteTarget(store.getState(), clipboard)).toEqual({ kind: "node", id: "u" });
    pasteClipboard(store, clipboard);
    expect(checkSavable(store.getState().doc)).toBeNull();

    store.getState().setSelection(["a", "t"]);
    copySelection(store, clipboard);
    store.getState().setScope("u");
    store.getState().setSelection([]);
    expect(pasteTarget(store.getState(), clipboard)).toEqual({ kind: "node", id: "f" });
    pasteClipboard(store, clipboard);
    expect(checkSavable(store.getState().doc)).toBeNull();
  });

  it("解除するとブーリアンの子を選ぶ", () => {
    const store = createEditorStore(doc);
    store.getState().setSelection(["u"]);
    ungroupSelection(store);
    expect(store.getState().doc.nodes.u).toBeUndefined();
    expect(store.getState().selection).toEqual(["a", "b"]);
  });
});
