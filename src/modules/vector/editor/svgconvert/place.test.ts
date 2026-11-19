import { describe, expect, it } from "vitest";

import { applyToPoint, multiply, scale } from "../geometry/matrix";
import { createFrame, createRect, createSvg } from "../model/create";
import { getNodeCorners, nodePageMatrix } from "../model/geometry";
import { checkSavable } from "../model/payload";
import { getIndexInParent, getParent } from "../model/tree";
import type {
  CanvasDocument,
  CanvasNode,
  GroupNode,
  LineNode,
  PathNode,
  SvgAsset,
} from "../model/types";
import { validateSvg } from "../../policy/svg-policy.js";
import policy from "../../policy/policy.json";
import { prepareSvgConversion } from "./place";
import { expectSamePointSet, mappedRectCorners, measurer, svgOf } from "./testing";

function svgAsset(svg: string, width = 100, height = 100): SvgAsset {
  return { kind: "svg", svg, text: validateSvg(svg, policy).text, width, height };
}

/** frame (回転 20°) の中の、回転 30° の埋め込み SVG と、その手前の矩形。 */
function rotatedDoc(svg: string): CanvasDocument {
  const nodes: CanvasNode[] = [
    createFrame({
      id: "frame",
      x: 100,
      y: 50,
      width: 400,
      height: 300,
      rotation: 20,
      children: ["back", "svg", "front"],
    }),
    createRect({ id: "back", width: 10, height: 10 }),
    createSvg("asset", {
      id: "svg",
      name: "ロゴ",
      x: 40,
      y: 30,
      width: 200,
      height: 100,
      rotation: 30,
      opacity: 0.8,
      locked: true,
    }),
    createRect({ id: "front", x: 300, width: 10, height: 10 }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["frame"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    assets: { asset: svgAsset(svg) },
  };
}

describe("prepareSvgConversion (§4.17)", () => {
  const svg = svgOf(
    `<g><title>レイヤー</title><rect x="10" y="20" width="30" height="40" fill="#ff0000"/>
     <path d="M50 50L90 50L70 90Z" fill="#00ff00" stroke="#000" stroke-width="2"/>
     <line x1="0" y1="95" x2="100" y2="95" stroke="#00f"/></g>`,
    'viewBox="0 0 100 100"',
  );

  it("埋め込み SVG の位置に同じ名前の group として置き、ページ上の見た目を保つ", () => {
    const doc = rotatedDoc(svg);
    const result = prepareSvgConversion(doc, "svg", measurer);
    if (!result.ok) throw new Error(result.reason);
    const next = result.doc;
    const rootId = result.ids[0] as string;
    const root = next.nodes[rootId] as GroupNode;
    expect(root.type).toBe("group");
    expect([root.name, root.visible, root.locked, root.opacity]).toEqual(["ロゴ", true, true, 0.8]);
    expect(next.nodes["svg"]).toBeUndefined();
    // 親と重なり順
    expect(getParent(next, rootId)).toEqual({ kind: "node", id: "frame" });
    expect(getIndexInParent(next, rootId)).toBe(1);
    // 子が 1 個 (レイヤーの group) でも根は group
    const layer = next.nodes[root.children[0] as string] as GroupNode;
    expect(layer.name).toBe("レイヤー");
    const [rectId, pathId, lineId] = layer.children as [string, string, string];

    // 箱の座標 (viewBox を 200 × 100 へ) → ページ: 元の埋め込み SVG のページの行列
    const svgPage = multiply(nodePageMatrix(doc, "svg"), scale(2, 1));
    expectSamePointSet(
      getNodeCorners(next, rectId)!,
      mappedRectCorners(svgPage, 10, 20, 30, 40),
      1e-9,
    );
    const rect = next.nodes[rectId]!;
    expect(rect.type).toBe("rect");
    // 回転は frame の座標系のまま (frame の 20° はページ上の角度に足される)
    expect(rect.type === "rect" && rect.rotation).toBeCloseTo(30, 9);

    const path = next.nodes[pathId] as PathNode;
    const pathPage = nodePageMatrix(next, pathId);
    const pts = path.subpaths[0]!.points.map((p) => applyToPoint(pathPage, p));
    expectSamePointSet(
      pts,
      [
        { x: 50, y: 50 },
        { x: 90, y: 50 },
        { x: 70, y: 90 },
      ].map((p) => applyToPoint(svgPage, p)),
      1e-9,
    );
    // 線の太さは拡大率 √2
    expect(path.stroke?.width).toBeCloseTo(2 * Math.SQRT2, 9);

    const line = next.nodes[lineId] as LineNode;
    const linePage = nodePageMatrix(next, lineId);
    expectSamePointSet(
      [
        applyToPoint(linePage, { x: line.x1, y: line.y1 }),
        applyToPoint(linePage, { x: line.x2, y: line.y2 }),
      ],
      [applyToPoint(svgPage, { x: 0, y: 95 }), applyToPoint(svgPage, { x: 100, y: 95 })],
      1e-9,
    );
    expect(checkSavable(next)).toBeNull();
    // アセットは保存の前に落ちる (Undo で戻るように文書には残す)
    expect(next.assets["asset"]).toBeDefined();
  });

  it("変換できる形がなければ empty、埋め込み SVG でなければ notSvg", () => {
    const empty = rotatedDoc(svgOf('<rect width="0" height="1"/>'));
    expect(prepareSvgConversion(empty, "svg", measurer)).toEqual({
      ok: false,
      reason: "empty",
      detail: null,
    });
    expect(prepareSvgConversion(empty, "back", measurer)).toMatchObject({
      ok: false,
      reason: "notSvg",
    });
  });

  it("パスの点の数の上限を超えるなら当てない", () => {
    const points = Array.from(
      { length: 10_001 },
      (_, i) => `${i % 100} ${Math.floor(i / 100)}`,
    ).join(" L");
    const doc = rotatedDoc(svgOf(`<path d="M${points}" stroke="#000" fill="none"/>`));
    expect(prepareSvgConversion(doc, "svg", measurer)).toEqual({
      ok: false,
      reason: "limits",
      detail: null,
    });
  });

  it("入れ子の深さの上限を超えるなら当てない", () => {
    let inner = '<rect width="1" height="1"/><rect width="1" height="1"/>';
    for (let i = 0; i < 40; i++) inner = `<g>${inner}<rect width="1" height="1"/></g>`;
    const doc = rotatedDoc(svgOf(inner));
    expect(prepareSvgConversion(doc, "svg", measurer)).toEqual({
      ok: false,
      reason: "limits",
      detail: null,
    });
  });

  it("SVG-Edit が書き出した形の SVG (v1 の作品) を変換し、保存の検証を通る", () => {
    const svgEdit = `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
 <!-- Created with SVG-edit - https://github.com/SVG-Edit/svgedit-->
 <g class="layer">
  <title>Layer 1</title>
  <rect fill="#FF0000" height="100" id="svg_1" stroke="#000000" stroke-width="5" width="150" x="50" y="40"/>
  <ellipse cx="320" cy="200" fill="#00ff00" id="svg_2" rx="60" ry="40" stroke="#000000" stroke-width="5" transform="rotate(30 320 200)"/>
  <text fill="#000000" font-family="serif" font-size="24" id="svg_3" stroke="#000000" stroke-width="0" text-anchor="middle" x="200" xml:space="preserve" y="300">Hello  SVG-Edit</text>
  <g id="svg_5" transform="translate(400 300) scale(1.5)">
   <path d="m0,0l50,0l0,50z" fill="#0000ff" id="svg_4" stroke="#000000" stroke-width="2" style="stroke-dasharray: 5,5; fill-opacity: 0.5"/>
   <line fill="none" id="svg_6" stroke="#000000" stroke-width="3" x1="0" x2="60" y1="70" y2="70" stroke-linecap="round"/>
  </g>
 </g>
</svg>`;
    // v1 → v2 の変換と同じ: ルートの width / height の箱
    const nodes: CanvasNode[] = [
      createSvg("legacy", { id: "legacy", name: "SVG", width: 640, height: 480 }),
    ];
    const doc: CanvasDocument = {
      pages: [{ id: "page1", name: "ページ 1", children: ["legacy"], guides: [] }],
      nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
      assets: { legacy: svgAsset(svgEdit, 640, 480) },
    };
    const result = prepareSvgConversion(doc, "legacy", measurer);
    if (!result.ok) throw new Error(result.reason);
    expect(result.dropped.map((item) => item.kind)).toEqual(["textPosition"]);
    const next = result.doc;
    const layer = next.nodes[(next.nodes[result.ids[0]!] as GroupNode).children[0]!] as GroupNode;
    expect(layer.name).toBe("Layer 1");
    const kinds = layer.children.map((id) => next.nodes[id]!.type);
    expect(kinds).toEqual(["rect", "ellipse", "text", "group"]);
    const [rect, ellipse, text, group] = layer.children.map((id) => next.nodes[id]!) as [
      CanvasNode,
      CanvasNode,
      CanvasNode,
      GroupNode,
    ];
    expect(rect).toMatchObject({ x: 50, y: 40, width: 150, height: 100, stroke: { width: 5 } });
    expect(ellipse).toMatchObject({ x: 260, y: 160, width: 120, height: 80, rotation: 30 });
    expect(text).toMatchObject({
      text: "Hello  SVG-Edit",
      align: "center",
      fontFamily: "serif",
      fontSize: 24,
    });
    const [path, line] = group.children.map((id) => next.nodes[id]!) as [PathNode, LineNode];
    expect(path.stroke).toMatchObject({ width: 3, dash: [7.5, 7.5] });
    expect(path.fill).toEqual({ type: "solid", color: "#0000FF", opacity: 0.5 });
    expect([line.x1, line.y1, line.x2, line.y2]).toEqual([400, 405, 490, 405]);
    expect(line.stroke).toMatchObject({ width: 4.5, cap: "round" });
    expect(checkSavable(next)).toBeNull();
  });
});
