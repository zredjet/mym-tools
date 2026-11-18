import { describe, expect, it } from "vitest";
import { applyToPoint } from "../geometry/matrix";
import { fitPathNode, fitPathNodes } from "../path/fit";
import { fixedWidthMeasurer } from "../render/testing";
import { fitTextNodes } from "../text/fit";
import { createFrame, createLine, createPath, createRect, createText } from "./create";
import { getNodeCorners, getPageBounds, nodePageMatrix } from "./geometry";
import { deepFreeze } from "./testing";
import { cleanRotation, ownScaleFactors, resizeNodeInOwnFrame, resizeNodes } from "./transform";
import type { CanvasDocument, CanvasNode, PathNode, RectNode, TextNode } from "./types";

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return deepFreeze({
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  });
}

const close = (value: { x: number; y: number }, expected: { x: number; y: number }, digits = 9) => {
  expect(value.x).toBeCloseTo(expected.x, digits);
  expect(value.y).toBeCloseTo(expected.y, digits);
};

const square = (size: number) => [
  {
    closed: true,
    points: [
      { x: 0, y: 0, in: null, out: null, mirror: "none" as const },
      { x: size, y: 0, in: null, out: { x: 0, y: 5 }, mirror: "none" as const },
      { x: size, y: size, in: null, out: null, mirror: "none" as const },
    ],
  },
];

describe("cleanRotation", () => {
  it("和の小数の誤差を落とし、(-180, 180] にそろえる", () => {
    expect(cleanRotation(0.1 + 0.2)).toBe(0.3);
    expect(cleanRotation(170 + 30)).toBe(-160);
    expect(cleanRotation(-180)).toBe(180);
    expect(cleanRotation(12.345678)).toBe(12.345678);
  });
});

describe("fitPathNodes (§4.12)", () => {
  it("点を動かして箱を合わせ、見た目を動かさない", () => {
    const base = createPath(square(10), { id: "p", x: 100, y: 50 });
    const shifted: PathNode = {
      ...base,
      subpaths: base.subpaths.map((sub) => ({
        ...sub,
        points: sub.points.map((p) => ({ ...p, x: p.x + 3, y: p.y - 2 })),
      })),
    };
    const fitted = fitPathNode(shifted);
    expect(fitted).toMatchObject({ x: 103, y: 48, width: 10, height: 10 });
    expect(fitted.subpaths[0]!.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(fitted.subpaths[0]!.points[1]!.out).toEqual({ x: 0, y: 5 });
  });

  it("回転していても、点の描かれる位置を変えない", () => {
    const base = createPath(square(10), { id: "p", x: 100, y: 50 });
    const changed: PathNode = {
      ...base,
      rotation: 30,
      subpaths: [
        {
          closed: true,
          points: [
            { x: 0, y: 0, in: null, out: null, mirror: "none" },
            { x: 25, y: 0, in: null, out: null, mirror: "none" },
            { x: 25, y: 15, in: null, out: null, mirror: "none" },
          ],
        },
      ],
    };
    const doc = docOf([changed], ["p"]);
    const next = fitPathNodes(doc, ["p"]);
    const fitted = next.nodes.p as PathNode;
    expect(fitted).toMatchObject({ width: 25, height: 15, rotation: 30 });
    const before = nodePageMatrix(doc, "p");
    const after = nodePageMatrix(next, "p");
    changed.subpaths[0]!.points.forEach((p, i) =>
      close(applyToPoint(after, fitted.subpaths[0]!.points[i]!), applyToPoint(before, p)),
    );
  });

  it("合っていれば (1e-6 以内) 文書をそのまま返す", () => {
    const doc = docOf([createPath(square(10), { id: "p" })], ["p"]);
    expect(fitPathNodes(doc, ["p"])).toBe(doc);
    expect(fitPathNodes(doc, null)).toBe(doc);
  });
});

describe("resizeNodes の回転 (§4.11.4)", () => {
  it("回転していないパスも点を写す (箱だけを変えない)", () => {
    const doc = docOf([createPath(square(10), { id: "p", x: 0, y: 0 })], ["p"]);
    const next = resizeNodes(
      doc,
      ["p"],
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 20, height: 10 },
    );
    const p = next.nodes.p as PathNode;
    expect(p).toMatchObject({ x: 0, y: 0, width: 20, height: 10 });
    expect(p.subpaths[0]!.points[1]).toMatchObject({ x: 20, y: 0, out: { x: 0, y: 5 } });
  });

  it("回転した矩形は中心を比例させ、自分の向きの倍率で大きさを変える (角度は変えない)", () => {
    const doc = docOf(
      [createRect({ id: "r", x: 0, y: 0, width: 40, height: 10, rotation: 90 })],
      ["r"],
    );
    const from = getPageBounds(doc, "r")!; // x 15..25, y -15..25
    const to = { ...from, width: from.width * 2, height: from.height };
    const next = resizeNodes(doc, ["r"], from, to);
    const r = next.nodes.r as RectNode;
    // 90° 回っているので、ページの横の倍率 2 は自分の高さに掛かる
    expect(r).toMatchObject({ width: 40, height: 20, rotation: 90 });
    close({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, { x: 25, y: 5 });
    const f = ownScaleFactors(2, 1, 90);
    expect(f).toEqual({ x: 1, y: 2 });
  });

  it("回転したテキストは自分の向きの倍率で大きさの決め方を判定する", () => {
    const doc = docOf(
      [
        createText({
          id: "t",
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          rotation: 90,
          sizing: "auto-width",
        }),
      ],
      ["t"],
    );
    const from = getPageBounds(doc, "t")!;
    // ページの縦に引く = 自分の横に引く → auto-height
    const next = resizeNodes(doc, ["t"], from, { ...from, height: from.height * 2 });
    expect(next.nodes.t).toMatchObject({ width: 80, height: 20, sizing: "auto-height" });
  });

  it("回転した frame の中の線はページ座標で端点を写す", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 90,
          children: ["l"],
        }),
        createLine({ id: "l", x1: 0, y1: 0, x2: 10, y2: 0 }),
      ],
      ["f"],
    );
    const from = getPageBounds(doc, "l")!;
    const next = resizeNodes(doc, ["l"], from, { ...from, y: from.y, height: from.height * 3 });
    const line = next.nodes.l as Extract<CanvasNode, { type: "line" }>;
    expect(line.x2 - line.x1).toBeCloseTo(30, 9);
  });
});

