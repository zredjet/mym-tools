import { describe, expect, it } from "vitest";
import { createFrame, createRect } from "./create";
import { extractFragment, insertFragment } from "./fragment";
import { CANVAS_LIMITS } from "./limits";
import { getPageBounds } from "./geometry";
import {
  deleteNodes,
  duplicateNodes,
  groupNodes,
  insertNode,
  moveNodes,
  reorderNodes,
  ungroupNodes,
} from "./structure";
import { deepFreeze, sampleDocument } from "./testing";
import { getDescendantIds, getParent } from "./tree";
import type { CanvasDocument } from "./types";

const frozen = () => deepFreeze(sampleDocument());
const children = (doc: CanvasDocument, id: string) => {
  const node = doc.nodes[id];
  return node && "children" in node ? node.children : undefined;
};
const page = (doc: CanvasDocument) => doc.pages[0]!.children;

describe("挿入", () => {
  it("親の指定位置に入れ、引数の文書を変えない", () => {
    const doc = frozen();
    const next = insertNode(doc, createRect({ id: "n" }), { kind: "node", id: "f" }, 1);
    expect(children(next, "f")).toEqual(["r1", "n", "grp", "f2"]);
    expect(next.nodes["r1"]).toBe(doc.nodes["r1"]);
    expect(next.pages).toBe(doc.pages);
  });

  it("既存の ID、存在しない親、子を持つノードは入れない", () => {
    const doc = frozen();
    expect(insertNode(doc, createRect({ id: "r1" }), { kind: "page", id: "p1" })).toBe(doc);
    expect(insertNode(doc, createRect({ id: "n" }), { kind: "node", id: "r1" })).toBe(doc);
    expect(insertNode(doc, createRect({ id: "n" }), { kind: "page", id: "nope" })).toBe(doc);
  });
});

describe("削除", () => {
  it("子孫ごと消す", () => {
    const doc = frozen();
    const next = deleteNodes(doc, ["f"]);
    expect(page(next)).toEqual(["r0"]);
    expect(Object.keys(next.nodes)).toEqual(["r0"]);
    expect(next.nodes["r0"]).toBe(doc.nodes["r0"]);
  });

  it("空になった group も消す", () => {
    const next = deleteNodes(frozen(), ["r2", "l1"]);
    expect(children(next, "f")).toEqual(["r1", "f2"]);
    expect(next.nodes["grp"]).toBeUndefined();
  });

  it("何も消さなければ同じ文書を返す", () => {
    const doc = frozen();
    expect(deleteNodes(doc, ["nope"])).toBe(doc);
    expect(deleteNodes(doc, [])).toBe(doc);
  });
});

describe("複製", () => {
  it("元のすぐ前面に新しい ID で置き、ずらす", () => {
    const doc = frozen();
    const { doc: next, ids } = duplicateNodes(doc, ["r1"], { x: 10, y: 10 });
    const [copy] = ids;
    expect(copy).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(children(next, "f")).toEqual(["r1", copy, "grp", "f2"]);
    expect(next.nodes[copy!]).toMatchObject({ type: "rect", x: 20, y: 20, radius: 4 });
  });

  it("group は子孫ごと新しい ID で複製し、子を動かす", () => {
    const doc = frozen();
    const { doc: next, ids } = duplicateNodes(doc, ["grp"], { x: 5, y: 0 });
    const copy = next.nodes[ids[0]!]!;
    expect(copy.type).toBe("group");
    const copied = getDescendantIds(next, copy.id);
    expect(copied).toHaveLength(2);
    expect(copied.some((id) => doc.nodes[id] !== undefined)).toBe(false);
    expect(getPageBounds(next, copy.id)).toEqual({ x: 145, y: 90, width: 40, height: 30 });
    expect(next.nodes["r2"]).toBe(doc.nodes["r2"]);
  });
});

describe("重なり順", () => {
  it("1 つ前面・背面、最前面・最背面", () => {
    const doc = frozen();
    expect(children(reorderNodes(doc, ["r1"], "forward"), "f")).toEqual(["grp", "r1", "f2"]);
    expect(children(reorderNodes(doc, ["grp"], "backward"), "f")).toEqual(["grp", "r1", "f2"]);
    expect(children(reorderNodes(doc, ["r1"], "front"), "f")).toEqual(["grp", "f2", "r1"]);
    expect(children(reorderNodes(doc, ["f2"], "back"), "f")).toEqual(["f2", "r1", "grp"]);
  });

  it("複数を選んでも相対順を保つ", () => {
    const doc = frozen();
    expect(children(reorderNodes(doc, ["r1", "grp"], "forward"), "f")).toEqual(["f2", "r1", "grp"]);
    expect(children(reorderNodes(doc, ["r1", "f2"], "front"), "f")).toEqual(["grp", "r1", "f2"]);
  });

  it("親ごとに動かす", () => {
    const next = reorderNodes(frozen(), ["r1", "f"], "front");
    expect(page(next)).toEqual(["r0", "f"]);
    // f が選ばれているので、その子孫の r1 は動かない
    expect(children(next, "f")).toEqual(["r1", "grp", "f2"]);
  });

  it("動かせなければ同じ文書を返す", () => {
    const doc = frozen();
    expect(reorderNodes(doc, ["f2"], "forward")).toBe(doc);
    expect(reorderNodes(doc, ["r1"], "back")).toBe(doc);
  });
});

