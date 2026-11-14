import { describe, expect, it } from "vitest";
import { alignNodes, canAlign, canDistribute, distributeNodes, getAlignTarget } from "./align";
import { createRect } from "./create";
import { getPageBounds } from "./geometry";
import { deepFreeze, sampleDocument } from "./testing";
import type { CanvasDocument } from "./types";

describe("整列", () => {
  it("2 個以上は選択の外接矩形に揃える (別の座標系どうしでも)", () => {
    const doc = deepFreeze(sampleDocument());
    expect(getAlignTarget(doc, ["r0", "r1"])).toEqual({ x: 0, y: 0, width: 130, height: 80 });
    const left = alignNodes(doc, ["r0", "r1"], "left");
    expect(getPageBounds(left, "r1")).toMatchObject({ x: 0, y: 60 });
    expect(left.nodes["r1"]).toMatchObject({ x: -100 });
    expect(left.nodes["r0"]).toBe(doc.nodes["r0"]);
    const bottom = alignNodes(doc, ["r0", "r1"], "bottom");
    expect(getPageBounds(bottom, "r0")).toMatchObject({ y: 70 });
    const center = alignNodes(doc, ["r0", "r1"], "hcenter");
    expect(getPageBounds(center, "r0")).toMatchObject({ x: 60 });
    expect(getPageBounds(center, "r1")).toMatchObject({ x: 55 });
  });

  it("frame の中の 1 個だけなら親の frame に揃える", () => {
    const doc = deepFreeze(sampleDocument());
    expect(canAlign(doc, ["r1"])).toBe(true);
    expect(alignNodes(doc, ["r1"], "right").nodes["r1"]).toMatchObject({ x: 380 });
    expect(alignNodes(doc, ["r3"], "vcenter").nodes["r3"]).toMatchObject({ y: 45 });
    // group の中のノードは、座標系を作る frame に揃える
    expect(alignNodes(doc, ["r2"], "top").nodes["r2"]).toMatchObject({ y: 0 });
  });

  it("ページ直下の 1 個だけでは何もしない", () => {
    const doc = deepFreeze(sampleDocument());
    expect(canAlign(doc, ["r0"])).toBe(false);
    expect(alignNodes(doc, ["r0"], "left")).toBe(doc);
  });

  it("group は子ごと動き、結果は整数に丸める", () => {
    const doc = deepFreeze(sampleDocument());
    const next = alignNodes(doc, ["grp", "r1"], "vcenter");
    for (const id of ["r1", "r2"])
      for (const value of Object.values(next.nodes[id]!).filter((v) => typeof v === "number"))
        expect(Number.isInteger(value)).toBe(true);
    expect(next.nodes["l1"]).toMatchObject({ y1: 25, y2: 25 });
  });
});

describe("等間隔", () => {
  const row = (): CanvasDocument => {
    const nodes = [
      createRect({ id: "a", x: 0, y: 0, width: 10, height: 10 }),
      createRect({ id: "b", x: 30, y: 5, width: 10, height: 10 }),
      createRect({ id: "c", x: 100, y: 50, width: 20, height: 10 }),
    ];
    return deepFreeze({
      pages: [{ id: "p", name: "", children: ["c", "a", "b"], guides: [] }],
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      assets: {},
    });
  };

  it("両端を動かさずに隙間をそろえる", () => {
    const doc = row();
    const next = distributeNodes(doc, ["a", "b", "c"], "horizontal");
    expect(next.nodes["b"]).toMatchObject({ x: 50, y: 5 });
    expect(next.nodes["a"]).toBe(doc.nodes["a"]);
    expect(next.nodes["c"]).toBe(doc.nodes["c"]);
    const vertical = distributeNodes(doc, ["a", "b", "c"], "vertical");
    expect(vertical.nodes["b"]).toMatchObject({ x: 30, y: 25 });
  });

  it("3 個未満では何もしない", () => {
    const doc = row();
    expect(canDistribute(doc, ["a", "b"])).toBe(false);
    expect(distributeNodes(doc, ["a", "b"], "horizontal")).toBe(doc);
  });
});
