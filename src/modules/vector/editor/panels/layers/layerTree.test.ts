import { describe, expect, it } from "vitest";

import { CANVAS_LIMITS } from "../../model/limits";
import { getNode, getParent } from "../../model/tree";
import { deepFreeze, fixtureDocument, sampleDocument } from "../../model/testing";
import type { FrameNode, RectNode } from "../../model/types";
import {
  applyLayerDrop,
  buildLayerRows,
  cachedLayerRowsKey,
  dropZoneAt,
  expandForSelection,
  layerRowsKey,
  parseLayerRowsKey,
  rangeBetween,
  resolveLayerDrop,
} from "./layerTree";

const doc = deepFreeze(sampleDocument());
const none = new Set<string>();

describe("buildLayerRows", () => {
  it("前面のノードを上に、子を親のすぐ下に並べる", () => {
    const rows = buildLayerRows(doc, "p1", none);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ["r0", 0],
      ["f", 0],
      ["f2", 1],
      ["r3", 2],
      ["grp", 1],
      ["l1", 2],
      ["r2", 2],
      ["r1", 1],
    ]);
    expect(rows.find((r) => r.id === "f")).toMatchObject({
      container: true,
      hasChildren: true,
      expanded: true,
    });
    expect(rows.find((r) => r.id === "r0")).toMatchObject({ container: false, expanded: false });
  });

  it("閉じた frame / group の子は出さない", () => {
    const rows = buildLayerRows(doc, "p1", new Set(["grp", "f2"]));
    expect(rows.map((r) => r.id)).toEqual(["r0", "f", "f2", "grp", "r1"]);
    expect(rows.find((r) => r.id === "grp")?.expanded).toBe(false);
  });

  it("子のない frame は開閉の対象にしない", () => {
    const empty = fixtureDocument("full");
    const rows = buildLayerRows(empty, empty.pages[0]!.id, none);
    for (const row of rows) {
      const node = getNode(empty, row.id);
      if (node?.type === "frame" && node.children.length === 0) expect(row.hasChildren).toBe(false);
    }
  });

  it("ないページは空", () => {
    expect(buildLayerRows(doc, "nope", none)).toEqual([]);
  });

  it("行の並びの文字列は往復でき、位置の変更では変わらない", () => {
    const rows = buildLayerRows(doc, "p1", none);
    expect(parseLayerRowsKey(layerRowsKey(rows))).toEqual(rows);
    expect(parseLayerRowsKey("")).toEqual([]);
    const moved = {
      ...doc,
      nodes: { ...doc.nodes, r0: { ...(doc.nodes.r0 as RectNode), x: 99 } },
    };
    expect(cachedLayerRowsKey(moved, "p1", none)).toBe(cachedLayerRowsKey(doc, "p1", none));
  });
});

describe("dropZoneAt", () => {
  it("葉は上半分と下半分", () => {
    expect(dropZoneAt(0.2, false)).toBe("before");
    expect(dropZoneAt(0.6, false)).toBe("after");
  });
  it("frame / group は上下 1/4 と中央", () => {
    expect(dropZoneAt(0.1, true)).toBe("before");
    expect(dropZoneAt(0.5, true)).toBe("inside");
    expect(dropZoneAt(0.9, true)).toBe("after");
  });
});