describe("親の付け替え", () => {
  it("見た目の位置を保つ (frame から外へ、外から frame へ、group ごと)", () => {
    const doc = frozen();
    for (const [ids, target] of [
      [["r3"], { kind: "page", id: "p1" }],
      [["r0"], { kind: "node", id: "f2" }],
      [["grp"], { kind: "node", id: "f2" }],
      [["r2"], { kind: "node", id: "f" }],
      [["l1", "r3"], { kind: "node", id: "grp" }],
    ] as const) {
      const next = moveNodes(doc, ids, target);
      for (const id of ids) {
        expect(getParent(next, id)).toEqual(target);
        expect(getPageBounds(next, id)).toEqual(getPageBounds(doc, id));
      }
    }
  });

  it("frame の子の座標を直す", () => {
    const next = moveNodes(frozen(), ["r0"], { kind: "node", id: "f2" });
    expect(next.nodes["r0"]).toMatchObject({ x: -300, y: -150 });
    expect(children(next, "f2")).toEqual(["r3", "r0"]);
  });

  it("index の位置にある子の背面に入れる", () => {
    const doc = frozen();
    expect(children(moveNodes(doc, ["r0"], { kind: "node", id: "f" }, 1), "f")).toEqual([
      "r1",
      "r0",
      "grp",
      "f2",
    ]);
    // 同じ親の中の並べ替え (レイヤーパネル)
    expect(children(moveNodes(doc, ["f2"], { kind: "node", id: "f" }, 0), "f")).toEqual([
      "f2",
      "r1",
      "grp",
    ]);
    expect(children(moveNodes(doc, ["r1"], { kind: "node", id: "f" }, 3), "f")).toEqual([
      "grp",
      "f2",
      "r1",
    ]);
  });

  it("同じ位置へ動かすと同じ文書を返す", () => {
    const doc = frozen();
    expect(moveNodes(doc, ["grp"], { kind: "node", id: "f" }, 1)).toBe(doc);
    expect(moveNodes(doc, ["f2"], { kind: "node", id: "f" })).toBe(doc);
  });

  it("自分の子孫の中へは動かせない", () => {
    const doc = frozen();
    expect(moveNodes(doc, ["f"], { kind: "node", id: "f2" })).toBe(doc);
    expect(moveNodes(doc, ["f2"], { kind: "node", id: "f2" })).toBe(doc);
  });

  it("空になった group を消す", () => {
    const next = moveNodes(frozen(), ["r2", "l1"], { kind: "page", id: "p1" });
    expect(next.nodes["grp"]).toBeUndefined();
    expect(page(next)).toEqual(["f", "r0", "r2", "l1"]);
  });
});

describe("グループ化", () => {
  it("最も前面のノードの位置に group を作る", () => {
    const doc = frozen();
    const next = groupNodes(doc, ["f2", "r1"], "G");
    expect(children(next, "f")).toEqual(["grp", "G"]);
    expect(children(next, "G")).toEqual(["r1", "f2"]);
    expect(next.nodes["r1"]).toBe(doc.nodes["r1"]);
    expect(next.nodes["G"]).toMatchObject({ type: "group", name: "グループ", opacity: 1 });
  });

  it("別の親のノードは見た目の位置を保って移す", () => {
    const doc = frozen();
    const next = groupNodes(doc, ["r1", "r3"], "G");
    expect(getParent(next, "G")).toEqual({ kind: "node", id: "f2" });
    expect(getPageBounds(next, "r1")).toEqual(getPageBounds(doc, "r1"));
    expect(getPageBounds(next, "r3")).toEqual(getPageBounds(doc, "r3"));
    expect(children(next, "f")).toEqual(["grp", "f2"]);
  });

  it("group を解除すると子を同じ位置に並べ、不透明度を掛け合わせる", () => {
    const doc = sampleDocument();
    doc.nodes["grp"] = { ...doc.nodes["grp"]!, opacity: 0.5 };
    deepFreeze(doc);
    const next = ungroupNodes(doc, ["grp", "r1"]);
    expect(children(next, "f")).toEqual(["r1", "r2", "l1", "f2"]);
    expect(next.nodes["grp"]).toBeUndefined();
    expect(next.nodes["r2"]).toMatchObject({ x: 50, y: 60, opacity: 0.5 });
    expect(next.nodes["r1"]).toBe(doc.nodes["r1"]);
  });

  it("グループ化と解除で元に戻る", () => {
    const doc = frozen();
    const grouped = groupNodes(doc, ["r1", "grp"], "G");
    expect(ungroupNodes(grouped, ["G"])).toEqual(doc);
  });

  it("入れ子の group を同時に解除する", () => {
    const doc = frozen();
    const grouped = groupNodes(doc, ["r1", "grp"], "G");
    const next = ungroupNodes(grouped, ["G", "grp"]);
    expect(children(next, "f")).toEqual(["r1", "r2", "l1", "f2"]);
  });
});

