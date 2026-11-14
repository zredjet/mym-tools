import { describe, expect, it } from "vitest";
import { createEmptyDocument, createText, FIRST_PAGE_ID } from "../model/create";
import { groupNodes, insertNode } from "../model/structure";
import type { CanvasDocument, TextNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { fitTextNodes } from "./fit";

// 1 文字の幅は フォントサイズ 16 × 0.5 = 8、行の高さは 16 × 1.4 = 22.4
const measurer = fixedWidthMeasurer();
const page = { kind: "page", id: FIRST_PAGE_ID } as const;

function docWith(...nodes: TextNode[]): CanvasDocument {
  return nodes.reduce((doc, node) => insertNode(doc, node, page), createEmptyDocument());
}

function textOf(doc: CanvasDocument, id: string): TextNode {
  return doc.nodes[id] as TextNode;
}

describe("fitTextNodes", () => {
  it("auto-width は幅と高さを本文に合わせ、切り上げた整数にする", () => {
    const doc = docWith(createText({ id: "t1", text: "abc\nde", x: 10, y: 20 }));
    const next = fitTextNodes(doc, ["t1"], measurer);
    expect(textOf(next, "t1")).toMatchObject({ x: 10, y: 20, width: 24, height: 45 });
  });

  it("auto-width は揃えに応じて左端・中心・右端を保つ", () => {
    const doc = docWith(
      createText({ id: "left", text: "abcd", x: 100, width: 10, align: "left" }),
      createText({ id: "center", text: "abcd", x: 100, width: 10, align: "center" }),
      createText({ id: "right", text: "abcd", x: 100, width: 10, align: "right" }),
    );
    const next = fitTextNodes(doc, null, measurer);
    // 幅は 10 → 32 (22 増える)
    expect(textOf(next, "left")).toMatchObject({ x: 100, width: 32 });
    expect(textOf(next, "center")).toMatchObject({ x: 89, width: 32 });
    expect(textOf(next, "right")).toMatchObject({ x: 78, width: 32 });
  });

  it("auto-height は高さだけを合わせ、幅と位置は変えない", () => {
    const doc = docWith(
      createText({ id: "t1", text: "abc", x: 5, width: 200, height: 3, sizing: "auto-height" }),
    );
    const next = fitTextNodes(doc, ["t1"], measurer);
    expect(textOf(next, "t1")).toMatchObject({ x: 5, width: 200, height: 23 });
  });

  it("fixed は変えない", () => {
    const doc = docWith(
      createText({ id: "t1", text: "abc", width: 7, height: 3, sizing: "fixed" }),
    );
    expect(fitTextNodes(doc, ["t1"], measurer)).toBe(doc);
  });

  it("変わるものがなければ、引数の文書そのものを返す", () => {
    const doc = docWith(createText({ id: "t1", text: "abc" }));
    const fitted = fitTextNodes(doc, null, measurer);
    expect(fitted).not.toBe(doc);
    expect(fitTextNodes(fitted, null, measurer)).toBe(fitted);
    expect(fitTextNodes(fitted, ["t1"], measurer)).toBe(fitted);
  });

  it("ids の子孫のテキストも対象にし、ほかのテキストは変えない", () => {
    const base = docWith(
      createText({ id: "t1", text: "abc" }),
      createText({ id: "t2", text: "abc" }),
      createText({ id: "t3", text: "abc" }),
    );
    const doc = groupNodes(base, ["t1", "t2"], "g1");
    expect(doc.nodes.g1).toBeDefined();
    const next = fitTextNodes(doc, ["g1"], measurer);
    expect(textOf(next, "t1").width).toBe(24);
    expect(textOf(next, "t2").width).toBe(24);
    expect(next.nodes.t3).toBe(doc.nodes.t3);
  });

  it("ids が null なら文書のすべてのテキストを対象にする", () => {
    const doc = docWith(createText({ id: "t1", text: "a" }), createText({ id: "t2", text: "ab" }));
    const next = fitTextNodes(doc, null, measurer);
    expect(textOf(next, "t1").width).toBe(8);
    expect(textOf(next, "t2").width).toBe(16);
  });

  it("ない ID とテキストでないノードは無視する", () => {
    const doc = docWith(createText({ id: "t1", text: "abc", width: 24, height: 23 }));
    expect(fitTextNodes(doc, ["missing", "__proto__"], measurer)).toBe(doc);
  });

  it("計測が数値を返さなければ、今の大きさを残す", () => {
    const doc = docWith(createText({ id: "t1", text: "abc", width: 7, height: 3 }));
    expect(fitTextNodes(doc, null, { measure: () => Number.NaN })).toBe(doc);
  });
});
