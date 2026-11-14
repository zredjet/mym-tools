import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame } from "../model/create";
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
