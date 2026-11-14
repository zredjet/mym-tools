import { describe, expect, it } from "vitest";
import { addAsset } from "./assets";
import { createEmptyDocument, createFrame, createText, FIRST_PAGE_ID } from "./create";
import { createId, ID_LENGTH } from "./ids";
import { CANVAS_LIMITS, NODE_ID_PATTERN } from "./limits";
import { checkSavable, fromPayload, parsePayload, toPayload } from "./payload";
import { insertNode } from "./structure";
import { fixturePayload } from "./testing";
import { validatePayload } from "./validate";

describe("ID", () => {
  it("idPattern に合う 12 文字で、既存の ID を避ける", () => {
    const id = createId();
    expect(id).toHaveLength(ID_LENGTH);
    expect(NODE_ID_PATTERN.test(id)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => createId())).size).toBe(1000);
  });
});

describe("payload との変換", () => {
  it("空の文書は契約データの empty と同じになる", () => {
    expect(toPayload(createEmptyDocument())).toEqual(fixturePayload("empty"));
  });

  it("作った文書が検証を通る", () => {
    let doc = createEmptyDocument();
    doc = insertNode(doc, createFrame({ name: "画面", width: 393, height: 852 }), {
      kind: "page",
      id: FIRST_PAGE_ID,
    });
    doc = insertNode(doc, createText({ text: "こんにちは 世界" }), {
      kind: "page",
      id: FIRST_PAGE_ID,
    });
    const payload = toPayload(doc);
    expect(payload.text).toBe("画面 こんにちは 世界");
    expect(validatePayload(payload)).toBeNull();
    expect(checkSavable(doc)).toBeNull();
  });

  it("保存の前に参照されないアセットを落とす", () => {
    const { doc } = addAsset(createEmptyDocument(), {
      kind: "image",
      mime: "image/png",
      data: "AAAA",
      width: 1,
      height: 1,
    });
    expect(toPayload(doc).assets).toEqual({});
  });

  it("読み込みは検証してから文書にする", () => {
    const payload = fixturePayload("full");
    const ok = parsePayload(payload);
    expect(ok.ok && ok.doc).toEqual(fromPayload(payload));
    const bad = parsePayload({ ...payload, text: "x" });
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/^text: /) });
  });

  it("検索用テキストが上限を超える文書は保存できない", () => {
    let doc = createEmptyDocument();
    const text = "あ".repeat(CANVAS_LIMITS.maxTextLength);
    // 1 個 300,000 バイト。4 個で 1 MiB を超える
    for (let i = 0; i < 4; i++)
      doc = insertNode(doc, createText({ text }), { kind: "page", id: FIRST_PAGE_ID });
    expect(checkSavable(doc)).toMatch(/^text: /);
  });
});
