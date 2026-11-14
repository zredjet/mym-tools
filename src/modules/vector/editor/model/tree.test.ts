import { describe, expect, it } from "vitest";
import {
  getAncestors,
  getCoordinateFrame,
  getDepth,
  getDescendantIds,
  getIndexInParent,
  getNode,
  getPageOf,
  getParent,
  getParentNode,
  isAncestorOf,
  listPageNodeIds,
  sortByZOrder,
  topLevelIds,
  walkPage,
} from "./tree";
import { fixtureDocument, sampleDocument } from "./testing";

describe("木の参照", () => {
  const doc = sampleDocument();

  it("親と位置と深さ", () => {
    expect(getParent(doc, "r0")).toEqual({ kind: "page", id: "p1" });
    expect(getParent(doc, "r2")).toEqual({ kind: "node", id: "grp" });
    expect(getParentNode(doc, "r2")?.id).toBe("grp");
    expect(getParentNode(doc, "f")).toBeNull();
    expect(getIndexInParent(doc, "f2")).toBe(2);
    expect(getDepth(doc, "f")).toBe(1);
    expect(getDepth(doc, "r3")).toBe(3);
    expect(getParent(doc, "missing")).toBeNull();
    expect(getDepth(doc, "missing")).toBe(0);
  });

  it("祖先・子孫・座標系の frame", () => {
    expect(getAncestors(doc, "r2").map((n) => n.id)).toEqual(["grp", "f"]);
    expect(isAncestorOf(doc, "f", "r3")).toBe(true);
    expect(isAncestorOf(doc, "r3", "f")).toBe(false);
    expect(getDescendantIds(doc, "f")).toEqual(["r1", "grp", "r2", "l1", "f2", "r3"]);
    expect(getCoordinateFrame(doc, "r2")?.id).toBe("f");
    expect(getCoordinateFrame(doc, "r3")?.id).toBe("f2");
    expect(getCoordinateFrame(doc, "f")).toBeNull();
  });

  it("ページの走査は深さ優先・背面から", () => {
    expect(listPageNodeIds(doc, "p1")).toEqual(["f", "r1", "grp", "r2", "l1", "f2", "r3", "r0"]);
    const seen: string[] = [];
    walkPage(doc, "p1", (node) => {
      seen.push(node.id);
      return node.id === "grp" ? "skip" : undefined;
    });
    expect(seen).toEqual(["f", "r1", "grp", "f2", "r3", "r0"]);
  });

  it("ノードが属するページ", () => {
    const full = fixtureDocument("full");
    expect(getPageOf(full, "text1")?.id).toBe("page1");
    expect(getPageOf(full, "frame2")?.id).toBe("page2");
  });

  it("重なり順と、祖先が選ばれたノードの除外", () => {
    expect(sortByZOrder(doc, ["r0", "r3", "r1", "r1", "nope"])).toEqual(["r1", "r3", "r0"]);
    expect(topLevelIds(doc, ["r3", "f", "r0", "r2"])).toEqual(["f", "r0"]);
  });

  it("Object.prototype の名前の ID を拾わない", () => {
    expect(getNode(doc, "toString")).toBeUndefined();
    expect(topLevelIds(doc, ["constructor"])).toEqual([]);
  });

  it("索引は文書ごとに作り直される", () => {
    const moved = { ...doc, pages: [{ ...doc.pages[0]!, children: ["r0", "f"] }] };
    expect(getIndexInParent(doc, "r0")).toBe(1);
    expect(getIndexInParent(moved, "r0")).toBe(0);
  });
});
