import { describe, expect, it } from "vitest";
import { createEmptyDocument, createRect, createText, FIRST_PAGE_ID } from "../model/create";
import { insertNode } from "../model/structure";
import type { CanvasDocument, TextNode } from "../model/types";
import { setBoundsField } from "../panels/sections/propertyOps";
import { fixedWidthMeasurer } from "../render/testing";
import { fitTextNodes } from "./fit";
import { applyTextStyle, parseFontFamilyInput } from "./textOps";

// 1 文字の幅は フォントサイズ × 0.5、行の高さは フォントサイズ × 1.4
const measurer = fixedWidthMeasurer();
const page = { kind: "page", id: FIRST_PAGE_ID } as const;

function documentWith(...texts: TextNode[]): CanvasDocument {
  let doc = insertNode(createEmptyDocument(), createRect({ id: "r1" }), page);
  for (const text of texts) doc = insertNode(doc, text, page);
  return fitTextNodes(doc, null, measurer);
}

const textOf = (doc: CanvasDocument, id: string) => doc.nodes[id] as TextNode;

describe("applyTextStyle", () => {
  it("テキストだけに当て、同じ変更の中で大きさを求め直す", () => {
    const doc = documentWith(
      createText({ id: "t1", text: "abcd", x: 100, width: 32, height: 23, align: "center" }),
    );
    const next = applyTextStyle(doc, ["t1", "r1"], { fontSize: 32 }, measurer);
    // 幅 32 → 64、高さ 23 → 45。中央揃えなので中心を保つ
    expect(textOf(next, "t1")).toMatchObject({ fontSize: 32, width: 64, height: 45, x: 84 });
    expect(next.nodes.r1).toBe(doc.nodes.r1);
  });

  it("大きさの決め方を変えると、その規則で求め直す", () => {
    const doc = documentWith(createText({ id: "t1", text: "abcdefgh", width: 0, height: 0 }));
    const wide = textOf(doc, "t1");
    expect(wide).toMatchObject({ width: 64, height: 23 });
    const fixed = applyTextStyle(doc, ["t1"], { sizing: "fixed", fontSize: 32 }, measurer);
    expect(textOf(fixed, "t1")).toMatchObject({ width: 64, height: 23, sizing: "fixed" });
    const autoHeight = applyTextStyle(fixed, ["t1"], { sizing: "auto-height" }, measurer);
    // 幅 64 に 32 px の文字が 4 つずつで 2 行
    expect(textOf(autoHeight, "t1")).toMatchObject({ width: 64, height: 90 });
    const autoWidth = applyTextStyle(autoHeight, ["t1"], { sizing: "auto-width" }, measurer);
    expect(textOf(autoWidth, "t1")).toMatchObject({ width: 128, height: 45 });
  });

  it("行の高さ・字間・太さ・斜体・揃えも当てる。null の行の高さは自動", () => {
    const doc = documentWith(createText({ id: "t1", text: "ab\ncd" }));
    const next = applyTextStyle(
      doc,
      ["t1"],
      { lineHeight: 30, letterSpacing: 2, fontWeight: 700, italic: true, align: "right" },
      measurer,
    );
    expect(textOf(next, "t1")).toMatchObject({
      lineHeight: 30,
      letterSpacing: 2,
      fontWeight: 700,
      italic: true,
      align: "right",
      width: 20,
      height: 60,
    });
    const auto = applyTextStyle(next, ["t1"], { lineHeight: null }, measurer);
    expect(textOf(auto, "t1")).toMatchObject({ lineHeight: null, height: 45 });
  });

  it("変わらなければ引数の文書をそのまま返す", () => {
    const doc = documentWith(createText({ id: "t1", text: "ab" }));
    expect(applyTextStyle(doc, ["t1"], { fontSize: 16 }, measurer)).toBe(doc);
    expect(applyTextStyle(doc, ["r1", "missing"], { fontSize: 30 }, measurer)).toBe(doc);
  });
});

describe("setBoundsField とテキスト", () => {
  it("auto-width のテキストの W を確定すると auto-height になり、高さは折り返した結果になる", () => {
    const doc = documentWith(createText({ id: "t1", text: "abcdefgh" }));
    const next = setBoundsField(doc, ["t1"], "width", 32, measurer);
    expect(textOf(next, "t1")).toMatchObject({ width: 32, height: 45, sizing: "auto-height" });
  });

  it("auto-height のテキストの W を変えると高さを求め直す。H を確定すると fixed になり変えない", () => {
    const doc = documentWith(
      createText({ id: "t1", text: "abcdefgh", width: 64, sizing: "auto-height" }),
    );
    const narrow = setBoundsField(doc, ["t1"], "width", 16, measurer);
    expect(textOf(narrow, "t1")).toMatchObject({ width: 16, height: 90 });
    const tall = setBoundsField(narrow, ["t1"], "height", 10, measurer);
    expect(textOf(tall, "t1")).toMatchObject({ width: 16, height: 10, sizing: "fixed" });
  });
});

describe("parseFontFamilyInput", () => {
  it("前後の空白を落とし、空・制御文字・長すぎる名前・対になっていないサロゲートを拒否する", () => {
    expect(parseFontFamilyInput("  Hiragino Sans ")).toBe("Hiragino Sans");
    expect(parseFontFamilyInput("   ")).toBeNull();
    expect(parseFontFamilyInput("A\u0007B")).toBeNull();
    expect(parseFontFamilyInput("A\u0085B")).toBeNull();
    expect(parseFontFamilyInput("a".repeat(201))).toBeNull();
    expect(parseFontFamilyInput("😀".repeat(200))).toBe("😀".repeat(200));
    expect(parseFontFamilyInput("A\uD800")).toBeNull();
  });
});
