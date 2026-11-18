import { describe, expect, it } from "vitest";
import { applyToPoint } from "../geometry/matrix";
import { createEmptyDocument, createFrame, FIRST_PAGE_ID } from "../model/create";
import { nodePageMatrix } from "../model/geometry";
import { CANVAS_LIMITS } from "../model/limits";
import { checkSavable } from "../model/payload";
import { insertNode } from "../model/structure";
import { sampleDocument } from "../model/testing";
import { updateNode } from "../model/transform";
import { getParent } from "../model/tree";
import type { CanvasDocument } from "../model/types";
import { overflowGroupDocument } from "../tools/create/testing";
import { fitSize, placeAsset, visibleArea, visibleCenter, type PlaceAssetInput } from "./place";
import { imageAsset, svgAsset } from "./testing";

const input = (patch: Partial<PlaceAssetInput> = {}): PlaceAssetInput => ({
  pageId: "p1",
  scopeId: null,
  asset: imageAsset(200, 100),
  name: "写真",
  center: { x: 800, y: 600 },
  available: { width: 1000, height: 800 },
  parentRule: "point",
  ...patch,
});

function placed(doc: CanvasDocument, patch: Partial<PlaceAssetInput> = {}) {
  const result = placeAsset(doc, input(patch));
  if (!result.ok) throw new Error(result.reason);
  return { ...result, node: result.doc.nodes[result.id] };
}

describe("visibleArea / visibleCenter", () => {
  it("表示範囲と中央をページ座標で返す", () => {
    const viewport = { x: 100, y: 50, zoom: 2 };
    expect(visibleArea(viewport, { width: 800, height: 600 })).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
    expect(visibleCenter(viewport, { width: 800, height: 600 })).toEqual({ x: 300, y: 200 });
    expect(visibleArea(viewport, { width: 0, height: 0 })).toBeNull();
    expect(visibleCenter(viewport, { width: 0, height: 0 })).toEqual({ x: 100, y: 50 });
  });
});

describe("fitSize", () => {
  it("収まるなら元の大きさ (拡大しない)", () => {
    expect(fitSize({ width: 200, height: 100 }, { width: 1000, height: 800 })).toEqual({
      width: 200,
      height: 100,
    });
    expect(fitSize({ width: 12.5, height: 50 }, null)).toEqual({ width: 13, height: 50 });
  });

  it("大きすぎれば縦横比を保って表示範囲に収める (整数、1 以上)", () => {
    expect(fitSize({ width: 4000, height: 1000 }, { width: 1000, height: 800 })).toEqual({
      width: 1000,
      height: 250,
    });
    expect(fitSize({ width: 1000, height: 3000 }, { width: 1000, height: 600 })).toEqual({
      width: 200,
      height: 600,
    });
    expect(fitSize({ width: 16384, height: 1 }, { width: 100, height: 100 })).toEqual({
      width: 100,
      height: 1,
    });
  });
});