describe("resizeNodeInOwnFrame (§4.11.4)", () => {
  it("動かさない辺 (左上) が親の座標系で動かない", () => {
    const doc = docOf(
      [createRect({ id: "r", x: 10, y: 20, width: 40, height: 10, rotation: 30 })],
      ["r"],
    );
    const before = getNodeCorners(doc, "r")!;
    const next = resizeNodeInOwnFrame(doc, "r", { x: 0, y: 0, width: 60, height: 10 });
    const after = getNodeCorners(next, "r")!;
    close(after[0]!, before[0]!);
    close(after[3]!, before[3]!);
    expect(next.nodes.r).toMatchObject({ width: 60, height: 10, rotation: 30 });
    // 中心から (Alt): 中心が動かない
    const centered = resizeNodeInOwnFrame(doc, "r", { x: -10, y: 0, width: 60, height: 10 });
    expect((centered.nodes.r as RectNode).x).toBeCloseTo(0, 9);
    expect((centered.nodes.r as RectNode).y).toBeCloseTo(20, 9);
  });

  it("パスは点を自分の座標系で拡大する", () => {
    const doc = docOf([{ ...createPath(square(10), { id: "p" }), rotation: 45 }], ["p"]);
    const next = resizeNodeInOwnFrame(doc, "p", { x: 0, y: 0, width: 20, height: 10 });
    const p = next.nodes.p as PathNode;
    expect(p).toMatchObject({ width: 20, height: 10 });
    expect(p.subpaths[0]!.points[1]).toMatchObject({ x: 20, y: 0, out: { x: 0, y: 5 } });
    close(getNodeCorners(next, "p")![0]!, getNodeCorners(doc, "p")![0]!);
  });

  it("テキストは縦に引いたら fixed、横だけなら auto-height", () => {
    const doc = docOf(
      [createText({ id: "t", width: 40, height: 20, rotation: 10, sizing: "auto-width" })],
      ["t"],
    );
    expect(
      resizeNodeInOwnFrame(doc, "t", { x: 0, y: 0, width: 50, height: 20 }).nodes.t,
    ).toMatchObject({ sizing: "auto-height" });
    expect(
      resizeNodeInOwnFrame(doc, "t", { x: 0, y: 0, width: 40, height: 30 }).nodes.t,
    ).toMatchObject({ sizing: "fixed" });
    expect(resizeNodeInOwnFrame(doc, "t", { x: 0, y: 0, width: 40, height: 20 })).toBe(doc);
  });
});

describe("fitTextNodes の回転したテキスト (§4.11.7)", () => {
  const measurer = fixedWidthMeasurer(0.5);
  const text = (align: TextNode["align"]) =>
    createText({
      id: "t",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 90,
      text: "abcd",
      fontSize: 10,
      lineHeight: 10,
      align,
      sizing: "auto-width",
    });

  it("左揃えは左上の角、右揃えは右上の角、中央揃えは上の辺の中点を保つ", () => {
    for (const [align, at] of [
      ["left", 0],
      ["center", 0.5],
      ["right", 1],
    ] as const) {
      const doc = docOf([text(align)], ["t"]);
      const before = getNodeCorners(doc, "t")!;
      const anchorBefore = {
        x: before[0]!.x + (before[1]!.x - before[0]!.x) * at,
        y: before[0]!.y + (before[1]!.y - before[0]!.y) * at,
      };
      const next = fitTextNodes(doc, ["t"], measurer);
      expect(next.nodes.t).toMatchObject({ width: 20, height: 10 });
      const after = getNodeCorners(next, "t")!;
      close(
        {
          x: after[0]!.x + (after[1]!.x - after[0]!.x) * at,
          y: after[0]!.y + (after[1]!.y - after[0]!.y) * at,
        },
        anchorBefore,
      );
    }
  });

  it("auto-height は上の辺を保つ", () => {
    const doc = docOf(
      [{ ...text("left"), sizing: "auto-height" as const, width: 10, height: 40 }],
      ["t"],
    );
    const before = getNodeCorners(doc, "t")!;
    const next = fitTextNodes(doc, ["t"], measurer);
    expect((next.nodes.t as TextNode).height).not.toBe(40);
    const after = getNodeCorners(next, "t")!;
    close(after[0]!, before[0]!);
    close(after[1]!, before[1]!);
  });
});
