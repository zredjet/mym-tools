import { describe, expect, it } from "vitest";
import { createFrame } from "../../model/create";
import { insertNode } from "../../model/structure";
import { sampleDocument } from "../../model/testing";
import { updateNode } from "../../model/transform";
import { containingParent, creationParent, parentCoordinateFrame, scopeForParent } from "./parent";

// sampleDocument: ページ直下の frame `f` (100,50 400×300) の中に r1、group `grp` (r2, l1)、
// 入れ子の frame `f2` (f の中の 200,100 100×100 = ページ座標 300,150)。ページ直下に r0

const page = { kind: "page", id: "p1" } as const;
const node = (id: string) => ({ kind: "node", id }) as const;

describe("creationParent", () => {
  it("押した点の下の最も前面の frame。なければページ直下", () => {
    const doc = sampleDocument();
    expect(creationParent(doc, "p1", null, { x: 600, y: 600 })).toEqual(page);
    expect(creationParent(doc, "p1", null, { x: 150, y: 300 })).toEqual(node("f"));
    expect(creationParent(doc, "p1", null, { x: 350, y: 200 })).toEqual(node("f2"));
  });

  it("非表示・ロック中の frame は親にしない", () => {
    let doc = updateNode(sampleDocument(), "f2", { locked: true });
    expect(creationParent(doc, "p1", null, { x: 350, y: 200 })).toEqual(node("f"));
    doc = updateNode(doc, "f", { visible: false });
    expect(creationParent(doc, "p1", null, { x: 350, y: 200 })).toEqual(page);
  });

  it("切り抜く frame の外にはみ出した入れ子の frame は、見えている所だけ", () => {
    // f2 を f の右端からはみ出させる (f は 100〜500)
    const doc = updateNode(sampleDocument(), "f2", { x: 350 });
    expect(creationParent(doc, "p1", null, { x: 480, y: 200 })).toEqual(node("f2"));
    expect(creationParent(doc, "p1", null, { x: 520, y: 200 })).toEqual(page);
  });

  it("スコープの中ならスコープ (group はその外接矩形)", () => {
    const doc = sampleDocument();
    // grp の外接矩形はページ座標 140,90〜180,120
    expect(creationParent(doc, "p1", "grp", { x: 150, y: 100 })).toEqual(node("grp"));
    // スコープの外なら、点の下の frame
    expect(creationParent(doc, "p1", "grp", { x: 400, y: 300 })).toEqual(node("f"));
    expect(creationParent(doc, "p1", "f2", { x: 350, y: 200 })).toEqual(node("f2"));
  });

  it("ロック中・非表示のスコープは親にしない", () => {
    let doc = updateNode(sampleDocument(), "grp", { locked: true });
    expect(creationParent(doc, "p1", "grp", { x: 150, y: 100 })).toEqual(node("f"));
    doc = updateNode(sampleDocument(), "f2", { visible: false });
    expect(creationParent(doc, "p1", "f2", { x: 350, y: 200 })).toEqual(node("f"));
    // 祖先がロック中でも同じ
    doc = updateNode(sampleDocument(), "f", { locked: true });
    expect(creationParent(doc, "p1", "f2", { x: 350, y: 200 })).toEqual(page);
    expect(containingParent(doc, "p1", "f2", { x: 320, y: 170, width: 10, height: 10 })).toEqual(
      page,
    );
  });

  it("スコープの中の frame の上なら、その frame", () => {
    let doc = sampleDocument();
    doc = insertNode(
      doc,
      createFrame({ id: "f3", x: 10, y: 10, width: 20, height: 20 }),
      node("f2"),
    );
    expect(creationParent(doc, "p1", "f2", { x: 315, y: 165 })).toEqual(node("f3"));
  });
});

describe("scopeForParent / parentCoordinateFrame", () => {
  it("ページ直下とページ直下の frame の子はスコープなし、group と入れ子の frame はその中", () => {
    const doc = sampleDocument();
    expect(scopeForParent(doc, page)).toBeNull();
    expect(scopeForParent(doc, node("f"))).toBeNull();
    expect(scopeForParent(doc, node("f2"))).toBe("f2");
    expect(scopeForParent(doc, node("grp"))).toBe("grp");
  });

  it("スナップの候補にする frame は親の座標系の frame", () => {
    const doc = sampleDocument();
    expect(parentCoordinateFrame(doc, page)).toBeNull();
    expect(parentCoordinateFrame(doc, node("f2"))).toBe("f2");
    expect(parentCoordinateFrame(doc, node("grp"))).toBe("f");
  });
});
