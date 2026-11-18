import { describe, expect, it } from "vitest";

import { alignNodes, distributeNodes } from "../model/align";
import { createBoolean, createFrame, createPath, createRect } from "../model/create";
import { CANVAS_LIMITS } from "../model/limits";
import { translateNodes } from "../model/transform";
import type { CanvasDocument } from "../model/types";
import { geometryWithinLimits, pathPointsWithinLimits, withinLimitsOrSame } from "./limits";

/** frame F (x=900000) の子 A (x=100) と、ページ直下の B (x=-900000)。 */
function farDocument(): CanvasDocument {
  const nodes = [
    createFrame({ id: "F", x: 900000, y: 0, width: 1000, height: 1000, children: ["A"] }),
    createRect({ id: "A", x: 100, y: 0, width: 10, height: 10 }),
    createRect({ id: "B", x: -900000, y: 0, width: 10, height: 10 }),
    createRect({ id: "C", x: 0, y: 0, width: 10, height: 10 }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["F", "B", "C"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

describe("withinLimitsOrSame", () => {
  it("親の座標系が違うノードの整列で上限を超えるなら当てない", () => {
    const doc = farDocument();
    const aligned = alignNodes(doc, ["A", "B"], "left");
    // そのまま当てると A の frame の中での X は -1,800,000 になる
    expect(geometryWithinLimits(aligned, ["A", "B"])).toBe(false);
    expect(withinLimitsOrSame(doc, ["A", "B"], aligned)).toBe(doc);
    const distributed = distributeNodes(doc, ["A", "B", "C"], "horizontal");
    expect(withinLimitsOrSame(doc, ["A", "B", "C"], distributed)).toBe(
      geometryWithinLimits(distributed, ["A", "B", "C"]) ? distributed : doc,
    );
  });

  it("範囲に収まる結果はそのまま", () => {
    const doc = farDocument();
    const aligned = alignNodes(doc, ["B", "C"], "top");
    expect(withinLimitsOrSame(doc, ["B", "C"], aligned)).toBe(aligned);
  });
});

describe("geometryWithinLimits (ブーリアン)", () => {
  it("ブーリアンの子も確かめる", () => {
    const nodes = [
      createBoolean("union", ["near", "edge"], { id: "u" }),
      createRect({ id: "near", x: 0, y: 0, width: 10, height: 10 }),
      createRect({ id: "edge", x: 999990, y: 0, width: 10, height: 10 }),
    ];
    const doc: CanvasDocument = {
      pages: [{ id: "p1", name: "ページ 1", children: ["u"], guides: [] }],
      nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
      assets: {},
    };
    expect(geometryWithinLimits(doc, ["u"])).toBe(true);
    const moved = translateNodes(doc, ["u"], 100, 0);
    expect(moved.nodes["edge"]).toMatchObject({ x: 1000090 });
    expect(geometryWithinLimits(moved, ["u"])).toBe(false);
  });
});

describe("geometryWithinLimits (パスの点とハンドル)", () => {
  const max = CANVAS_LIMITS.maxCoordinate;
  const pathDoc = (handle: { x: number; y: number }): CanvasDocument => {
    const path = createPath(
      [
        {
          closed: false,
          points: [
            { x: 0, y: 0, in: null, out: handle, mirror: "none" },
            { x: 100, y: 0, in: null, out: null, mirror: "none" },
          ],
        },
      ],
      { id: "p" },
    );
    return {
      pages: [{ id: "p1", name: "ページ 1", children: ["p"], guides: [] }],
      nodes: { p: path },
      assets: {},
    };
  };

  it("ハンドルの相対値と、点 + ハンドルの位置も確かめる", () => {
    expect(geometryWithinLimits(pathDoc({ x: 10, y: 10 }), ["p"])).toBe(true);
    expect(geometryWithinLimits(pathDoc({ x: 0, y: max + 1 }), ["p"])).toBe(false);
    // 相対値は範囲の中でも、点 + ハンドルが外
    const doc = pathDoc({ x: 0, y: max });
    const node = doc.nodes["p"];
    if (node?.type !== "path") throw new Error("path");
    const shifted: CanvasDocument = {
      ...doc,
      nodes: {
        p: {
          ...node,
          subpaths: node.subpaths.map((sub) => ({
            ...sub,
            points: sub.points.map((p) => ({ ...p, y: p.y + 10 })),
          })),
        },
      },
    };
    expect(geometryWithinLimits(shifted, ["p"])).toBe(false);
  });
});

describe("pathPointsWithinLimits", () => {
  it("1 つのパスの点の数と、文書の合計", () => {
    const points = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        x: i,
        y: 0,
        in: null,
        out: null,
        mirror: "none" as const,
      }));
    const path = (id: string, n: number) =>
      createPath([{ closed: false, points: points(n) }], { id });
    const doc = (paths: ReturnType<typeof path>[]): CanvasDocument => ({
      pages: [{ id: "p1", name: "ページ 1", children: paths.map((p) => p.id), guides: [] }],
      nodes: Object.fromEntries(paths.map((p) => [p.id, p])),
      assets: {},
    });
    expect(pathPointsWithinLimits(doc([path("a", 10)]), ["a"])).toBe(true);
    expect(pathPointsWithinLimits(doc([path("a", CANVAS_LIMITS.maxPathPoints + 1)]), ["a"])).toBe(
      false,
    );
    const many = Array.from({ length: 11 }, (_, i) => path(`p${i}`, CANVAS_LIMITS.maxPathPoints));
    expect(pathPointsWithinLimits(doc(many), ["p0"])).toBe(false);
  });
});
