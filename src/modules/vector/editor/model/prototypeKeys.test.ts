/**
 * `__proto__` や `constructor` のような、`Object.prototype` と同じ名前の ID の回帰テスト。
 * 検証は `__proto__` を拒否するが、検証を通さずに作られた文書でも、コピー・切り取り・貼り付けと
 * アセットの整理で ID やアセットが消えないことを確かめる。
 *
 * `__proto__` を自分のプロパティとして持つ表は、オブジェクトリテラルや代入では作れない
 * (プロトタイプの setter に入る) ので、`JSON.parse` で作る。
 */
import { describe, expect, it } from "vitest";
import { pruneAssets } from "./assets";
import { createEmptyDocument, createImage, createRect, FIRST_PAGE_ID } from "./create";
import { extractFragment, insertFragment } from "./fragment";
import { getPageBounds } from "./geometry";
import { hasOwn } from "./ids";
import { toPayload } from "./payload";
import { deleteNodes } from "./structure";
import { deepFreeze } from "./testing";
import type { CanvasDocument, ImageAsset } from "./types";

const PNG: ImageAsset = {
  kind: "image",
  mime: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  width: 1,
  height: 1,
};

/** 仮の名前で組み立ててから、JSON の文字列の上で ID を差し替える。 */
function parseWithIds(doc: CanvasDocument, rename: Record<string, string>): CanvasDocument {
  let json = JSON.stringify(doc);
  for (const [from, to] of Object.entries(rename)) json = json.split(`"${from}"`).join(`"${to}"`);
  return deepFreeze(JSON.parse(json) as CanvasDocument);
}

/**
 * ページ直下に 3 個:
 * - `__proto__` rect (10, 20) 30×40
 * - `constructor` rect (100, 0) 10×10
 * - `img` image (0, 200)。アセットの ID は `__proto__`
 */
function prototypeDocument(): CanvasDocument {
  const doc: CanvasDocument = {
    pages: [{ id: "p", name: "", children: ["PROTO", "CTOR", "img"], guides: [] }],
    nodes: {
      PROTO: createRect({ id: "PROTO", x: 10, y: 20, width: 30, height: 40 }),
      CTOR: createRect({ id: "CTOR", x: 100, y: 0, width: 10, height: 10 }),
      img: createImage("APROTO", { id: "img", x: 0, y: 200 }),
    },
    assets: { APROTO: PNG },
  };
  const parsed = parseWithIds(doc, {
    PROTO: "__proto__",
    CTOR: "constructor",
    APROTO: "__proto__",
  });
  // 前提: どちらも自分のプロパティで、表のプロトタイプは書き換わっていない
  expect(hasOwn(parsed.nodes, "__proto__")).toBe(true);
  expect(hasOwn(parsed.nodes, "constructor")).toBe(true);
  expect(hasOwn(parsed.assets, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(parsed.nodes)).toBe(Object.prototype);
  return parsed;
}

const page = { kind: "page", id: "p" } as const;

describe("Object.prototype と同じ名前の ID", () => {
  it("extractFragment は __proto__ と constructor のノードを両方とも断片に含める", () => {
    const doc = prototypeDocument();
    const fragment = extractFragment(doc, ["__proto__", "constructor"])!;
    expect(fragment.roots).toEqual(["__proto__", "constructor"]);
    expect(Object.keys(fragment.nodes).sort()).toEqual(["__proto__", "constructor"]);
    expect(hasOwn(fragment.nodes, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(fragment.nodes)).toBe(Object.prototype);
    expect(fragment.nodes["__proto__"]).toMatchObject({ type: "rect", x: 10, y: 20 });
    expect(fragment.nodes["constructor"]).toMatchObject({ type: "rect", x: 100, y: 0 });
  });

  it("切り取り (削除) のあと insertFragment で 2 個とも戻る", () => {
    const doc = prototypeDocument();
    const fragment = extractFragment(doc, ["__proto__", "constructor"])!;
    const cut = deleteNodes(doc, ["__proto__", "constructor"]);
    expect(hasOwn(cut.nodes, "__proto__")).toBe(false);
    expect(hasOwn(cut.nodes, "constructor")).toBe(false);
    expect(cut.pages[0]!.children).toEqual(["img"]);

    const { doc: pasted, ids } = insertFragment(cut, fragment, page);
    expect(ids).toHaveLength(2);
    expect(pasted.pages[0]!.children).toEqual(["img", ...ids]);
    expect(Object.keys(pasted.nodes)).toHaveLength(3);
    expect(getPageBounds(pasted, ids[0]!)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(getPageBounds(pasted, ids[1]!)).toEqual({ x: 100, y: 0, width: 10, height: 10 });
  });

  it("アセットの ID が __proto__ の画像も、断片・貼り付け・pruneAssets・toPayload で消えない", () => {
    const doc = prototypeDocument();
    const fragment = extractFragment(doc, ["img"])!;
    expect(Object.keys(fragment.assets)).toEqual(["__proto__"]);
    expect(fragment.assets["__proto__"]).toEqual(PNG);

    // 切り取った文書へ戻す (アセットは文書に残っているので共有する)
    const cut = deleteNodes(doc, ["img"]);
    const back = insertFragment(cut, fragment, page);
    expect(back.doc.nodes[back.ids[0]!]).toMatchObject({ type: "image", assetId: "__proto__" });
    expect(Object.keys(back.doc.assets)).toEqual(["__proto__"]);

    // 別の空の文書へ貼る (アセットの ID はそのまま使える)
    const other = insertFragment(createEmptyDocument(), fragment, {
      kind: "page",
      id: FIRST_PAGE_ID,
    });
    expect(other.doc.nodes[other.ids[0]!]).toMatchObject({ assetId: "__proto__" });
    expect(hasOwn(other.doc.assets, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(other.doc.assets)).toBe(Object.prototype);

    // pruneAssets は参照されているので残す。参照されないアセットを落として表を作り直す経路でも残す
    for (const result of [back.doc, other.doc]) {
      expect(Object.keys(pruneAssets(result).assets)).toEqual(["__proto__"]);
      const payload = toPayload(result);
      expect(Object.keys(payload.assets)).toEqual(["__proto__"]);
      // 保存する JSON にも自分のプロパティとして出る (vitest の toHaveProperty は __proto__ の経路を辿らない)
      const saved = (JSON.parse(JSON.stringify(payload)) as { assets: object }).assets;
      expect(Object.getOwnPropertyDescriptor(saved, "__proto__")?.value).toEqual(PNG);
    }
    const withUnused = parseWithIds(
      { ...back.doc, assets: { APROTO: PNG, unused: { ...PNG, mime: "image/webp" } } },
      { APROTO: "__proto__" },
    );
    const pruned = pruneAssets(withUnused);
    expect(pruned).not.toBe(withUnused);
    expect(Object.keys(pruned.assets)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(pruned.assets)).toBe(Object.prototype);
    expect(Object.keys(toPayload(withUnused).assets)).toEqual(["__proto__"]);
  });
});
