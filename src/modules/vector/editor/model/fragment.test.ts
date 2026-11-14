import { describe, expect, it } from "vitest";
import { addAsset, pruneAssets, referencedAssetIds, totalAssetBytes, utf8Length } from "./assets";
import { createEmptyDocument, createImage } from "./create";
import { extractFragment, fragmentBounds, insertFragment } from "./fragment";
import { getPageBounds } from "./geometry";
import { insertNode } from "./structure";
import { deepFreeze, fixtureDocument, sampleDocument } from "./testing";
import { getDescendantIds } from "./tree";
import type { ImageAsset } from "./types";

const PNG: ImageAsset = {
  kind: "image",
  mime: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  width: 1,
  height: 1,
};

describe("アセット", () => {
  it("同じ中身なら既存のアセットを共有する", () => {
    const doc = deepFreeze(createEmptyDocument());
    const first = addAsset(doc, PNG);
    expect(Object.keys(first.doc.assets)).toEqual([first.assetId]);
    const second = addAsset(first.doc, { ...PNG });
    expect(second.assetId).toBe(first.assetId);
    expect(second.doc).toBe(first.doc);
    const other = addAsset(first.doc, { ...PNG, mime: "image/webp" });
    expect(other.assetId).not.toBe(first.assetId);
  });

  it("参照されないアセットを落とす", () => {
    const doc = fixtureDocument("full");
    expect(pruneAssets(doc)).toBe(doc);
    const { doc: withExtra } = addAsset(doc, { ...PNG, data: PNG.data.replace("A", "B") });
    expect(Object.keys(pruneAssets(withExtra).assets).sort()).toEqual(["img1", "svgA"]);
    expect([...referencedAssetIds(doc)].sort()).toEqual(["img1", "svgA"]);
  });

  it("大きさは image の base64 の長さと svg の UTF-8 のバイト数", () => {
    const doc = fixtureDocument("full");
    const svg = doc.assets["svgA"];
    if (svg?.kind !== "svg") throw new Error("fixture");
    expect(totalAssetBytes(doc.assets)).toBe(
      PNG.data.length + new TextEncoder().encode(svg.svg).length,
    );
    for (const s of ["", "abc", "あ", "😀", "a\ud800b"])
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe("断片", () => {
  it("子孫と参照するアセットごと切り出し、根をページ座標に直す", () => {
    const doc = deepFreeze(fixtureDocument("full"));
    const fragment = extractFragment(doc, ["group1", "image1", "text1"])!;
    expect(fragment.roots).toEqual(["group1", "image1"]);
    expect(Object.keys(fragment.nodes).sort()).toEqual(["group1", "image1", "line1", "text1"]);
    expect(Object.keys(fragment.assets)).toEqual(["img1"]);
    expect(extractFragment(doc, [])).toBeNull();

    const sample = deepFreeze(sampleDocument());
    const nested = extractFragment(sample, ["r3", "grp"])!;
    expect(nested.nodes["r3"]).toMatchObject({ x: 305, y: 155 });
    expect(fragmentBounds(nested)).toEqual({ x: 140, y: 90, width: 175, height: 75 });
    // 元の文書は変わらない
    expect(sample.nodes["r3"]).toMatchObject({ x: 5, y: 5 });
  });

  it("別の文書の frame の中へ、新しい ID で見た目の位置を保って貼り付ける", () => {
    const source = deepFreeze(sampleDocument());
    const fragment = extractFragment(source, ["grp"])!;
    const target = deepFreeze(sampleDocument());
    const { doc, ids } = insertFragment(
      target,
      fragment,
      { kind: "node", id: "f2" },
      {
        offset: { x: 10, y: 10 },
      },
    );
    expect(ids).toHaveLength(1);
    expect(getDescendantIds(doc, ids[0]!)).toHaveLength(2);
    expect(getPageBounds(doc, ids[0]!)).toEqual({ x: 150, y: 100, width: 40, height: 30 });
    expect(doc.nodes["grp"]).toBe(target.nodes["grp"]);
  });

  it("アセットは同じ中身を共有し、ID が衝突すれば付け替える", () => {
    const full = deepFreeze(fixtureDocument("full"));
    const fragment = extractFragment(full, ["image1"])!;
    const page = { kind: "page", id: "page1" } as const;

    const once = insertFragment(full, fragment, page);
    expect(Object.keys(once.doc.assets).sort()).toEqual(["img1", "svgA"]);
    expect(once.doc.nodes[once.ids[0]!]).toMatchObject({ assetId: "img1" });

    // 別の中身のアセットが同じ ID で入っている文書へ
    let other = createEmptyDocument();
    other = { ...other, assets: { img1: { ...PNG, mime: "image/webp" } } };
    other = insertNode(other, createImage("img1", { id: "w" }), { kind: "page", id: "page1" });
    const pasted = insertFragment(other, fragment, { kind: "page", id: "page1" });
    const assetId = (pasted.doc.nodes[pasted.ids[0]!] as { assetId: string }).assetId;
    expect(assetId).not.toBe("img1");
    expect(pasted.doc.assets[assetId]).toEqual(PNG);
    expect(pasted.doc.assets["img1"]).toEqual({ ...PNG, mime: "image/webp" });
  });

  it("存在しない親には入れない", () => {
    const doc = deepFreeze(sampleDocument());
    const fragment = extractFragment(doc, ["r1"])!;
    expect(insertFragment(doc, fragment, { kind: "node", id: "r0" })).toEqual({ doc, ids: [] });
  });
});
