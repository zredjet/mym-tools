import { describe, expect, it } from "vitest";
import { createEllipse, createFrame, createRect, createStroke, createText } from "../model/create";
import { sampleDocument } from "../model/testing";
import { updateNode } from "../model/transform";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import {
  canEnter,
  hitFrameLabel,
  hitTestPath,
  isInteractive,
  isTopLevelFrame,
  pickTarget,
  STROKE_HIT_SLOP,
} from "./hitTest";
import { distanceToSegment, ellipseDistance, roundedRectDistance } from "./shapes";

/*
 * sampleDocument (ページ座標):
 *   f   frame (100,50) 400×300、子を切り抜く
 *   r1  rect (110,60) 20×20            f の子
 *   grp group [r2, l1]                  f の子
 *   r2  rect (150,110) 10×10
 *   l1  line (140,90)–(180,90) 太さ 1
 *   f2  frame (300,150) 100×100         f の子
 *   r3  rect (305,155) 10×10            f2 の子
 *   r0  rect (0,0) 10×10                ページ直下
 */
const doc = sampleDocument();
const path = (x: number, y: number, d: CanvasDocument = doc, zoom = 1) =>
  hitTestPath(d, "p1", { x, y }, zoom);

function single(node: CanvasNode): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "", children: [node.id], guides: [] }],
    nodes: { [node.id]: node },
    assets: {},
  };
}

