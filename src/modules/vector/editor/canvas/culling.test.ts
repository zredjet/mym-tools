import { describe, expect, it } from "vitest";
import { createFrame, createGroup, createLine, createRect, createText } from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { pageContentBounds, renderBounds, visibleTopLevelIds } from "./culling";

const measurer = fixedWidthMeasurer(0.5);

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

describe("描く範囲", () => {
  it("線の太さの半分と影を足す", () => {
    const doc = docOf(
      [
        createRect({
          id: "r",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          stroke: { color: "#000000", opacity: 1, width: 4 },
          shadow: { x: 5, y: 0, blur: 2, color: "#000000", opacity: 1 },
        }),
      ],
      ["r"],
    );
    // 線: -2〜12。影: 線の範囲を x+5 に移して blur*1.5 = 3 広げる → 0〜20 (x)、-5〜15 (y)
    expect(renderBounds(doc, "r", measurer)).toEqual({ x: -2, y: -5, width: 22, height: 20 });
  });

  it("frame の子は frame の位置へ移し、切り抜かない frame ははみ出した子も含める", () => {
    const nodes = [
      createFrame({
        id: "f",
        x: 100,
        y: 100,
        width: 50,
        height: 50,
        clip: false,
        children: ["c"],
        stroke: null,
      }),
      createRect({ id: "c", x: 200, y: 0, width: 10, height: 10, stroke: null }),
    ];
    expect(renderBounds(docOf(nodes, ["f"]), "f", measurer)).toEqual({
      x: 100,
      y: 100,
      width: 210,
      height: 50,
    });
    expect(renderBounds(docOf(nodes, ["f"]), "c", measurer)).toEqual({
      x: 300,
      y: 100,
      width: 10,
      height: 10,
    });
    const clipped = [{ ...nodes[0]!, clip: true } as CanvasNode, nodes[1]!];
    expect(renderBounds(docOf(clipped, ["f"]), "f", measurer)).toEqual({
      x: 100,
      y: 100,
      width: 50,
      height: 50,
    });
  });

  it("非表示なら null、group は表示中の子だけ", () => {
    const doc = docOf(
      [
        createGroup(["a", "b"], { id: "g" }),
        createRect({ id: "a", x: 0, y: 0, width: 10, height: 10, stroke: null }),
        createRect({ id: "b", x: 100, y: 0, width: 10, height: 10, stroke: null, visible: false }),
      ],
      ["g"],
    );
    expect(renderBounds(doc, "g", measurer)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(renderBounds(doc, "b", measurer)).toBeNull();
  });

  it("fixed のテキストははみ出した行も含める", () => {
    const text = createText({
      id: "t",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      sizing: "fixed",
      text: "abcdefghij\n2\n3",
      fontSize: 10,
      lineHeight: 20,
    });
    const bounds = renderBounds(docOf([text], ["t"]), "t", measurer);
    // 幅 10 に 2 文字ずつ折り返して 7 行 (高さ 140) になり、ノードの高さ 10 を超える
    expect(bounds?.width).toBeGreaterThanOrEqual(10);
    expect(bounds?.height).toBeGreaterThanOrEqual(140);
  });

  it("水平な線も幅 0 にならない", () => {
    const doc = docOf([createLine({ id: "l", x1: 0, y1: 5, x2: 10, y2: 5 })], ["l"]);
    expect(renderBounds(doc, "l", measurer)).toEqual({ x: -0.5, y: 4.5, width: 11, height: 1 });
  });
});

describe("画面外のページ直下のノードを描かない", () => {
  const doc = docOf(
    [
      createRect({ id: "in", x: 0, y: 0, width: 10, height: 10, stroke: null }),
      createRect({ id: "out", x: 1000, y: 0, width: 10, height: 10, stroke: null }),
      createRect({ id: "edge", x: 100, y: 0, width: 10, height: 10, stroke: null }),
      createFrame({
        id: "f",
        x: -500,
        y: 0,
        width: 10,
        height: 10,
        clip: false,
        children: ["over"],
        stroke: null,
      }),
      createRect({ id: "over", x: 520, y: 0, width: 10, height: 10, stroke: null }),
      createRect({ id: "hidden", x: 0, y: 0, width: 10, height: 10, visible: false }),
    ],
    ["in", "out", "edge", "f", "hidden"],
  );

  it("重なるものだけを重なり順のまま返す", () => {
    expect(
      visibleTopLevelIds(doc, "p1", { x: 0, y: 0, width: 100, height: 100 }, measurer),
    ).toEqual(["in", "edge", "f"]);
  });

  it("表示範囲を動かすと入れ替わる", () => {
    expect(
      visibleTopLevelIds(doc, "p1", { x: 900, y: 0, width: 200, height: 100 }, measurer),
    ).toEqual(["out"]);
  });

  it("ページの内容の範囲 (全体を表示)", () => {
    expect(pageContentBounds(doc, "p1", measurer)).toEqual({
      x: -500,
      y: 0,
      width: 1510,
      height: 10,
    });
    expect(pageContentBounds(docOf([], []), "p1", measurer)).toBeNull();
  });
});
