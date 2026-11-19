/**
 * ブーリアンの結果を求められなかったとき (`booleanOperation` が null) の、外接矩形・当たり・描く範囲 (§4.15.3)。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../boolean/index", () => ({ booleanOperation: () => null }));

const { renderBounds } = await import("../canvas/culling");
const { createBoolean, createRect, solidPaint } = await import("../model/create");
const { getPageBounds } = await import("../model/geometry");
const { fixedWidthMeasurer } = await import("../render/testing");
const { hitTestPath } = await import("./hitTest");

describe("結果を求められなかったブーリアン", () => {
  const doc = {
    pages: [{ id: "p1", name: "", children: ["s"], guides: [] }],
    nodes: {
      s: createBoolean("subtract", ["a", "b"], { id: "s", fill: solidPaint("#000000") }),
      a: createRect({ id: "a", x: 0, y: 0, width: 100, height: 100 }),
      b: createRect({ id: "b", x: 50, y: 50, width: 100, height: 100 }),
    },
    assets: {},
  };

  it("外接矩形は子の外接矩形の和", () => {
    expect(getPageBounds(doc, "s")).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });

  it("当たりは子の形をそれぞれ塗りで描いたもの (描画と同じ)", () => {
    // 型抜きの結果なら当たらない所 (b の中) も、求められないときは子を重ねて描くので当たる
    expect(hitTestPath(doc, "p1", { x: 120, y: 120 }, 1)).toEqual(["s", "b"]);
    expect(hitTestPath(doc, "p1", { x: 120, y: 10 }, 1)).toBeNull();
  });

  it("描く範囲も子の形から求める", () => {
    expect(renderBounds(doc, "s", fixedWidthMeasurer())).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 150,
    });
  });
});