describe("shapes", () => {
  it("線分との距離", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it("角丸の矩形の符号付き距離 (内側が負)", () => {
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    expect(roundedRectDistance({ x: 50, y: 25 }, rect, 0)).toBe(-25);
    expect(roundedRectDistance({ x: 110, y: 25 }, rect, 0)).toBe(10);
    // 角丸の外側の角は当たらない
    expect(roundedRectDistance({ x: 1, y: 1 }, rect, 20)).toBeGreaterThan(0);
    expect(roundedRectDistance({ x: 1, y: 1 }, rect, 0)).toBeLessThan(0);
  });

  it("楕円の符号付き距離は輪郭の近くで正確", () => {
    const rect = { x: 0, y: 0, width: 200, height: 100 };
    expect(ellipseDistance({ x: 200, y: 50 }, rect)).toBeCloseTo(0);
    expect(ellipseDistance({ x: 203, y: 50 }, rect)).toBeCloseTo(3, 0);
    expect(ellipseDistance({ x: 100, y: 50 }, rect)).toBeLessThan(0);
    // 外接矩形の角は外
    expect(ellipseDistance({ x: 5, y: 5 }, rect)).toBeGreaterThan(0);
  });
});

describe("hitTestPath", () => {
  it("ページ直下から当たったノードまでの道を返す", () => {
    expect(path(5, 5)).toEqual(["r0"]);
    expect(path(120, 70)).toEqual(["f", "r1"]);
    expect(path(155, 115)).toEqual(["f", "grp", "r2"]);
    expect(path(310, 160)).toEqual(["f", "f2", "r3"]);
  });

  it("frame は、子に当たらなければ矩形の中が当たる", () => {
    expect(path(400, 300)).toEqual(["f"]);
    expect(path(350, 230)).toEqual(["f", "f2"]);
    expect(path(600, 600)).toBeNull();
  });

  it("線は太さ + 4 画面 px の帯が当たる (倍率で変わる)", () => {
    const half = (1 + STROKE_HIT_SLOP) / 2; // 2.5
    expect(path(160, 90 + half - 0.1)).toEqual(["f", "grp", "l1"]);
    expect(path(160, 90 + half + 0.1)).toEqual(["f"]);
    // 倍率 4 では余裕が 1 ページ px になり、帯の半分は (1 + 1) / 2
    expect(path(160, 90.9, doc, 4)).toEqual(["f", "grp", "l1"]);
    expect(path(160, 91.1, doc, 4)).toEqual(["f"]);
  });

  it("非表示とロック中のノードは、子孫ごと当たらない", () => {
    const hidden = updateNode(doc, "grp", { visible: false });
    expect(path(155, 115, hidden)).toEqual(["f"]);
    const locked = updateNode(doc, "f2", { locked: true });
    expect(path(310, 160, locked)).toEqual(["f"]);
    const lockedTop = updateNode(doc, "f", { locked: true });
    expect(path(120, 70, lockedTop)).toBeNull();
  });

  it("子を切り抜く frame の外では子に当たらない。切り抜かなければ当たる", () => {
    const outside = updateNode(doc, "r3", { x: 150, y: 5 }); // f2 の右の外 (450..460)
    expect(path(455, 160, outside)).toEqual(["f"]);
    const noClip = updateNode(outside, "f2", { clip: false });
    expect(path(455, 160, noClip)).toEqual(["f", "f2", "r3"]);
  });

  it("塗りのない図形は線の上だけが当たる", () => {
    const rect = createRect({
      id: "a",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fill: null,
      stroke: createStroke("#000000", 4),
    });
    const d = single(rect);
    expect(hitTestPath(d, "p1", { x: 50, y: 50 }, 1)).toBeNull();
    expect(hitTestPath(d, "p1", { x: 50, y: 1 }, 1)).toEqual(["a"]);
    expect(hitTestPath(d, "p1", { x: 50, y: -3.9 }, 1)).toEqual(["a"]);
    expect(hitTestPath(d, "p1", { x: 50, y: -4.1 }, 1)).toBeNull();
    // 線もなければ輪郭の近くだけ
    const bare = single({ ...rect, stroke: null });
    expect(hitTestPath(bare, "p1", { x: 50, y: 1.9 }, 1)).toEqual(["a"]);
    expect(hitTestPath(bare, "p1", { x: 50, y: 50 }, 1)).toBeNull();
  });

  it("塗りのある図形は中と線の外側の半分が当たる。楕円は楕円の形", () => {
    const ellipse = createEllipse({ id: "e", x: 0, y: 0, width: 100, height: 50 });
    const d = single(ellipse);
    expect(hitTestPath(d, "p1", { x: 50, y: 25 }, 1)).toEqual(["e"]);
    expect(hitTestPath(d, "p1", { x: 3, y: 3 }, 1)).toBeNull();
    const stroked = single({ ...ellipse, stroke: createStroke("#000000", 10) });
    expect(hitTestPath(stroked, "p1", { x: 104, y: 25 }, 1)).toEqual(["e"]);
  });

  it("テキストは枠の中が当たる (塗りがなくても)", () => {
    const text = createText({ id: "t", x: 0, y: 0, width: 50, height: 20, text: "a", fill: null });
    expect(hitTestPath(single(text), "p1", { x: 25, y: 10 }, 1)).toEqual(["t"]);
  });

  it("前面のノードが先に当たる", () => {
    const back = createRect({ id: "back", x: 0, y: 0, width: 100, height: 100 });
    const front = createRect({ id: "front", x: 50, y: 50, width: 100, height: 100 });
    const d: CanvasDocument = {
      pages: [{ id: "p1", name: "", children: ["back", "front"], guides: [] }],
      nodes: { back, front },
      assets: {},
    };
    expect(hitTestPath(d, "p1", { x: 75, y: 75 }, 1)).toEqual(["front"]);
    expect(hitTestPath(d, "p1", { x: 25, y: 25 }, 1)).toEqual(["back"]);
  });
});

describe("hitFrameLabel", () => {
  const measurer = fixedWidthMeasurer();
  it("ページ直下の frame のラベルの上で frame を返す", () => {
    // ラベルは frame の左上の外 (高さ 16、frame との間 2 画面 px)
    expect(hitFrameLabel(doc, "p1", { x: 105, y: 40 }, 1, measurer)).toBe("f");
    expect(hitFrameLabel(doc, "p1", { x: 105, y: 55 }, 1, measurer)).toBeNull();
    // 倍率 2 では高さもページ座標で半分
    expect(hitFrameLabel(doc, "p1", { x: 105, y: 42 }, 2, measurer)).toBe("f");
    expect(hitFrameLabel(doc, "p1", { x: 105, y: 38 }, 2, measurer)).toBeNull();
  });

  it("ロック中と非表示の frame のラベルは当たらない", () => {
    const locked = updateNode(doc, "f", { locked: true });
    expect(hitFrameLabel(locked, "p1", { x: 105, y: 40 }, 1, measurer)).toBeNull();
    const hidden = updateNode(doc, "f", { visible: false });
    expect(hitFrameLabel(hidden, "p1", { x: 105, y: 40 }, 1, measurer)).toBeNull();
  });
});

describe("pickTarget", () => {
  const pick = (x: number, y: number, scope: string | null = null, options = {}) =>
    pickTarget(doc, path(x, y), scope, options);

  it("ページ直下の frame の子は直接選べる。何もない場所は null", () => {
    expect(pick(120, 70).id).toBe("r1");
    expect(pick(400, 300).id).toBeNull();
    expect(pick(5, 5).id).toBe("r0");
    expect(pick(600, 600).id).toBeNull();
  });

  it("group と入れ子の frame は全体を選ぶ", () => {
    expect(pick(155, 115).id).toBe("grp");
    expect(pick(160, 90).id).toBe("grp");
    expect(pick(310, 160).id).toBe("f2");
    expect(pick(350, 230).id).toBe("f2");
  });

  it("スコープの中ではスコープの子を選ぶ。スコープの frame の何もない場所は null", () => {
    expect(pick(155, 115, "grp")).toEqual({ id: "r2", scopeId: "grp" });
    expect(pick(310, 160, "f2")).toEqual({ id: "r3", scopeId: "f2" });
    expect(pick(350, 230, "f2")).toEqual({ id: null, scopeId: "f2" });
  });

  it("スコープの外を押すと、押した場所を含む祖先まで出る (ページ直下の frame はページ直下)", () => {
    expect(pick(120, 70, "grp")).toEqual({ id: "r1", scopeId: null });
    expect(pick(5, 5, "f2")).toEqual({ id: "r0", scopeId: null });
    expect(pick(600, 600, "grp")).toEqual({ id: null, scopeId: null });
  });

  it("deep (Cmd/Ctrl) はいちばん深いノード。ページ直下の frame の何もない場所は null", () => {
    expect(pick(155, 115, null, { deep: true }).id).toBe("r2");
    expect(pick(310, 160, null, { deep: true }).id).toBe("r3");
    expect(pick(350, 230, null, { deep: true }).id).toBe("f2");
    expect(pick(400, 300, null, { deep: true }).id).toBeNull();
  });

  it("道に選択済みのノードがあれば、それを選ぶ", () => {
    expect(pick(155, 115, null, { selection: new Set(["r2"]) }).id).toBe("r2");
    expect(pick(120, 70, null, { selection: new Set(["f"]) }).id).toBe("f");
    // ページ直下の frame の何もない場所は、frame を選んでいても null
    expect(pick(400, 300, null, { selection: new Set(["f"]) }).id).toBeNull();
  });
});

describe("補助", () => {
  it("isInteractive は祖先まで見る", () => {
    expect(isInteractive(doc, "r3")).toBe(true);
    expect(isInteractive(updateNode(doc, "f2", { visible: false }), "r3")).toBe(false);
    expect(isInteractive(updateNode(doc, "f", { locked: true }), "r3")).toBe(false);
  });

  it("canEnter は group と入れ子の frame", () => {
    expect(canEnter(doc, "grp")).toBe(true);
    expect(canEnter(doc, "f2")).toBe(true);
    expect(canEnter(doc, "f")).toBe(false);
    expect(canEnter(doc, "r1")).toBe(false);
    expect(isTopLevelFrame(doc, "f")).toBe(true);
    expect(isTopLevelFrame(doc, "f2")).toBe(false);
  });

  it("frame を新しく足しても同じ規則", () => {
    const frame = createFrame({ id: "g", x: 0, y: 0, width: 50, height: 50, children: [] });
    expect(pickTarget(single(frame), ["g"], null).id).toBeNull();
  });
});
