import { describe, expect, it } from "vitest";
import { createText } from "./create";
import { getPageBounds } from "./geometry";
import { insertNode } from "./structure";
import { deepFreeze, sampleDocument } from "./testing";
import {
  addGuide,
  mapNodes,
  moveGuide,
  removeGuide,
  resizeNodes,
  translateNodes,
  updateNode,
  updateNodes,
  updatePage,
} from "./transform";

const frozen = () => deepFreeze(sampleDocument());

describe("平行移動", () => {
  it("box・line・group (子ごと) を動かし、frame の子は動かさない", () => {
    const doc = frozen();
    const next = translateNodes(doc, ["r1", "grp", "f2"], 3, -2);
    expect(next.nodes["r1"]).toMatchObject({ x: 13, y: 8 });
    expect(next.nodes["r2"]).toMatchObject({ x: 53, y: 58 });
    expect(next.nodes["l1"]).toMatchObject({ x1: 43, y1: 38, x2: 83, y2: 38 });
    expect(next.nodes["f2"]).toMatchObject({ x: 203, y: 98 });
    expect(next.nodes["r3"]).toBe(doc.nodes["r3"]);
    expect(next.nodes["r0"]).toBe(doc.nodes["r0"]);
    expect(next.pages).toBe(doc.pages);
  });

  it("祖先と子孫を両方選んでも二重に動かさない", () => {
    const next = translateNodes(frozen(), ["grp", "r2"], 1, 0);
    expect(next.nodes["r2"]).toMatchObject({ x: 51 });
  });

  it("動かさなければ同じ文書", () => {
    const doc = frozen();
    expect(translateNodes(doc, ["r1"], 0, 0)).toBe(doc);
    expect(translateNodes(doc, [], 5, 5)).toBe(doc);
  });
});

describe("拡大縮小", () => {
  it("1 個の矩形。角丸は変えない", () => {
    const doc = frozen();
    const from = getPageBounds(doc, "r1")!;
    const next = resizeNodes(doc, ["r1"], from, { ...from, width: 40, height: 30 });
    expect(next.nodes["r1"]).toMatchObject({ x: 10, y: 10, width: 40, height: 30, radius: 4 });
  });

  it("group は子孫の位置と大きさを比例させ、線の太さは変えない", () => {
    const doc = frozen();
    const from = getPageBounds(doc, "grp")!;
    const next = resizeNodes(doc, ["grp"], from, { x: 140, y: 90, width: 80, height: 60 });
    expect(next.nodes["r2"]).toMatchObject({ x: 60, y: 80, width: 20, height: 20 });
    expect(next.nodes["l1"]).toMatchObject({ x1: 40, y1: 40, x2: 120, y2: 40 });
    expect(next.nodes["l1"]).toHaveProperty("stroke.width", 1);
    expect(getPageBounds(next, "grp")).toEqual({ x: 140, y: 90, width: 80, height: 60 });
  });

  it("複数選択は外接矩形に対する割合で比例させる (別の座標系どうしでも)", () => {
    const doc = frozen();
    const next = resizeNodes(
      doc,
      ["r0", "r1"],
      { x: 0, y: 0, width: 130, height: 80 },
      { x: 0, y: 0, width: 260, height: 160 },
    );
    expect(next.nodes["r0"]).toMatchObject({ x: 0, y: 0, width: 20, height: 20 });
    expect(getPageBounds(next, "r1")).toEqual({ x: 220, y: 120, width: 40, height: 40 });
  });

  it("frame のリサイズは子を動かさない", () => {
    const doc = frozen();
    const from = getPageBounds(doc, "f2")!;
    const next = resizeNodes(doc, ["f2"], from, { ...from, width: 200, height: 50 });
    expect(next.nodes["f2"]).toMatchObject({ width: 200, height: 50 });
    expect(next.nodes["r3"]).toBe(doc.nodes["r3"]);
  });

  it("テキストはフォントサイズを変えず、横だけなら auto-height、縦もなら fixed", () => {
    const base = insertNode(
      sampleDocument(),
      createText({ id: "t", x: 0, y: 0, width: 100, height: 20, text: "abc" }),
      { kind: "page", id: "p1" },
    );
    deepFreeze(base);
    const from = { x: 0, y: 0, width: 100, height: 20 };
    const wide = resizeNodes(base, ["t"], from, { ...from, width: 150 });
    expect(wide.nodes["t"]).toMatchObject({
      width: 150,
      height: 20,
      fontSize: 16,
      sizing: "auto-height",
    });
    const tall = resizeNodes(base, ["t"], from, { ...from, width: 150, height: 40 });
    expect(tall.nodes["t"]).toMatchObject({
      width: 150,
      height: 40,
      fontSize: 16,
      sizing: "fixed",
    });
  });

  it("round で辺を整数に丸める", () => {
    const doc = frozen();
    const next = resizeNodes(
      doc,
      ["r0"],
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 15, height: 10 },
      { round: true },
    );
    expect(next.nodes["r0"]).toMatchObject({ width: 15 });
    const scaled = resizeNodes(
      doc,
      ["grp"],
      { x: 140, y: 90, width: 40, height: 30 },
      { x: 140, y: 90, width: 47, height: 30 },
      { round: true },
    );
    for (const value of Object.values(scaled.nodes["r2"]!).filter((v) => typeof v === "number"))
      expect(Number.isInteger(value)).toBe(true);
  });

  it("from と to が同じなら同じ文書", () => {
    const doc = frozen();
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(resizeNodes(doc, ["r0"], rect, rect)).toBe(doc);
  });

  it("幅 0 の向き (水平の線の高さ) は拡大縮小せずに動かす", () => {
    const doc = frozen();
    const next = resizeNodes(
      doc,
      ["l1"],
      { x: 140, y: 90, width: 40, height: 0 },
      { x: 140, y: 100, width: 40, height: 20 },
    );
    expect(next.nodes["l1"]).toMatchObject({ y1: 50, y2: 50 });
  });
});

