import { describe, expect, it } from "vitest";

import { alignNodes, distributeNodes } from "../model/align";
import { createFrame, createRect } from "../model/create";
import type { CanvasDocument } from "../model/types";
import { geometryWithinLimits, withinLimitsOrSame } from "./limits";

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