describe("resolveLayerDrop", () => {
  it("行の上は前面 (index + 1)、行の下は背面 (index)", () => {
    // f.children = [r1, grp, f2]
    expect(resolveLayerDrop(doc, ["r0"], "grp", "before", true)).toEqual({
      target: { kind: "node", id: "f" },
      index: 2,
      zone: "before",
    });
    expect(resolveLayerDrop(doc, ["r0"], "r1", "after", false)).toEqual({
      target: { kind: "node", id: "f" },
      index: 0,
      zone: "after",
    });
  });

  it("開いていて子のある frame / group の下は、その中の最前面", () => {
    expect(resolveLayerDrop(doc, ["r0"], "f2", "after", true)).toEqual({
      target: { kind: "node", id: "f2" },
      index: undefined,
      zone: "inside",
    });
    // 閉じていれば背面
    expect(resolveLayerDrop(doc, ["r0"], "f2", "after", false)?.zone).toBe("after");
  });

  it("自分自身・子孫の上と、葉の中には落とせない", () => {
    expect(resolveLayerDrop(doc, ["f"], "f", "before", true)).toBeNull();
    expect(resolveLayerDrop(doc, ["f"], "r3", "after", false)).toBeNull();
    expect(resolveLayerDrop(doc, ["r1"], "r0", "inside", false)).toBeNull();
    expect(resolveLayerDrop(doc, ["r1"], "missing", "before", false)).toBeNull();
  });

  it("frame の中へ入れると見た目の位置を保つ (moveNodes)", () => {
    const drop = resolveLayerDrop(doc, ["r0"], "r1", "before", false);
    expect(drop).not.toBeNull();
    const next = applyLayerDrop(doc, ["r0"], drop!);
    expect((next.nodes.f as FrameNode).children).toEqual(["r1", "r0", "grp", "f2"]);
    expect(next.nodes.r0).toMatchObject({ x: -100, y: -50 });
    expect(next.pages[0]!.children).toEqual(["f"]);
  });

  it("同じ親の中で並べ替える", () => {
    const drop = resolveLayerDrop(doc, ["r1"], "f2", "after", false)!;
    const next = applyLayerDrop(doc, ["r1"], drop);
    expect((next.nodes.f as FrameNode).children).toEqual(["grp", "r1", "f2"]);
    const top = resolveLayerDrop(doc, ["r1"], "f2", "before", false)!;
    expect((applyLayerDrop(doc, ["r1"], top).nodes.f as FrameNode).children).toEqual([
      "grp",
      "f2",
      "r1",
    ]);
  });

  it("group の中へ入れる。group から最後の子を出すと group が消える", () => {
    const into = resolveLayerDrop(doc, ["r1"], "grp", "inside", true)!;
    const next = applyLayerDrop(doc, ["r1"], into);
    expect(getParent(next, "r1")).toEqual({ kind: "node", id: "grp" });

    const out = resolveLayerDrop(doc, ["r2", "l1"], "r0", "before", false)!;
    const moved = applyLayerDrop(doc, ["r2", "l1"], out);
    expect(getNode(moved, "grp")).toBeUndefined();
    expect(moved.pages[0]!.children).toEqual(["f", "r0", "r2", "l1"]);
  });
});

describe("applyLayerDrop の範囲の確認", () => {
  it("座標系が変わって上限を超えるなら落とさない", () => {
    const max = CANVAS_LIMITS.maxCoordinate;
    const far = {
      ...doc,
      nodes: {
        ...doc.nodes,
        r0: { ...(doc.nodes.r0 as RectNode), x: max },
        f: { ...(doc.nodes.f as FrameNode), x: -max },
      },
    };
    const drop = resolveLayerDrop(far, ["r0"], "r1", "before", false)!;
    expect(drop).not.toBeNull();
    // そのまま動かすと frame の中での X は 2,000,000 になる
    expect(applyLayerDrop(far, ["r0"], drop)).toBe(far);
    // 範囲に収まる移動は落とせる
    expect(applyLayerDrop(doc, ["r0"], drop)).not.toBe(doc);
  });
});

describe("rangeBetween / expandForSelection", () => {
  const rows = buildLayerRows(doc, "p1", none);
  it("行の並びで起点から範囲を選ぶ (向きは問わない)", () => {
    expect(rangeBetween(rows, "f2", "grp")).toEqual(["f2", "r3", "grp"]);
    expect(rangeBetween(rows, "grp", "f2")).toEqual(["f2", "r3", "grp"]);
    expect(rangeBetween(rows, "gone", "r0")).toEqual(["r0"]);
  });

  it("選んだノードの閉じた祖先を開く", () => {
    const collapsed = new Set(["f", "f2", "grp"]);
    const next = expandForSelection(doc, ["r3"], collapsed);
    expect([...next]).toEqual(["grp"]);
    expect(expandForSelection(doc, ["r0"], collapsed)).toBe(collapsed);
  });
});
