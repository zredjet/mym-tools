import { describe, expect, it } from "vitest";
import { planExport } from "../export/plan";
import { buildExportSvg } from "../export/svg";
import {
  createBoolean,
  createEllipse,
  createFrame,
  createRect,
  createStroke,
  solidPaint,
} from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { frameLabelRect } from "./frameLabels";
import { renderBounds, visibleTopLevelIds } from "./culling";

const measurer = fixedWidthMeasurer(0.5);

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

const closeRect = (
  value: { x: number; y: number; width: number; height: number } | null,
  expected: { x: number; y: number; width: number; height: number },
  digits = 9,
) => {
  expect(value).not.toBeNull();
  expect(value!.x).toBeCloseTo(expected.x, digits);
  expect(value!.y).toBeCloseTo(expected.y, digits);
  expect(value!.width).toBeCloseTo(expected.width, digits);
  expect(value!.height).toBeCloseTo(expected.height, digits);
};

describe("回転した描く範囲 (§4.11.1)", () => {
  it("1000×10 を 90° 回した矩形は、y 200〜400 の表示で画面外にならない", () => {
    const doc = docOf(
      [createRect({ id: "r", x: 0, y: 0, width: 1000, height: 10, rotation: 90, stroke: null })],
      ["r"],
    );
    closeRect(renderBounds(doc, "r", measurer), { x: 495, y: -495, width: 10, height: 1000 });
    expect(
      visibleTopLevelIds(doc, "p1", { x: 0, y: 200, width: 1000, height: 200 }, measurer),
    ).toEqual(["r"]);
  });

  it("回した楕円は形の範囲 (箱の隅を囲まない)、線の太さの半分を足す", () => {
    const doc = docOf(
      [
        createEllipse({
          id: "e",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 45,
          stroke: createStroke("#000000", 4),
        }),
      ],
      ["e"],
    );
    closeRect(renderBounds(doc, "e", measurer), { x: -2, y: -2, width: 104, height: 104 }, 2);
  });

  it("影は形と一緒に回る", () => {
    const doc = docOf(
      [
        createRect({
          id: "r",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 90,
          stroke: null,
          shadow: { x: 10, y: 0, blur: 0, color: "#000000", opacity: 1 },
        }),
      ],
      ["r"],
    );
    // 90° 回すと影のずれ (10, 0) は下向き (0, 10)
    closeRect(renderBounds(doc, "r", measurer), { x: 0, y: 0, width: 10, height: 20 });
  });

  it("回転した frame の子は祖先の行列まで掛けて囲む", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          rotation: 90,
          children: ["c"],
          stroke: null,
          clip: false,
        }),
        createRect({ id: "c", x: 10, y: 10, width: 20, height: 20, stroke: null }),
      ],
      ["f"],
    );
    closeRect(renderBounds(doc, "c", measurer), { x: 220, y: 60, width: 20, height: 20 });
    closeRect(renderBounds(doc, "f", measurer), { x: 150, y: 50, width: 100, height: 200 });
  });

  it("ブーリアンは結果の形に自分の線を足す", () => {
    const doc = docOf(
      [
        createBoolean("intersect", ["a", "b"], {
          id: "i",
          fill: solidPaint("#000000"),
          stroke: { ...createStroke("#000000", 2), join: "round" },
        }),
        createRect({ id: "a", x: 0, y: 0, width: 20, height: 20 }),
        createRect({ id: "b", x: 10, y: 10, width: 20, height: 20 }),
      ],
      ["i"],
    );
    closeRect(renderBounds(doc, "i", measurer), { x: 9, y: 9, width: 12, height: 12 });
  });
});

describe("回転した frame の書き出しとラベル (§4.11.2)", () => {
  const doc = docOf(
    [
      createFrame({
        id: "f",
        name: "回転",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        rotation: 90,
        children: ["c"],
      }),
      createRect({ id: "c", x: 10, y: 10, width: 20, height: 20 }),
    ],
    ["f"],
  );

  it("frame の範囲は回転を含めた外接矩形", () => {
    const plan = planExport(doc, "p1", ["f"], measurer);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets[0]!.bounds).toEqual({ x: 25, y: -25, width: 50, height: 100 });
  });

  it("入れ子のノードは祖先の frame の回転も掛ける", () => {
    const plan = planExport(doc, "p1", ["c"], measurer);
    if (!plan.ok) throw new Error(plan.reason);
    const svg = buildExportSvg(doc, plan.targets[0]!, { measurer });
    expect(svg).toContain('transform="matrix(0 1 -1 0 75 -25)"');
    expect(plan.targets[0]!.bounds).toEqual({ x: 45, y: -15, width: 20, height: 20 });
  });

  it("ページ直下の frame のラベルは回さず、外接矩形の左上に置く", () => {
    const rect = frameLabelRect(doc, "f", 1, measurer)!;
    expect(rect.x).toBeCloseTo(25, 9);
    expect(rect.y).toBeCloseTo(-25 - 18, 9);
  });
});
