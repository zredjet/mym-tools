import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CHILDREN_SLOT,
  el,
  escapeXmlAttr,
  escapeXmlText,
  fillSlot,
  formatNumber,
  reactAttrName,
  svgElToReact,
  svgElToString,
} from "./svgEl";

describe("svgElToString", () => {
  it("属性と子を出し、子のない要素は自己終了にする", () => {
    const tree = el("g", { opacity: 0.5 }, [
      el("rect", { x: 1, "stroke-width": 2 }),
      el("text", {}, ["a"]),
    ]);
    expect(svgElToString(tree)).toBe(
      '<g opacity="0.5"><rect x="1" stroke-width="2"/><text>a</text></g>',
    );
  });

  it("文字と属性値をエスケープする", () => {
    const tree = el("text", { "font-family": `"A&B" <C>`, title: "a\nb\tc" }, [`<x> & "y" 'z'`]);
    expect(svgElToString(tree)).toBe(
      '<text font-family="&quot;A&amp;B&quot; &lt;C&gt;" title="a&#10;b&#9;c">&lt;x&gt; &amp; "y" \'z\'</text>',
    );
  });

  it("XML に書けない制御文字と対になっていないサロゲートを取り除く", () => {
    expect(escapeXmlText("a\u0000b\u0008c\u000Bd\u001Fe￾f")).toBe("abcdef");
    expect(escapeXmlText("x\uD800y\uDC00z😀")).toBe("xyz😀");
    expect(escapeXmlAttr("\u0001a")).toBe("a");
  });

  it("-0 は 0 にする", () => {
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(1.5)).toBe("1.5");
  });

  it("undefined の属性は el で捨てる", () => {
    expect(el("rect", { x: 1, rx: undefined })).toEqual({
      tag: "rect",
      attrs: { x: 1 },
      children: [],
    });
  });

  it("差し込み位置は文字列に出さない", () => {
    expect(svgElToString(el("g", {}, [el(CHILDREN_SLOT)]))).toBe("<g></g>");
  });
});

describe("fillSlot", () => {
  it("差し込み位置を子で置き換え、元の木は変えない", () => {
    const shell = el("g", {}, [el("rect"), el("g", { transform: "t" }, [el(CHILDREN_SLOT)])]);
    const filled = fillSlot(shell, [el("circle"), el("line")]);
    expect(svgElToString(filled)).toBe('<g><rect/><g transform="t"><circle/><line/></g></g>');
    expect(svgElToString(shell)).toBe('<g><rect/><g transform="t"></g></g>');
  });

  it("差し込み位置がなければ同じオブジェクト", () => {
    const tree = el("g", {}, [el("rect")]);
    expect(fillSlot(tree, [el("circle")])).toBe(tree);
  });
});

describe("svgElToReact", () => {
  it("属性名を React の prop 名にする", () => {
    expect(reactAttrName("stroke-width")).toBe("strokeWidth");
    expect(reactAttrName("clip-path")).toBe("clipPath");
    expect(reactAttrName("xml:space")).toBe("xmlSpace");
    expect(reactAttrName("data-node-id")).toBe("data-node-id");
    expect(reactAttrName("gradientTransform")).toBe("gradientTransform");
  });

  it("差し込み位置に slot を置き、React がエスケープする", () => {
    const tree = el("g", { "fill-opacity": 0.5 }, [el("text", {}, ["<&>"]), el(CHILDREN_SLOT)]);
    const markup = renderToStaticMarkup(
      <svg>{svgElToReact(tree, { slot: <rect data-x="1" /> })}</svg>,
    );
    expect(markup).toBe(
      '<svg><g fill-opacity="0.5"><text>&lt;&amp;&gt;</text><rect data-x="1"></rect></g></svg>',
    );
  });
});
