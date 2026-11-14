import { describe, expect, it } from "vitest";
import {
  guideAt,
  guideCursor,
  handleAt,
  handleCursor,
  handlePosition,
  handleSides,
  lineEndAt,
  visibleHandles,
} from "./handles";

const box = { x: 100, y: 100, width: 200, height: 100 };

describe("リサイズハンドル", () => {
  it("位置と動かす辺", () => {
    expect(handlePosition(box, "nw")).toEqual({ x: 100, y: 100 });
    expect(handlePosition(box, "e")).toEqual({ x: 300, y: 150 });
    expect(handlePosition(box, "s")).toEqual({ x: 200, y: 200 });
    expect(handleSides("ne")).toEqual({ x: 1, y: -1 });
    expect(handleSides("w")).toEqual({ x: -1, y: 0 });
  });

  it("角は辺より先。角の範囲は 6 画面 px", () => {
    expect(handleAt(box, { x: 104, y: 103 }, 1)).toBe("nw");
    expect(handleAt(box, { x: 305, y: 205 }, 1)).toBe("se");
    expect(handleAt(box, { x: 307, y: 205 }, 1)).toBeNull();
    // 倍率 2 では範囲が 3 ページ px
    expect(handleAt(box, { x: 304, y: 200 }, 2)).toBeNull();
    expect(handleAt(box, { x: 302.5, y: 200 }, 2)).toBe("se");
  });

  it("辺は全体で当たる (辺から 4 画面 px)", () => {
    expect(handleAt(box, { x: 200, y: 97 }, 1)).toBe("n");
    expect(handleAt(box, { x: 250, y: 203 }, 1)).toBe("s");
    expect(handleAt(box, { x: 298, y: 130 }, 1)).toBe("e");
    expect(handleAt(box, { x: 200, y: 150 }, 1)).toBeNull();
    expect(handleAt(box, { x: 200, y: 94 }, 1)).toBeNull();
  });

  it("画面上で小さい選択は、枠の内側ではハンドルに当てない (中を押せば動かせる)", () => {
    const small = { x: 0, y: 0, width: 10, height: 10 };
    expect(handleAt(small, { x: 2, y: 2 }, 1)).toBeNull();
    expect(handleAt(small, { x: -2, y: -2 }, 1)).toBe("nw");
    expect(handleAt(small, { x: 1, y: 1 }, 4)).toBe("nw");
  });

  it("カーソル", () => {
    expect(handleCursor("nw")).toBe("nwse-resize");
    expect(handleCursor("sw")).toBe("nesw-resize");
    expect(handleCursor("n")).toBe("ns-resize");
    expect(handleCursor("e")).toBe("ew-resize");
  });

  it("辺の中央のハンドルは、辺が短ければ描かない", () => {
    expect(visibleHandles(box, 1)).toHaveLength(8);
    expect(visibleHandles({ x: 0, y: 0, width: 20, height: 100 }, 1)).toEqual([
      "nw",
      "ne",
      "e",
      "se",
      "sw",
      "w",
    ]);
    expect(visibleHandles({ x: 0, y: 0, width: 20, height: 20 }, 1)).toEqual([
      "nw",
      "ne",
      "se",
      "sw",
    ]);
    expect(visibleHandles({ x: 0, y: 0, width: 20, height: 20 }, 2)).toHaveLength(8);
  });
});

describe("線の端点とガイド線", () => {
  it("近い方の端点", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    expect(lineEndAt(a, b, { x: 3, y: 2 }, 1)).toBe("start");
    expect(lineEndAt(a, b, { x: 97, y: -4 }, 1)).toBe("end");
    expect(lineEndAt(a, b, { x: 50, y: 0 }, 1)).toBeNull();
    // 短い線は近い方
    expect(lineEndAt(a, { x: 4, y: 0 }, { x: 3, y: 0 }, 1)).toBe("end");
  });

  it("ガイド線は 3 画面 px 以内でいちばん近いもの", () => {
    const guides = [
      { axis: "x" as const, position: 100 },
      { axis: "y" as const, position: 50 },
      { axis: "x" as const, position: 104 },
    ];
    expect(guideAt(guides, { x: 102.5, y: 0 }, 1)).toBe(2);
    expect(guideAt(guides, { x: 300, y: 52 }, 1)).toBe(1);
    expect(guideAt(guides, { x: 300, y: 54 }, 1)).toBeNull();
    expect(guideAt(guides, { x: 101, y: 0 }, 4)).toBe(null);
    expect(guideCursor("x")).toBe("ew-resize");
    expect(guideCursor("y")).toBe("ns-resize");
  });
});
