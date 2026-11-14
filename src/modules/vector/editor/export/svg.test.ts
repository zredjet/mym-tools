import { describe, expect, it } from "vitest";

import { createRect, createText } from "../model/create";
import { insertNode } from "../model/structure";
import { deepFreeze, fixtureDocument } from "../model/testing";
import { updateNodes } from "../model/transform";
import type { CanvasDocument, LinearGradientPaint } from "../model/types";
import { buildNodeSvg } from "../render/buildNodeSvg";
import { svgElToString } from "../render/svgEl";
import { fixedWidthMeasurer } from "../render/testing";
import { planExport } from "./plan";
import {
  buildExportSvg,
  checkExportSvg,
  EXPORT_ID_PREFIX,
  MAX_EXPORT_SVG_BYTES,
  utf8ByteLength,
} from "./svg";
import { exportDocument } from "./testing";
import type { ExportTarget } from "./types";

const measurer = fixedWidthMeasurer();

function parse(svg: string): Document {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(parsed.querySelector("parsererror")).toBeNull();
  return parsed;
}

function onlyTarget(doc: CanvasDocument, selection: string[]): ExportTarget {
  const plan = planExport(doc, "p1", selection, measurer);
  if (!plan.ok) throw new Error(plan.reason);
  const [target] = plan.targets;
  if (!target) throw new Error("no target");
  return target;
}

const GRADIENT: LinearGradientPaint = {
  type: "linear",
  from: { x: 0, y: 0 },
  to: { x: 1, y: 1 },
  stops: [
    { offset: 0, color: "#FF0000", opacity: 1 },
    { offset: 1, color: "#0000FF", opacity: 1 },
  ],
};

describe("buildExportSvg", () => {
  it("ルートの svg に xmlns・width・height・viewBox (範囲のページ座標) を付ける", () => {
    const doc = deepFreeze(exportDocument());
    const svg = buildExportSvg(doc, onlyTarget(doc, ["fn"]), { measurer });
    const root = parse(svg).documentElement;
    expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(root.localName).toBe("svg");
    expect(root.getAttribute("width")).toBe("40");
    expect(root.getAttribute("height")).toBe("30");
    expect(root.getAttribute("viewBox")).toBe("150 70 40 30");
  });

  it("ノードは画面と同じ buildNodeSvg の結果を、親の座標系の原点へ移して置く", () => {
    const doc = exportDocument();
    const svg = buildExportSvg(doc, onlyTarget(doc, ["fn"]), { measurer });
    const inner = svgElToString(buildNodeSvg(doc, "fn", { measurer, idPrefix: EXPORT_ID_PREFIX })!);
    // fn は fa (100, 50) の子なので、fa の原点へ移す
    expect(svg).toContain(`<g transform="translate(100 50)">${inner}</g>`);
    // ページ直下のノードは移さない
    const top = buildExportSvg(doc, onlyTarget(doc, ["fb"]), { measurer });
    const fb = svgElToString(buildNodeSvg(doc, "fb", { measurer, idPrefix: EXPORT_ID_PREFIX })!);
    expect(top).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="400 50 100 100">${fb}</svg>`,
    );
  });

  it("scale は width と height だけに掛ける", () => {
    const doc = exportDocument();
    const root = parse(
      buildExportSvg(doc, onlyTarget(doc, ["fn"]), { measurer, scale: 3 }),
    ).documentElement;
    expect(root.getAttribute("width")).toBe("120");
    expect(root.getAttribute("height")).toBe("90");
    expect(root.getAttribute("viewBox")).toBe("150 70 40 30");
  });

  it("複数のノードを入れても <defs> の ID は重ならない", () => {
    const shadow = { x: 2, y: 2, blur: 4, color: "#000000", opacity: 0.5 };
    const doc = updateNodes(exportDocument(), ["ra", "r2", "fb"], {
      fill: GRADIENT,
      shadow,
      radius: 4,
    });
    const svg = buildExportSvg(doc, onlyTarget(doc, ["ra", "r2", "fb"]), { measurer });
    const ids = Array.from(parse(svg).querySelectorAll("[id]")).map((node) => node.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(EXPORT_ID_PREFIX)).toBe(true);
    // 参照先がすべて同じ SVG の中にある
    const refs = Array.from(svg.matchAll(/url\(#([^)]+)\)/g), (match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids).toContain(ref);
  });

  it("名前や本文の特殊な文字を含んでも XML として読める", () => {
    const base = exportDocument();
    const text = createText({
      id: "tx",
      name: `a&b<c>"d'`,
      text: `A & B <C> "D" 'E'\u0001\u0008\uFFFE\uD800 改行\n終わり`,
      fontFamily: `Font "&" <x>`,
      x: 0,
      y: 0,
    });
    const doc = insertNode(base, text, { kind: "page", id: "p1" });
    const svg = buildExportSvg(doc, onlyTarget(doc, ["tx"]), { measurer });
    const parsed = parse(svg);
    const content = parsed.querySelector("text")?.textContent ?? "";
    expect(content).toContain(`A & B <C> "D" 'E'`);
    for (const removed of ["\u0001", "\u0008", "\uFFFE", "\uD800"])
      expect(content.includes(removed)).toBe(false);
    expect(parsed.querySelector("text")?.getAttribute("font-family")).toContain(`Font \\"&\\" <x>`);
    expect(checkExportSvg(svg)).toBeNull();
  });

  it("契約データの文書 (画像と埋め込み SVG を含む) を書き出しても XML として読め、文書は変えない", () => {
    const doc = deepFreeze(fixtureDocument("full"));
    const plan = planExport(doc, doc.pages[0]!.id, [], measurer);
    if (!plan.ok) throw new Error(plan.reason);
    for (const target of plan.targets) {
      const svg = buildExportSvg(doc, target, { measurer });
      const parsed = parse(svg);
      expect(parsed.documentElement.localName).toBe("svg");
      expect(checkExportSvg(svg)).toBeNull();
      const hrefs = Array.from(parsed.querySelectorAll("image"), (image) =>
        image.getAttribute("href"),
      );
      for (const href of hrefs)
        expect(href).toMatch(/^data:image\/(png|jpeg|webp|svg\+xml);base64,/);
    }
  });

  it("非表示のノードは描かない", () => {
    const doc = insertNode(
      exportDocument(),
      createRect({ id: "in", x: 1, y: 1, width: 5, height: 5, visible: false }),
      { kind: "node", id: "fb" },
    );
    const svg = buildExportSvg(doc, onlyTarget(doc, ["fb"]), { measurer });
    const parsed = parse(svg);
    expect(parsed.querySelectorAll("rect").length).toBeGreaterThan(0); // fb の塗りと切り抜き
    expect(parsed.querySelectorAll('rect[width="5"]')).toHaveLength(0);
  });
});

describe("utf8ByteLength / checkExportSvg", () => {
  it("UTF-8 のバイト数を数え、対になっていないサロゲートは null", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("あ")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("a\uD800")).toBeNull();
    expect(utf8ByteLength("\uDC00a")).toBeNull();
    expect(utf8ByteLength("")).toBe(0);
  });

  it("20 MiB を超えれば理由を返す", () => {
    expect(checkExportSvg("a".repeat(MAX_EXPORT_SVG_BYTES))).toBeNull();
    expect(checkExportSvg("a".repeat(MAX_EXPORT_SVG_BYTES + 1))).toBe(
      "SVG は 20 MiB 以下にしてください。",
    );
    expect(checkExportSvg("\uD800")).toBe("SVG に UTF-8 にできない文字があります。");
  });
});