describe("上限を超える変更の拒否", () => {
  /** frame を `depth` 段つなげた文書 (いちばん内側が `d<depth-1>`)。 */
  const chain = (depth: number): CanvasDocument => {
    const ids = Array.from({ length: depth }, (_, i) => `d${i}`);
    const nodes = Object.fromEntries(
      ids.map((id, i) => [id, createFrame({ id, children: i + 1 < depth ? [`d${i + 1}`] : [] })]),
    );
    return deepFreeze({
      pages: [{ id: "p", name: "", children: ["d0", "x"], guides: [] }],
      nodes: { ...nodes, x: createRect({ id: "x" }) },
      assets: {},
    });
  };
  const max = CANVAS_LIMITS.maxDepth;

  it("maxDepth を超える挿入・移動・グループ化・貼り付けをしない", () => {
    const doc = chain(max);
    const deepest = { kind: "node", id: `d${max - 1}` } as const;
    expect(insertNode(doc, createRect({ id: "n" }), deepest)).toBe(doc);
    expect(moveNodes(doc, ["x"], deepest)).toBe(doc);
    expect(groupNodes(doc, ["d0"], "G")).toBe(doc);
    const fragment = extractFragment(doc, ["x"])!;
    expect(insertFragment(doc, fragment, deepest)).toEqual({ doc, ids: [] });
    // 1 段浅ければ入る
    const shallower = { kind: "node", id: `d${max - 2}` } as const;
    expect(insertNode(doc, createRect({ id: "n" }), shallower)).not.toBe(doc);
    expect(moveNodes(doc, ["x"], shallower)).not.toBe(doc);
  });

  it("maxNodes を超える挿入・複製・グループ化・貼り付けをしない", () => {
    const count = CANVAS_LIMITS.maxNodes;
    const ids = Array.from({ length: count }, (_, i) => `n${i}`);
    const doc: CanvasDocument = deepFreeze({
      pages: [{ id: "p", name: "", children: ids, guides: [] }],
      nodes: Object.fromEntries(ids.map((id) => [id, createRect({ id })])),
      assets: {},
    });
    const page = { kind: "page", id: "p" } as const;
    expect(insertNode(doc, createRect({ id: "extra" }), page)).toBe(doc);
    expect(duplicateNodes(doc, ["n0"])).toEqual({ doc, ids: [] });
    expect(groupNodes(doc, ["n0", "n1"], "G")).toBe(doc);
    expect(insertFragment(doc, extractFragment(doc, ["n0"])!, page)).toEqual({ doc, ids: [] });
  });
});

describe("グループの解除とロック (レビューの指摘)", () => {
  it("ロック中の group の子はロックになる", () => {
    const doc = sampleDocument();
    doc.nodes["grp"] = { ...doc.nodes["grp"]!, locked: true };
    deepFreeze(doc);
    const next = ungroupNodes(doc, ["grp"]);
    expect(next.nodes["r2"]).toMatchObject({ locked: true });
    expect(next.nodes["l1"]).toMatchObject({ locked: true });
  });
});

describe("index の位置に動かすノード自身がある場合", () => {
  it("動かすノードを飛ばした次の子の背面に入れる", () => {
    const doc = frozen();
    // index 0 も 1 も動かすノード → 目印は f2
    expect(moveNodes(doc, ["r1", "grp"], { kind: "node", id: "f" }, 0)).toBe(doc);
    // 別の親から来るノードと、同じ親のノードを一緒に動かす (元の重なり順 grp → r0 を保つ)
    const next = moveNodes(doc, ["r0", "grp"], { kind: "node", id: "f" }, 1);
    expect(children(next, "f")).toEqual(["r1", "grp", "r0", "f2"]);
    expect(getPageBounds(next, "r0")).toEqual(getPageBounds(doc, "r0"));
  });
});
