import { describe, expect, it } from "vitest";

import { getBooleanResult } from "../boolean/result";
import { pointAt } from "../geometry/bezier";
import { nodeMatrix } from "../geometry/matrix";
import {
  createBoolean,
  createEllipse,
  createGroup,
  createLine,
  createPath,
  createRect,
  createStroke,
  createText,
  solidPaint,
} from "../model/create";
import { CANVAS_LIMITS } from "../model/limits";
import { checkSavable } from "../model/payload";
import type {
  CanvasDocument,
  CanvasNode,
  GroupNode,
  PathNode,
  Stroke,
  Subpath,
} from "../model/types";
import { containsPoint } from "../path/measure";
import { subpathToSegments } from "../path/segments";
import { ellipseSubpaths, rectSubpaths } from "../path/shapes";
import { transformSubpaths } from "../path/transform";
import { outlineTolerance } from "./index";
import {
  ellipseCenterline,
  OUTLINE_PART_NAMES,
  outlineNodes,
  outlineTargets,
  rectCenterline,
} from "./nodes";
import { compareStrokeOnGrid } from "./testing";

function docOf(children: string[], nodes: CanvasNode[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

function ids(): () => string {
  let n = 0;
  return () => `new${++n}`;
}

function pathOf(doc: CanvasDocument, id: string): PathNode {
  const node = doc.nodes[id];
  if (node?.type !== "path") throw new Error(`${id} はパスではない`);
  return node;
}

function groupOf(doc: CanvasDocument, id: string): GroupNode {
  const node = doc.nodes[id];
  if (node?.type !== "group") throw new Error(`${id} は group ではない`);
  return node;
}

/** パスの形を親の座標系で。 */
function parentShape(path: PathNode): Subpath[] {
  return transformSubpaths(
    path.subpaths,
    nodeMatrix(path.x, path.y, path.width, path.height, path.rotation),
  );
}

function stroke(width: number, patch: Partial<Stroke> = {}): Stroke {
  return { ...createStroke("#3366FF", width, 0.8), ...patch };
}

/** 線の面が、中心線 (親の座標系) の線と同じ見た目か。 */
function expectSameStroke(face: PathNode, centerline: Subpath[], s: Stroke) {
  const report = compareStrokeOnGrid(centerline, s, parentShape(face), {
    steps: 64,
    margin: outlineTolerance(s.width),
  });
  expect(report.mismatches.slice(0, 3)).toEqual([]);
  expect(report.boundaryOff.slice(0, 3)).toEqual([]);
}

describe("outlineTargets", () => {
  it("ほかの種類を含む選択は対象外。線のないノードとブーリアンの子は飛ばす", () => {
    const doc = docOf(
      ["r", "e", "t", "b"],
      [
        createRect({ id: "r", stroke: stroke(2) }),
        createEllipse({ id: "e" }),
        createText({ id: "t" }),
        createBoolean("union", ["c1", "c2"], { id: "b", stroke: null }),
        createRect({ id: "c1", stroke: stroke(3) }),
        createRect({ id: "c2", x: 50 }),
      ],
    );
    expect(outlineTargets(doc, ["r", "t"])).toEqual({ ok: false, reason: "unsupported" });
    expect(outlineTargets(doc, ["e"])).toEqual({ ok: false, reason: "noStroke" });
    expect(outlineTargets(doc, ["c1"])).toEqual({ ok: false, reason: "booleanChild" });
    expect(outlineTargets(doc, ["b"])).toEqual({ ok: false, reason: "noStroke" });
    const both = outlineTargets(doc, ["e", "r", "c1"]);
    expect(both.ok && both.nodes.map((n) => n.id)).toEqual(["r"]);
  });
});

describe("outlineNodes", () => {
  it("塗りのない楕円は線の面のパス 1 つ (ID・名前・表示・ロック・不透明度・影を引き継ぐ)", () => {
    const shadow = { x: 2, y: 3, blur: 4, color: "#000000", opacity: 0.5 };
    const s = stroke(6, { cap: "round", dash: [10, 4] });
    const ellipse = createEllipse({
      id: "e",
      name: "わ",
      x: 10,
      y: 20,
      width: 80,
      height: 40,
      rotation: 25,
      fill: null,
      stroke: s,
      opacity: 0.6,
      visible: false,
      locked: true,
      shadow,
    });
    const doc = docOf(["e"], [ellipse]);
    const out = outlineNodes(doc, ["e"], ids());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ids).toEqual(["e"]);
    const face = pathOf(out.doc, "e");
    expect(face).toMatchObject({
      name: "わ",
      visible: false,
      locked: true,
      opacity: 0.6,
      rotation: 0,
      stroke: null,
      fillRule: "nonzero",
      shadow,
      fill: solidPaint("#3366FF", 0.8),
    });
    const centerline = transformSubpaths(ellipseSubpaths(80, 40), nodeMatrix(10, 20, 80, 40, 25));
    expectSameStroke(face, centerline, s);
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("塗りもある回転した矩形は group (塗りの形が背面、影は塗りの形)", () => {
    const shadow = { x: 0, y: 4, blur: 8, color: "#112233", opacity: 0.25 };
    const fill = {
      type: "linear" as const,
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      stops: [
        { offset: 0, color: "#FF0000", opacity: 1 },
        { offset: 1, color: "#0000FF", opacity: 1 },
      ],
    };
    const s = stroke(8, { join: "round" });
    const rect = createRect({
      id: "r",
      name: "ボタン",
      x: 40,
      y: 30,
      width: 120,
      height: 60,
      radius: 3,
      rotation: -30,
      fill,
      stroke: s,
      opacity: 0.9,
      shadow,
    });
    const doc = docOf(["x", "r", "y"], [createRect({ id: "x" }), rect, createRect({ id: "y" })]);
    const out = outlineNodes(doc, ["r"], ids());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.doc.pages[0]!.children).toEqual(["x", "r", "y"]);
    const group = groupOf(out.doc, "r");
    expect(group).toMatchObject({ name: "ボタン", opacity: 0.9, visible: true, locked: false });
    const [fillId, faceId] = group.children;
    const fillPath = pathOf(out.doc, fillId!);
    const face = pathOf(out.doc, faceId!);
    expect(fillPath).toMatchObject({
      name: OUTLINE_PART_NAMES.fill,
      x: 40,
      y: 30,
      width: 120,
      height: 60,
      rotation: -30,
      fill,
      stroke: null,
      shadow,
      opacity: 1,
    });
    expect(face).toMatchObject({
      name: OUTLINE_PART_NAMES.stroke,
      rotation: 0,
      stroke: null,
      shadow: null,
      fill: solidPaint("#3366FF", 0.8),
    });
    const centerline = transformSubpaths(
      rectSubpaths(120, 60, 3),
      nodeMatrix(40, 30, 120, 60, -30),
    );
    expectSameStroke(face, centerline, s);
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("線は線の面のパス 1 つ。パスは塗りの形に自分の点と回転を残す", () => {
    const s = stroke(5, { cap: "square" });
    const sub: Subpath[] = [
      {
        closed: false,
        points: [
          { x: 0, y: 0, in: null, out: { x: 40, y: 0 }, mirror: "none" },
          { x: 60, y: 40, in: { x: 0, y: -30 }, out: null, mirror: "none" },
        ],
      },
    ];
    const path = {
      ...createPath(sub, { id: "p", fill: solidPaint("#00FF00"), stroke: s }),
      rotation: 40,
    };
    const doc = docOf(
      ["l", "p"],
      [createLine({ id: "l", x1: 0, y1: 100, x2: 80, y2: 130, stroke: s }), path],
    );
    const out = outlineNodes(doc, ["l", "p"], ids());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ids).toEqual(["l", "p"]);
    const line = pathOf(out.doc, "l");
    expectSameStroke(
      line,
      [
        {
          closed: false,
          points: [
            { x: 0, y: 100, in: null, out: null, mirror: "none" },
            { x: 80, y: 130, in: null, out: null, mirror: "none" },
          ],
        },
      ],
      s,
    );
    const group = groupOf(out.doc, "p");
    const fillPath = pathOf(out.doc, group.children[0]!);
    expect(fillPath.subpaths).toEqual(path.subpaths);
    expect(fillPath.rotation).toBe(40);
    expectSameStroke(pathOf(out.doc, group.children[1]!), parentShape(path), s);
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("ブーリアンは結果の形の線。子は消え、塗りの形は結果の形", () => {
    const s = stroke(4, { join: "bevel" });
    const doc = docOf(
      ["b"],
      [
        createBoolean("subtract", ["c1", "c2"], {
          id: "b",
          stroke: s,
          fill: solidPaint("#AAAAAA"),
        }),
        createRect({ id: "c1", width: 100, height: 100, rotation: 10 }),
        createEllipse({ id: "c2", x: 30, y: 30, width: 40, height: 40 }),
      ],
    );
    const result = getBooleanResult(doc, "b")!;
    const out = outlineNodes(doc, ["b"], ids());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.doc.nodes["c1"]).toBeUndefined();
    expect(out.doc.nodes["c2"]).toBeUndefined();
    const group = groupOf(out.doc, "b");
    const fillPath = pathOf(out.doc, group.children[0]!);
    expect(containsPoint(parentShape(fillPath), { x: 50, y: 50 }, "nonzero")).toBe(false);
    expect(containsPoint(parentShape(fillPath), { x: 15, y: 50 }, "nonzero")).toBe(true);
    expectSameStroke(pathOf(out.doc, group.children[1]!), result.subpaths, s);
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("group の中のノードは group の中の同じ位置に置く", () => {
    const doc = docOf(
      ["g"],
      [
        createGroup(["a", "r", "b"], { id: "g" }),
        createRect({ id: "a" }),
        createRect({ id: "r", stroke: stroke(2), fill: null }),
        createRect({ id: "b" }),
      ],
    );
    const out = outlineNodes(doc, ["r"], ids());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(groupOf(out.doc, "g").children).toEqual(["a", "r", "b"]);
    expect(out.doc.nodes["r"]?.type).toBe("path");
    expect(checkSavable(out.doc)).toBeNull();
  });

  it("線が何も描かれないとき (長さ 0 の butt の線) は当てない", () => {
    const doc = docOf(
      ["l"],
      [createLine({ id: "l", x1: 5, y1: 5, x2: 5, y2: 5, stroke: stroke(3) })],
    );
    expect(outlineNodes(doc, ["l"], ids())).toEqual({ ok: false, reason: "empty" });
  });

  it("ブーリアンの結果が求められないときは当てない", () => {
    const huge: Subpath[] = [
      {
        closed: true,
        points: [
          { x: 0, y: 0, in: null, out: null, mirror: "none" },
          { x: 2e15, y: 0, in: null, out: null, mirror: "none" },
          { x: 0, y: 10, in: null, out: null, mirror: "none" },
        ],
      },
    ];
    const doc = docOf(
      ["b"],
      [
        createBoolean("union", ["c"], { id: "b", stroke: stroke(1) }),
        createPath(huge, { id: "c" }),
      ],
    );
    expect(outlineNodes(doc, ["b"], ids())).toEqual({ ok: false, reason: "booleanFailed" });
  });

  it("ノードの数・入れ子の深さ・点の数の上限を超えるときは当てない", () => {
    // ノードの数: group にすると 2 個増える
    const filler: CanvasNode[] = [];
    for (let i = 0; i < CANVAS_LIMITS.maxNodes - 2; i++) filler.push(createRect({ id: `f${i}` }));
    const full = docOf(
      ["r", ...filler.map((n) => n.id)],
      [createRect({ id: "r", stroke: stroke(2) }), ...filler],
    );
    expect(outlineNodes(full, ["r"], ids())).toEqual({ ok: false, reason: "limits" });
    // 入れ子の深さ: いちばん深い所の塗りのある矩形
    const chain: CanvasNode[] = [];
    for (let i = 0; i < CANVAS_LIMITS.maxDepth - 1; i++)
      chain.push(
        createGroup([i === CANVAS_LIMITS.maxDepth - 2 ? "r" : `g${i + 1}`], { id: `g${i}` }),
      );
    const deep = docOf(["g0"], [...chain, createRect({ id: "r", stroke: stroke(2) })]);
    expect(checkSavable(deep)).toBeNull();
    expect(outlineNodes(deep, ["r"], ids())).toEqual({ ok: false, reason: "limits" });
    // 塗りがなければ group にしないので当てられる
    const deepNoFill = docOf(
      ["g0"],
      [...chain, createRect({ id: "r", stroke: stroke(2), fill: null })],
    );
    expect(outlineNodes(deepNoFill, ["r"], ids()).ok).toBe(true);
    // 点の数: 細かい破線
    const dashed = docOf(
      ["l"],
      [
        createLine({
          id: "l",
          x1: 0,
          y1: 0,
          x2: 30000,
          y2: 0,
          stroke: stroke(2, { dash: [3, 3] }),
        }),
      ],
    );
    const res = outlineNodes(dashed, ["l"], ids());
    expect(res.ok).toBe(false);
    expect(!res.ok && ["limits", "tooComplex"]).toContain(!res.ok && res.reason);
  });
});

/** 中心線の上の点の、本当の楕円 (中心 c、半径 rx, ry) からの距離の最大 (半径の向きの近似)。 */
function ellipseError(sub: Subpath[], cx: number, cy: number, rx: number, ry: number): number {
  let worst = 0;
  for (const seg of subpathToSegments(sub[0]!)) {
    for (let k = 0; k <= 16; k++) {
      const p = pointAt(seg, k / 16);
      const r = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      worst = Math.max(worst, Math.abs(r - 1) * Math.min(rx, ry));
    }
  }
  return worst;
}

describe("中心線", () => {
  it("楕円は描画 (本当の楕円) との差が許容値以内になるよう細かくする。始点と向きは §8.6 と同じ", () => {
    // 4 本の 3 次ベジェ (§8.6) では半径の 0.027% (1000 px で 0.27 px) ずれる
    expect(ellipseError(ellipseSubpaths(4000, 2000), 2000, 1000, 2000, 1000)).toBeGreaterThan(0.1);
    const big = ellipseCenterline(4000, 2000, 0.01);
    expect(ellipseError(big, 2000, 1000, 2000, 1000)).toBeLessThan(0.01);
    expect(big[0]!.points[0]).toMatchObject({ x: 4000, y: 1000 });
    // 時計回り (y が下向き): 次の点は下へ
    expect(big[0]!.points[1]!.y).toBeGreaterThan(1000);
    // 小さい楕円は §8.6 の形のまま
    expect(ellipseCenterline(20, 10, 0.05)).toEqual(ellipseSubpaths(20, 10));
  });

  it("角丸の矩形も同じ。角丸なしは §8.6 の形のまま", () => {
    const rr = rectCenterline(3000, 2000, 900, 0.01);
    expect(rr[0]!.points[0]).toMatchObject({ x: 900, y: 0 });
    expect(rr[0]!.points[1]).toMatchObject({ x: 2100, y: 0 });
    // 右上の角 (中心 (2100, 900)、半径 900) の上の点
    const corner = rr[0]!.points.filter((p) => p.x > 2100 && p.y < 900);
    expect(corner.length).toBeGreaterThan(0);
    for (const p of corner) expect(Math.hypot(p.x - 2100, p.y - 900)).toBeCloseTo(900, 6);
    expect(rectCenterline(100, 50, 6, 0.05)).toEqual(rectSubpaths(100, 50, 6));
    expect(rectCenterline(10, 10, 0, 0.01)).toEqual(rectSubpaths(10, 10, 0));
  });
});