describe("プロパティの更新", () => {
  it("部分更新し、値が同じなら同じ文書を返す", () => {
    const doc = frozen();
    const next = updateNode(doc, "r1", { name: "ボタン", radius: 8 });
    expect(next.nodes["r1"]).toMatchObject({ name: "ボタン", radius: 8, x: 10 });
    expect(next.nodes["r2"]).toBe(doc.nodes["r2"]);
    expect(updateNode(doc, "r1", { radius: 4 })).toBe(doc);
    expect(updateNode(doc, "r1", { fill: { type: "solid", color: "#D9D9D9", opacity: 1 } })).toBe(
      doc,
    );
  });

  it("そのノードにないフィールドは足さない", () => {
    const doc = frozen();
    const next = updateNodes(doc, ["r1", "l1", "grp"], { radius: 2, opacity: 0.5 });
    expect(next.nodes["r1"]).toMatchObject({ radius: 2, opacity: 0.5 });
    expect(next.nodes["l1"]).not.toHaveProperty("radius");
    expect(next.nodes["grp"]).not.toHaveProperty("radius");
    expect(next.nodes["grp"]).toMatchObject({ opacity: 0.5 });
  });

  it("id・type・children は変えられない", () => {
    const doc = frozen();
    const patch = { id: "x", type: "ellipse", children: [] } as unknown as { name: string };
    expect(updateNode(doc, "f", patch)).toBe(doc);
  });

  it("ノードごとに違う変更", () => {
    const next = mapNodes(frozen(), ["r0", "r1"], (node) =>
      node.id === "r0" ? { visible: false } : null,
    );
    expect(next.nodes["r0"]).toMatchObject({ visible: false });
  });
});

describe("ページとガイド線", () => {
  it("名前とガイド線の追加・移動・削除", () => {
    const doc = frozen();
    expect(updatePage(doc, "p1", { name: "ページ 1" })).toBe(doc);
    const named = updatePage(doc, "p1", { name: "表紙" });
    expect(named.pages[0]!.name).toBe("表紙");
    const added = addGuide(doc, "p1", { axis: "x", position: 10 });
    expect(added.pages[0]!.guides).toEqual([{ axis: "x", position: 10 }]);
    expect(added.nodes).toBe(doc.nodes);
    const moved = moveGuide(added, "p1", 0, 20);
    expect(moved.pages[0]!.guides).toEqual([{ axis: "x", position: 20 }]);
    expect(moveGuide(moved, "p1", 0, 20)).toBe(moved);
    expect(removeGuide(moved, "p1", 0).pages[0]!.guides).toEqual([]);
    expect(removeGuide(moved, "p1", 5)).toBe(moved);
  });
});
