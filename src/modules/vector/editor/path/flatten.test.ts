import { describe, expect, it } from "vitest";

import { getBooleanResult } from "../boolean/result";
import {
  createBoolean,
  createEllipse,
  createFrame,
  createGroup,
  createLine,
  createPath,
  createRect,
  createStroke,
  createText,
  solidPaint,
} from "../model/create";
import { getPageBounds } from "../model/geometry";
import { CANVAS_LIMITS } from "../model/limits";
import { checkSavable } from "../model/payload";
import type { CanvasDocument, CanvasNode, PathNode, Subpath } from "../model/types";
import { containsPoint } from "./measure";
import { rectSubpaths } from "./shapes";
import { flattenNodes, flattenTargets } from "./flatten";

function docOf(children: string[], nodes: CanvasNode[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

function pathOf(doc: CanvasDocument, id: string): PathNode {
  const node = doc.nodes[id];
  if (node?.type !== "path") throw new Error(`${id} はパスではない`);
  return node;
}

function expectClose(
  a: { x: number; y: number; width: number; height: number } | null,
  b: typeof a,
) {
  expect(a).not.toBeNull();
  if (!a || !b) return;
  for (const key of ["x", "y", "width", "height"] as const) expect(a[key]).toBeCloseTo(b[key], 6);
}

describe("flattenTargets", () => {
  it("テキスト・frame・group を含む選択、親の違う複数、パス 1 個は対象にしない", () => {
    const doc = docOf(
      ["f", "t", "g", "r", "p"],
      [
        createFrame({ id: "f", width: 100, height: 100, children: ["in"] }),
        createRect({ id: "in" }),
        createText({ id: "t" }),
        createGroup(["gr"], { id: "g" }),
        createRect({ id: "gr" }),
        createRect({ id: "r" }),
        createPath(rectSubpaths(10, 10, 0), { id: "p" }),
      ],
    );
    expect(flattenTargets(doc, ["r", "t"])).toEqual({ ok: false, reason: "unsupported" });
    expect(flattenTargets(doc, ["g"])).toEqual({ ok: false, reason: "unsupported" });
    expect(flattenTargets(doc, ["f"])).toEqual({ ok: false, reason: "unsupported" });
    expect(flattenTargets(doc, ["in", "r"])).toEqual({ ok: false, reason: "differentParents" });
    expect(flattenTargets(doc, ["p"])).toEqual({ ok: false, reason: "alreadyPath" });
    expect(flattenTargets(doc, ["p", "r"]).ok).toBe(true);
  });
});

describe("flattenNodes (1 個)", () => {
  it("回転した角丸の矩形は、同じ箱・同じ回転・同じ見た目のパス (ID も同じ)", () => {
    const rect = createRect({
      id: "r",
      name: "角丸",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      radius: 8,
      rotation: 30,
      opacity: 0.5,
      locked: true,
      fill: solidPaint("#112233"),
      stroke: { ...createStroke("#445566", 2), dash: [4, 2] },
    });
    const doc = docOf(["r"], [rect]);
    const out = flattenNodes(doc, ["r"], "new");
    if (!out.ok) throw new Error(out.reason);
    expect(out.ids).toEqual(["r"]);
    const path = pathOf(out.doc, "r");
    expect(path).toMatchObject({
      name: "角丸",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      rotation: 30,
      opacity: 0.5,
      locked: true,
      fill: rect.fill,
      stroke: rect.stroke,
      fillRule: "nonzero",
    });
    // 始点は (rx, 0) から時計回り (描画と同じ。破線の位置が変わらない)
    expect(path.subpaths[0]?.points[0]).toMatchObject({ x: 8, y: 0 });
    expect(checkSavable(out.doc)).toBeNull();
    // 角丸なしなら外接矩形も同じ (角丸ありは曲線の範囲なので小さくなる。§8.5.1)
    const square = docOf(
      ["s"],
      [createRect({ id: "s", x: 3, y: 4, width: 30, height: 10, rotation: 30 })],
    );
    const flat = flattenNodes(square, ["s"], "new");
    if (!flat.ok) throw new Error(flat.reason);
    expectClose(getPageBounds(flat.doc, "s"), getPageBounds(square, "s"));
  });

  it("線は塗りなしの開いた輪郭 1 本", () => {
    const doc = docOf(["l"], [createLine({ id: "l", x1: 10, y1: 10, x2: 50, y2: 30 })]);
    const out = flattenNodes(doc, ["l"], "new");
    if (!out.ok) throw new Error(out.reason);
    const path = pathOf(out.doc, "l");
    expect(path).toMatchObject({ x: 10, y: 10, width: 40, height: 20, fill: null, rotation: 0 });
    expect(path.subpaths).toHaveLength(1);
    expect(path.subpaths[0]?.closed).toBe(false);
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("ブーリアンは結果の形になり、子は消える", () => {
    const doc = docOf(
      ["u"],
      [
        createBoolean("union", ["a", "b"], { id: "u", fill: solidPaint("#FF0000") }),
        createRect({ id: "a", width: 10, height: 10 }),
        createRect({ id: "b", x: 5, y: 5, width: 10, height: 10 }),
      ],
    );
    const result = getBooleanResult(doc, "u");
    const out = flattenNodes(doc, ["u"], "new");
    if (!out.ok) throw new Error(out.reason);
    const path = pathOf(out.doc, "u");
    expect(path.fill).toEqual(solidPaint("#FF0000"));
    expect(path.subpaths).toHaveLength(result?.subpaths.length ?? -1);
    expect(out.doc.nodes["a"]).toBeUndefined();
    expect(out.doc.nodes["b"]).toBeUndefined();
    expectClose(getPageBounds(out.doc, "u"), { x: 0, y: 0, width: 15, height: 15 });
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("ブーリアンの子のまま、パスに変わる", () => {
    const doc = docOf(
      ["u"],
      [
        createBoolean("subtract", ["a", "b"], { id: "u" }),
        createRect({ id: "a", width: 10, height: 10 }),
        createEllipse({ id: "b", x: 2, y: 2, width: 4, height: 4 }),
      ],
    );
    const out = flattenNodes(doc, ["b"], "new");
    if (!out.ok) throw new Error(out.reason);
    const u = out.doc.nodes["u"];
    expect(u?.type === "boolean" && u.children).toEqual(["a", "b"]);
    expect(out.doc.nodes["b"]?.type).toBe("path");
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("大きさ 0 の矩形と、結果が空のブーリアンは当てない", () => {
    const doc = docOf(
      ["z", "i"],
      [
        createRect({ id: "z", width: 0, height: 10 }),
        createBoolean("intersect", ["a", "b"], { id: "i" }),
        createRect({ id: "a", width: 10, height: 10 }),
        createRect({ id: "b", x: 50, width: 10, height: 10 }),
      ],
    );
    expect(flattenNodes(doc, ["z"], "new")).toEqual({ ok: false, reason: "empty" });
    expect(flattenNodes(doc, ["i"], "new")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("flattenNodes (複数)", () => {
  /** 背面から a (塗りあり)、t (テキスト)、b (塗りあり、a と重なる)、l (線)。 */
  function sample(): CanvasDocument {
    return docOf(
      ["a", "t", "b", "l"],
      [
        createRect({
          id: "a",
          name: "下",
          width: 20,
          height: 20,
          opacity: 0.7,
          fill: solidPaint("#FF0000"),
        }),
        createText({ id: "t" }),
        // 反時計回りに描いた輪郭 (nonzero で穴になりうる向き) のパス
        createPath(
          [
            {
              closed: true,
              points: [
                { x: 10, y: 10, in: null, out: null, mirror: "none" },
                { x: 10, y: 30, in: null, out: null, mirror: "none" },
                { x: 30, y: 30, in: null, out: null, mirror: "none" },
                { x: 30, y: 10, in: null, out: null, mirror: "none" },
              ],
            },
          ],
          { id: "b", fill: solidPaint("#00FF00"), rotation: 0 },
        ),
        createLine({ id: "l", x1: 0, y1: 40, x2: 40, y2: 40 }),
      ],
    );
  }

  it("1 つのパスにまとめ、最も前面の位置に置き、最背面の名前と見た目を引き継ぐ", () => {
    const doc = sample();
    const out = flattenNodes(doc, ["l", "a", "b"], "m");
    if (!out.ok) throw new Error(out.reason);
    expect(out.ids).toEqual(["m"]);
    expect(out.doc.pages[0]?.children).toEqual(["t", "m"]);
    const path = pathOf(out.doc, "m");
    expect(path).toMatchObject({
      name: "下",
      opacity: 0.7,
      fill: solidPaint("#FF0000"),
      rotation: 0,
      fillRule: "nonzero",
    });
    expect(path.subpaths).toHaveLength(3);
    // 重なった所が穴にならない (塗りのある形は向きをそろえてある)
    const local: Subpath[] = path.subpaths;
    expect(containsPoint(local, { x: 15 - path.x, y: 15 - path.y }, "nonzero")).toBe(true);
    // 線は開いた輪郭のまま
    expect(path.subpaths[2]?.closed).toBe(false);
    for (const id of ["a", "b", "l"]) expect(out.doc.nodes[id]).toBeUndefined();
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("回転は点に焼き込む", () => {
    const doc = docOf(
      ["a", "b"],
      [
        createRect({ id: "a", width: 10, height: 10, rotation: 45, fill: solidPaint("#000000") }),
        createRect({ id: "b", x: 100, width: 10, height: 10 }),
      ],
    );
    const out = flattenNodes(doc, ["a", "b"], "m");
    if (!out.ok) throw new Error(out.reason);
    const before = getPageBounds(doc, "a");
    const bBounds = getPageBounds(doc, "b");
    const after = getPageBounds(out.doc, "m");
    expect(after?.x).toBeCloseTo(before?.x ?? NaN, 6);
    expect(after?.y).toBeCloseTo(before?.y ?? NaN, 6);
    expect((after?.x ?? 0) + (after?.width ?? 0)).toBeCloseTo(
      (bBounds?.x ?? 0) + (bBounds?.width ?? 0),
      6,
    );
  });

  it("ブーリアンの結果が求められなければ当てない", () => {
    const doc = docOf(
      ["u", "r"],
      [
        createBoolean("union", ["a"], { id: "u" }),
        // 座標が大きすぎる (MAX_MAGNITUDE を超える) 形は求められない
        createRect({ id: "a", x: 1e16, width: 10, height: 10 }),
        createRect({ id: "r", width: 10, height: 10 }),
      ],
    );
    expect(getBooleanResult(doc, "u")).toBeNull();
    expect(flattenNodes(doc, ["u"], "m")).toEqual({ ok: false, reason: "booleanFailed" });
    expect(flattenNodes(doc, ["u", "r"], "m")).toEqual({ ok: false, reason: "booleanFailed" });
  });

  it("結果が座標の上限を超えるなら当てない (ハンドルの先も見る)", () => {
    const max = CANVAS_LIMITS.maxCoordinate;
    // 点もハンドルの相対値も範囲の中だが、まとめると (親の座標系で) ハンドルの先が範囲の外に出る
    const far = docOf(
      ["p", "q"],
      [
        createPath(
          [
            {
              closed: false,
              points: [
                { x: 0, y: 0, in: null, out: { x: 0, y: max }, mirror: "none" },
                { x: 4, y: 0, in: null, out: null, mirror: "none" },
              ],
            },
          ],
          { id: "p", x: 0, y: max - 10 },
        ),
        createRect({ id: "q", width: 1, height: 1 }),
      ],
    );
    expect(flattenNodes(far, ["p", "q"], "m")).toEqual({ ok: false, reason: "limits" });
  });
});
