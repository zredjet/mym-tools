import { describe, expect, it } from "vitest";
import { applyToPoint } from "../geometry/matrix";
import { ellipseSubpaths } from "../path/shapes";
import {
  createBoolean,
  createFrame,
  createGroup,
  createLine,
  createPath,
  createRect,
} from "./create";
import {
  coordinateMatrix,
  getLocalBounds,
  getNodeCorners,
  getPageBounds,
  localToPage,
  nodeOrigin,
  nodePageMatrix,
  pageRotation,
  pageToLocal,
  pageVectorToLocal,
  parentPageRotation,
} from "./geometry";
import type { CanvasDocument, CanvasNode } from "./types";

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

const close = (value: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(value.x).toBeCloseTo(expected.x, 9);
  expect(value.y).toBeCloseTo(expected.y, 9);
};

const closeRect = (
  value: { x: number; y: number; width: number; height: number } | null,
  expected: { x: number; y: number; width: number; height: number },
) => {
  expect(value).not.toBeNull();
  expect(value!.x).toBeCloseTo(expected.x, 9);
  expect(value!.y).toBeCloseTo(expected.y, 9);
  expect(value!.width).toBeCloseTo(expected.width, 9);
  expect(value!.height).toBeCloseTo(expected.height, 9);
};

/*
 * rf  frame (100,100) 200×100、90° 回転 (中心 (200,150))
 *  └ c rect (10,10) 20×20
 * long rect (0,0) 1000×10、90° 回転
 */
const rotated = () =>
  docOf(
    [
      createFrame({
        id: "rf",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        rotation: 90,
        children: ["c", "g"],
      }),
      createRect({ id: "c", x: 10, y: 10, width: 20, height: 20 }),
      createGroup(["gl"], { id: "g" }),
      createLine({ id: "gl", x1: 0, y1: 0, x2: 10, y2: 0 }),
      createRect({ id: "long", x: 0, y: 0, width: 1000, height: 10, rotation: 90 }),
    ],
    ["rf", "long"],
  );

describe("行列による座標 (§8.5)", () => {
  const doc = rotated();

  it("回転した frame の子の座標系", () => {
    // frame の座標系の点 (10, 10) は、中心 (100, 50) からのずれ (-90, -40) を 90° 回して (40, -90)、中心 (200, 150) に足す
    close(localToPage(doc, { kind: "node", id: "rf" }, { x: 10, y: 10 }), { x: 240, y: 60 });
    close(pageToLocal(doc, { kind: "node", id: "rf" }, { x: 240, y: 60 }), { x: 10, y: 10 });
    // group は座標系を作らないので、group の子も frame の座標系
    close(localToPage(doc, { kind: "node", id: "g" }, { x: 10, y: 10 }), { x: 240, y: 60 });
    close(pageVectorToLocal(doc, { kind: "node", id: "rf" }, { x: 10, y: 0 }), { x: 0, y: -10 });
    // 原点 (0, 0) は frame の回転した左上の角
    close(nodeOrigin(doc, "c"), { x: 250, y: 50 });
  });

  it("ページ上の角度は祖先の frame の回転と自分の回転の和", () => {
    expect(pageRotation(doc, "rf")).toBe(90);
    expect(pageRotation(doc, "c")).toBe(90);
    expect(pageRotation(doc, "gl")).toBe(90);
    expect(parentPageRotation(doc, { kind: "node", id: "g" })).toBe(90);
    const turned = { ...doc, nodes: { ...doc.nodes, c: { ...doc.nodes.c!, rotation: 120 } } };
    expect(pageRotation(turned as CanvasDocument, "c")).toBe(-150);
  });

  it("ノードの行列と回転した箱の 4 隅", () => {
    const m = nodePageMatrix(doc, "c");
    close(applyToPoint(m, { x: 0, y: 0 }), { x: 240, y: 60 });
    const corners = getNodeCorners(doc, "c")!;
    close(corners[0]!, { x: 240, y: 60 });
    close(corners[1]!, { x: 240, y: 80 });
    close(corners[2]!, { x: 220, y: 80 });
    close(corners[3]!, { x: 220, y: 60 });
    expect(getNodeCorners(doc, "gl")).toBeNull();
    expect(getNodeCorners(doc, "g")).toBeNull();
  });

  it("回転していない座標系の行列は平行移動だけ", () => {
    expect(coordinateMatrix(doc, "rf")).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });
});

