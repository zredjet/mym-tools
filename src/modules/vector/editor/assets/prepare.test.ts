import { describe, expect, it } from "vitest";
import { CANVAS_LIMITS } from "../model/limits";
import { importedName, parseImageDataUrl, prepareImport } from "./prepare";
import { pngBase64, pngDataUrl, SAMPLE_SVG, SAMPLE_SVG_TEXT } from "./testing";

const measure = async () => ({ width: 30, height: 20 });

describe("parseImageDataUrl", () => {
  it("mime と base64 に分ける", () => {
    expect(parseImageDataUrl(pngDataUrl(1, 1))).toEqual({
      mime: "image/png",
      data: pngBase64(1, 1),
    });
    expect(parseImageDataUrl("data:image/JPEG;base64,/9j/")).toEqual({
      mime: "image/jpeg",
      data: "/9j/",
    });
  });

  it("PNG / JPEG / WebP の base64 でなければ null", () => {
    for (const value of [
      "data:image/gif;base64,R0lG",
      "data:image/png,abc",
      "data:image/png;base64,",
      "image/png;base64,abc",
      "",
    ])
      expect(parseImageDataUrl(value), value).toBeNull();
  });
});

describe("importedName", () => {
  it("ファイル名を使い、使えなければ既定の名前。上限の文字数で切る", () => {
    expect(importedName("写真", "image")).toBe("写真");
    expect(importedName(undefined, "image")).toBe("画像");
    expect(importedName("  ", "svg")).toBe("SVG");
    expect(importedName("a\uD800", "svg")).toBe("SVG");
    expect(Array.from(importedName("あ".repeat(500), "image"))).toHaveLength(
      CANVAS_LIMITS.maxNameLength,
    );
  });
});

describe("prepareImport", () => {
  it("画像: 読み込んだ大きさのアセットにする", async () => {
    const result = await prepareImport(
      { kind: "image", dataUrl: pngDataUrl(30, 20), name: "a" },
      measure,
    );
    expect(result).toEqual({
      ok: true,
      asset: { kind: "image", mime: "image/png", data: pngBase64(30, 20), width: 30, height: 20 },
      name: "a",
      notices: [],
    });
  });

  it("画像を読み込めなければ取り込まない", async () => {
    const failing = async () => {
      throw new Error("decode");
    };
    const result = await prepareImport({ kind: "image", dataUrl: pngDataUrl(1, 1) }, failing);
    expect(result.ok).toBe(false);
    const zero = await prepareImport({ kind: "image", dataUrl: pngDataUrl(1, 1) }, async () => ({
      width: 0,
      height: 0,
    }));
    expect(zero.ok).toBe(false);
  });

  it("SVG: ポリシーを通し、抽出した文字が一致すればアセットにする", async () => {
    const result = await prepareImport({
      kind: "svg",
      svg: SAMPLE_SVG,
      text: SAMPLE_SVG_TEXT,
      notices: ["draw.io の SVG を変換しました。"],
    });
    expect(result).toMatchObject({
      ok: true,
      asset: { kind: "svg", svg: SAMPLE_SVG, text: SAMPLE_SVG_TEXT, width: 200, height: 100 },
      name: "SVG",
      notices: ["draw.io の SVG を変換しました。"],
    });
  });

  it("SVG: 抽出した文字が違えば取り込まない", async () => {
    const result = await prepareImport({ kind: "svg", svg: SAMPLE_SVG, text: "こんにちは" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("一致しない");
  });

  it("SVG: ポリシーに反すれば取り込まない", async () => {
    const result = await prepareImport({
      kind: "svg",
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      text: "",
    });
    expect(result.ok).toBe(false);
  });
});