describe("placeAsset", () => {
  it("点を中心にページ直下へ置く", () => {
    const { node, doc, id } = placed(sampleDocument());
    expect(node).toMatchObject({
      type: "image",
      name: "写真",
      x: 700,
      y: 550,
      width: 200,
      height: 100,
    });
    expect(getParent(doc, id)).toEqual({ kind: "page", id: "p1" });
  });

  it("大きな画像は縮める。アセットは元のまま", () => {
    const { node, doc } = placed(sampleDocument(), { asset: imageAsset(4000, 2000) });
    expect(node).toMatchObject({ width: 1000, height: 500 });
    const asset = node?.type === "image" ? doc.assets[node.assetId] : undefined;
    expect(asset).toMatchObject({ width: 4000, height: 2000 });
  });

  it("frame の上なら frame の子にし、座標は frame の座標系", () => {
    const { node, doc, id, parent } = placed(sampleDocument(), {
      center: { x: 300, y: 200 },
      asset: imageAsset(20, 10),
    });
    // f2 (ページ座標 300,150) の上
    expect(parent).toEqual({ kind: "node", id: "f2" });
    expect(getParent(doc, id)).toEqual(parent);
    expect(node).toMatchObject({ x: -10, y: 45 });
  });

  it("contain: 置く矩形を丸ごと含む frame だけを親にする", () => {
    const doc = sampleDocument();
    // f (100,50 400×300) の中に収まる
    expect(
      placed(doc, { parentRule: "contain", center: { x: 200, y: 300 }, asset: imageAsset(100, 50) })
        .parent,
    ).toEqual({ kind: "node", id: "f" });
    // f2 (300,150 100×100) の上だが、はみ出すので f
    expect(
      placed(doc, { parentRule: "contain", center: { x: 350, y: 200 }, asset: imageAsset(150, 50) })
        .parent,
    ).toEqual({ kind: "node", id: "f" });
    // f より大きければページ直下
    expect(
      placed(doc, { parentRule: "contain", center: { x: 300, y: 200 }, asset: imageAsset(600, 50) })
        .parent,
    ).toEqual({ kind: "page", id: "p1" });
    // スコープが含めばスコープ
    expect(
      placed(doc, {
        parentRule: "contain",
        scopeId: "grp",
        center: { x: 160, y: 105 },
        asset: imageAsset(10, 10),
      }).parent,
    ).toEqual({ kind: "node", id: "grp" });
  });

  it("切り抜かない frame の外へはみ出した group のスコープにも置ける", () => {
    const doc = overflowGroupDocument();
    for (const parentRule of ["point", "contain"] as const) {
      const result = placed(doc, {
        pageId: "page1",
        scopeId: "g",
        parentRule,
        center: { x: 175, y: 20 },
        asset: imageAsset(10, 10),
      });
      expect(result.parent, parentRule).toEqual({ kind: "node", id: "g" });
      // group は座標系を作らないので、F の座標系で中心が (175, 20)
      expect(result.node).toMatchObject({ x: 170, y: 15, width: 10, height: 10 });
    }
    // 切り抜く frame なら、見えない所には入れない
    const clipped = placed(overflowGroupDocument(true), {
      pageId: "page1",
      scopeId: "g",
      parentRule: "point",
      center: { x: 175, y: 20 },
      asset: imageAsset(10, 10),
    });
    expect(clipped.parent).toEqual({ kind: "page", id: "page1" });
  });

  it("同じ中身のアセットは使い回す", () => {
    const first = placed(sampleDocument());
    const second = placed(first.doc, { center: { x: 900, y: 700 } });
    expect(Object.keys(second.doc.assets)).toHaveLength(1);
    const a = first.node?.type === "image" ? first.node.assetId : "";
    const b = second.node?.type === "image" ? second.node.assetId : "";
    expect(b).toBe(a);
    // 別の中身なら別のアセット
    const third = placed(second.doc, { asset: imageAsset(200, 100, 1) });
    expect(Object.keys(third.doc.assets)).toHaveLength(2);
  });

  it("SVG は埋め込み SVG として置き、保存できる", () => {
    const { node, doc } = placed(createEmptyDocument(), {
      pageId: "page1",
      asset: svgAsset(),
      name: "図",
    });
    expect(node).toMatchObject({ type: "svg", name: "図", width: 200, height: 100 });
    expect(checkSavable(doc)).toBeNull();
  });

  it("アセットの合計が上限を超えるなら置かない", () => {
    const big = imageAsset(10, 10);
    const asset = { ...big, data: big.data + "A".repeat(CANVAS_LIMITS.payloadBytes) };
    const result = placeAsset(sampleDocument(), input({ asset }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("MiB");
  });

  it("アセットの大きさが範囲外なら置かない", () => {
    const result = placeAsset(
      sampleDocument(),
      input({ asset: { ...imageAsset(10, 10), width: CANVAS_LIMITS.maxSize + 1 } }),
    );
    expect(result.ok).toBe(false);
  });

  it("深さの上限を超えるなら置かない", () => {
    let doc = sampleDocument();
    let parent = "f";
    for (let depth = 2; depth <= CANVAS_LIMITS.maxDepth; depth++) {
      const id = `deep${depth}`;
      doc = insertNode(doc, createFrame({ id, width: 400, height: 300 }), {
        kind: "node",
        id: parent,
      });
      parent = id;
    }
    const result = placeAsset(doc, input({ center: { x: 120, y: 60 }, asset: imageAsset(4, 4) }));
    expect(result.ok).toBe(false);
  });

  it("座標の範囲を超えるなら置かない", () => {
    const result = placeAsset(
      sampleDocument(),
      input({ center: { x: CANVAS_LIMITS.maxCoordinate + 1000, y: 0 } }),
    );
    expect(result.ok).toBe(false);
  });

  it("保存できない作品になるなら置かない。前から保存できない作品なら止めない", () => {
    const wrongText = { ...svgAsset(), text: "違う" };
    const result = placeAsset(createEmptyDocument(), input({ pageId: "page1", asset: wrongText }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("保存できない");

    const broken = updateNode(sampleDocument(), "r0", { opacity: 2 });
    expect(checkSavable(broken)).not.toBeNull();
    expect(placeAsset(broken, input()).ok).toBe(true);
  });
});

describe("回転した frame へ置く (§4.11.2)", () => {
  it("frame の向きにそろえ、中心を指定の点に置く", () => {
    const doc = insertNode(
      createEmptyDocument(),
      createFrame({ id: "f", x: 100, y: 100, width: 400, height: 300, rotation: 30 }),
      { kind: "page", id: FIRST_PAGE_ID },
    );
    const center = { x: 300, y: 250 }; // frame の中心
    const {
      node,
      parent,
      id,
      doc: next,
    } = placed(doc, {
      pageId: FIRST_PAGE_ID,
      center,
      asset: imageAsset(40, 20),
    });
    expect(parent).toEqual({ kind: "node", id: "f" });
    expect(node).toMatchObject({ width: 40, height: 20, rotation: 0 });
    // 置いた箱の中心は、整数に丸めた分 (0.5 以内) を除いて指定の点
    const placedCenter = applyToPoint(nodePageMatrix(next, id), { x: 20, y: 10 });
    expect(Math.hypot(placedCenter.x - center.x, placedCenter.y - center.y)).toBeLessThanOrEqual(
      Math.SQRT1_2,
    );
    expect(node).toMatchObject({ x: 180, y: 140 });
  });

  /** 90° 回した細長い frame (ページ上で x 190–220、y 10–220) */
  const tallFrameDoc = () =>
    insertNode(
      createEmptyDocument(),
      createFrame({ id: "f", x: 100, y: 100, width: 210, height: 30, rotation: 90 }),
      { kind: "page", id: FIRST_PAGE_ID },
    );

  it("contain: frame の向きで置いた箱が収まらなければ、その frame の子にしない", () => {
    // 25×200 は frame の向きではページ上で 200×25 になり、frame からはみ出す
    const { parent, node } = placed(tallFrameDoc(), {
      pageId: FIRST_PAGE_ID,
      center: { x: 205, y: 115 },
      asset: imageAsset(25, 200),
      parentRule: "contain",
    });
    expect(parent).toEqual({ kind: "page", id: FIRST_PAGE_ID });
    expect(node).toMatchObject({ x: 193, y: 15, width: 25, height: 200 });
  });

  it("contain: ページの軸の矩形ははみ出しても、frame の向きで置けば収まるなら frame の子にする", () => {
    // 200×25 は frame の向きではページ上で 25×200 になり、frame に収まる
    const { parent, node, id, doc } = placed(tallFrameDoc(), {
      pageId: FIRST_PAGE_ID,
      center: { x: 205, y: 115 },
      asset: imageAsset(200, 25),
      parentRule: "contain",
    });
    expect(parent).toEqual({ kind: "node", id: "f" });
    expect(node).toMatchObject({ width: 200, height: 25, rotation: 0 });
    const corners = [
      { x: 0, y: 0 },
      { x: 200, y: 25 },
    ].map((p) => applyToPoint(nodePageMatrix(doc, id), p));
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(190);
      expect(c.x).toBeLessThanOrEqual(220);
      expect(c.y).toBeGreaterThanOrEqual(10);
      expect(c.y).toBeLessThanOrEqual(220);
    }
  });
});