describe("外接矩形 (§8.5.1)", () => {
  const doc = rotated();

  it("回転した箱は 4 隅を囲む (1000×10 を 90° 回すと縦長)", () => {
    closeRect(getPageBounds(doc, "long"), { x: 495, y: -495, width: 10, height: 1000 });
    closeRect(getLocalBounds(doc, "long"), { x: 495, y: -495, width: 10, height: 1000 });
  });

  it("回転した frame の中のノードは、祖先の行列まで掛けてから囲む", () => {
    closeRect(getPageBounds(doc, "c"), { x: 220, y: 60, width: 20, height: 20 });
    // 親の座標系 (frame の座標系) では回転していない
    expect(getLocalBounds(doc, "c")).toEqual({ x: 10, y: 10, width: 20, height: 20 });
    // frame は回転した自分の箱 (子は含めない)
    closeRect(getPageBounds(doc, "rf"), { x: 150, y: 50, width: 100, height: 200 });
    // group の子の線
    closeRect(getPageBounds(doc, "g"), { x: 250, y: 50, width: 0, height: 10 });
  });

  it("45° 回した箱は 4 隅を囲み、45° 回したパスの円は大きくならない", () => {
    const circle = ellipseSubpaths(100, 100);
    const d = docOf(
      [
        createRect({ id: "sq", x: 0, y: 0, width: 100, height: 100, rotation: 45 }),
        { ...createPath(circle, { id: "pc" }), rotation: 45 },
      ],
      ["sq", "pc"],
    );
    const half = 50 * Math.SQRT2;
    closeRect(getPageBounds(d, "sq"), {
      x: 50 - half,
      y: 50 - half,
      width: 2 * half,
      height: 2 * half,
    });
    const pc = getPageBounds(d, "pc")!;
    expect(pc.width).toBeCloseTo(100, 3);
    expect(pc.height).toBeCloseTo(100, 3);
    expect(pc.x).toBeCloseTo(0, 3);
  });

  it("パスはハンドルの先を含めない曲線の範囲", () => {
    const d = docOf(
      [
        createPath(
          [
            {
              closed: false,
              points: [
                { x: 0, y: 0, in: null, out: { x: 0, y: -100 }, mirror: "none" },
                { x: 100, y: 0, in: { x: 0, y: -100 }, mirror: "none", out: null },
              ],
            },
          ],
          { id: "arch", x: 10, y: 200 },
        ),
      ],
      ["arch"],
    );
    const b = getPageBounds(d, "arch")!;
    expect(b.height).toBeCloseTo(75, 6); // 3 次ベジェの頂点は制御点の 3/4
    expect(b.width).toBeCloseTo(100, 6);
  });

  it("ブーリアンは結果の範囲。空なら子の外接矩形の和", () => {
    const union = docOf(
      [
        createBoolean("union", ["a", "b"], { id: "u" }),
        createRect({ id: "a", x: 0, y: 0, width: 10, height: 10 }),
        createRect({ id: "b", x: 5, y: 5, width: 10, height: 10 }),
      ],
      ["u"],
    );
    closeRect(getPageBounds(union, "u"), { x: 0, y: 0, width: 15, height: 15 });
    const empty = docOf(
      [
        createBoolean("intersect", ["a", "b"], { id: "i" }),
        createRect({ id: "a", x: 0, y: 0, width: 10, height: 10 }),
        createRect({ id: "b", x: 50, y: 0, width: 10, height: 10 }),
      ],
      ["i"],
    );
    expect(getPageBounds(empty, "i")).toEqual({ x: 0, y: 0, width: 60, height: 10 });
  });

  it("回転した frame の中のブーリアンは、結果の形を写してから囲む", () => {
    const d = docOf(
      [
        createFrame({
          id: "f",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 45,
          children: ["u"],
        }),
        createBoolean("union", ["e"], { id: "u" }),
        createRect({ id: "e", x: 25, y: 25, width: 50, height: 50, radius: 25 }),
      ],
      ["f"],
    );
    // 円 (角丸の半径 25 の 50×50) を回しても大きさは変わらない
    const b = getPageBounds(d, "u")!;
    expect(b.width).toBeCloseTo(50, 2);
    expect(b.x + b.width / 2).toBeCloseTo(50, 6);
  });
});
