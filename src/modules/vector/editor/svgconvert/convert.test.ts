import { describe, expect, it } from "vitest";

import {
  applyToPoint,
  multiply,
  nodeMatrix,
  rotate,
  scale,
  translate,
  type Matrix,
} from "../geometry/matrix";
import type {
  CanvasNode,
  EllipseNode,
  LineNode,
  PathNode,
  RectNode,
  TextNode,
} from "../model/types";
import { parsePathData } from "../path/pathData";
import { rectSubpaths } from "../path/shapes";
import { transformSubpaths } from "../path/transform";
import { baselineOffset } from "../text/layout";
import { convertSvg, firstFontFamily } from "./convert";
import {
  absoluteSubpaths,
  boxCorners,
  convertOk,
  droppedCounts,
  expectPointClose,
  expectSamePointSet,
  expectSubpathsClose,
  mappedRectCorners,
  measurer,
  paintPosition,
  svgOf,
} from "./testing";

function only<T extends CanvasNode["type"]>(
  leaves: CanvasNode[],
  type: T,
): Extract<CanvasNode, { type: T }> {
  expect(leaves.length).toBe(1);
  const node = leaves[0] as CanvasNode;
  expect(node.type).toBe(type);
  return node as Extract<CanvasNode, { type: T }>;
}

const pathFrom = (d: string, m: Matrix) => transformSubpaths(parsePathData(d).subpaths, m);

describe("convertSvg: パス (§8.12)", () => {
  it("アイコンの path (円弧を含む) を viewBox から箱への変換を掛けた点にする", () => {
    const d = "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM12 6v6l4 2";
    const svg = svgOf(
      `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      'viewBox="0 0 24 24" width="24" height="24"',
    );
    const { leaves, dropped } = convertOk(svg, { width: 48, height: 48 });
    const path = only(leaves, "path");
    expectSubpathsClose(absoluteSubpaths(path), pathFrom(d, scale(2)));
    // 円弧は半径 20 の円 (中心 24, 24) の上にある
    for (const p of absoluteSubpaths(path)[0]!.points)
      expect(Math.abs(Math.hypot(p.x - 24, p.y - 24) - 20)).toBeLessThan(1e-9);
    expect(path.fill).toBeNull();
    expect(path.stroke).toEqual({
      color: "#000000",
      opacity: 1,
      width: 4,
      cap: "round",
      join: "round",
      dash: [],
    });
    expect(path.rotation).toBe(0);
    expect(dropped).toEqual([]);
  });

  it("縦横比の違う箱では縦横別々に引き伸ばす (preserveAspectRatio は見ない)", () => {
    const d = "M0 0L10 0L10 10Z";
    const svg = svgOf(
      `<path d="${d}"/>`,
      'viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet"',
    );
    const { leaves } = convertOk(svg, { width: 200, height: 50 });
    expectSubpathsClose(absoluteSubpaths(only(leaves, "path")), pathFrom(d, scale(20, 5)));
  });

  it("viewBox の原点のずれを引く", () => {
    const d = "M-5 -5L5 5";
    const svg = svgOf(`<path d="${d}" stroke="red"/>`, 'viewBox="-10 -10 20 20"');
    const { leaves } = convertOk(svg, { width: 40, height: 40 });
    expectSubpathsClose(
      absoluteSubpaths(only(leaves, "path")),
      pathFrom(d, multiply(scale(2), translate(10, 10))),
    );
  });

  it("viewBox がなければルートの width / height を座標系にする", () => {
    const d = "M0 0L20 0L20 10Z";
    const { leaves } = convertOk(svgOf(`<path d="${d}"/>`, 'width="20px" height="10"'), {
      width: 40,
      height: 40,
    });
    expectSubpathsClose(absoluteSubpaths(only(leaves, "path")), pathFrom(d, scale(2, 4)));
  });

  it("viewBox もルートの大きさもなければアセットの大きさを使う", () => {
    const d = "M0 0L30 0L30 60Z";
    const { leaves } = convertOk(svgOf(`<path d="${d}"/>`, ""), {
      width: 60,
      height: 60,
      assetWidth: 30,
      assetHeight: 60,
    });
    expectSubpathsClose(absoluteSubpaths(only(leaves, "path")), pathFrom(d, scale(2, 1)));
  });

  it("transform の入れ子と傾斜はパスの点に掛ける (厳密)", () => {
    const d = "M0 0C10 0 20 10 20 20L0 20Z";
    const svg = svgOf(
      `<g transform="translate(10 5)"><g transform="rotate(30) scale(2 1)"><path transform="skewX(20)" d="${d}"/></g></g>`,
    );
    const m = multiply(multiply(translate(10, 5), multiply(rotate(30), scale(2, 1))), {
      a: 1,
      b: 0,
      c: Math.tan((20 * Math.PI) / 180),
      d: 1,
      e: 0,
      f: 0,
    });
    const { leaves } = convertOk(svg);
    expectSubpathsClose(absoluteSubpaths(only(leaves, "path")), pathFrom(d, m));
  });

  it("polyline は開いた輪郭、polygon は閉じた輪郭。奇数個の数は最後を捨てる", () => {
    const { leaves } = convertOk(
      svgOf(
        '<polyline points="0,0 10,0 10,10 5" fill="none" stroke="#000"/><polygon points="20 20 30 20 30 30"/>',
      ),
    );
    expect(leaves.map((n) => n.type)).toEqual(["path", "path"]);
    const [polyline, polygon] = leaves as [PathNode, PathNode];
    expect(absoluteSubpaths(polyline)[0]!.closed).toBe(false);
    expect(absoluteSubpaths(polyline)[0]!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(absoluteSubpaths(polygon)[0]!.closed).toBe(true);
  });

  it("fill-rule と、読み込みの誤りの手前まで", () => {
    const { leaves } = convertOk(svgOf('<path fill-rule="evenodd" d="M0 0L10 0L10 10Z L 5"/>'));
    const path = only(leaves, "path");
    expect(path.fillRule).toBe("evenodd");
    expect(absoluteSubpaths(path)[0]!.points.length).toBe(3);
  });
});

describe("convertSvg: 矩形・楕円・線", () => {
  it("矩形は箱に、回転は rotation に (中心のまわり)", () => {
    const svg = svgOf(
      '<g transform="translate(10 20)"><rect transform="rotate(90)" x="0" y="0" width="10" height="5" rx="2" fill="#ff0000"/></g>',
    );
    const rect = only(convertOk(svg).leaves, "rect");
    expect(rect.rotation).toBe(90);
    expect([rect.width, rect.height, rect.radius]).toEqual([10, 5, 2]);
    expectSamePointSet(
      boxCorners(rect),
      mappedRectCorners(multiply(translate(10, 20), rotate(90)), 0, 0, 10, 5),
    );
    expect(rect.fill).toEqual({ type: "solid", color: "#FF0000", opacity: 1 });
  });

  it("縦横の拡大と回転 (回転が外) は箱で、拡大が外 (傾斜になる) ならパス", () => {
    const outer = svgOf('<rect transform="rotate(30) scale(2 1)" width="10" height="10"/>');
    const rect = only(convertOk(outer).leaves, "rect");
    expect([rect.width, rect.height, rect.rotation]).toEqual([20, 10, 30]);
    expectSamePointSet(
      boxCorners(rect),
      mappedRectCorners(multiply(rotate(30), scale(2, 1)), 0, 0, 10, 10),
    );

    const inner = svgOf('<rect transform="scale(2 1) rotate(30)" width="10" height="10"/>');
    const path = only(convertOk(inner).leaves, "path");
    expectSubpathsClose(
      absoluteSubpaths(path),
      transformSubpaths(rectSubpaths(10, 10, 0), multiply(scale(2, 1), rotate(30))),
    );
  });

  it("反転した矩形は箱 (対称) にする", () => {
    const rect = only(
      convertOk(
        svgOf('<rect transform="translate(50 0) scale(-1 1)" x="10" width="20" height="10"/>'),
      ).leaves,
      "rect",
    );
    expectSamePointSet(
      boxCorners(rect),
      mappedRectCorners(multiply(translate(50, 0), scale(-1, 1)), 10, 0, 20, 10),
    );
  });

  it("角丸の縦横が違う矩形はパス (SVG の角丸と同じ形)", () => {
    const path = only(
      convertOk(svgOf('<rect x="1" y="2" width="40" height="20" rx="8" ry="4"/>')).leaves,
      "path",
    );
    const pts = absoluteSubpaths(path)[0]!.points;
    expectPointClose(pts[0]!, { x: 9, y: 2 }); // (x + rx, y) から時計回り
    expectPointClose(pts[2]!, { x: 41, y: 6 }); // 右上の角の終わり (x + w, y + ry)
    expect(path.width).toBeCloseTo(40, 9);
    expect(path.height).toBeCloseTo(20, 9);
  });

  it("片方の角丸が辺の半分で頭打ちなら矩形の角丸 1 つで表せる", () => {
    const rect = only(convertOk(svgOf('<rect width="10" height="100" rx="20"/>')).leaves, "rect");
    expect(rect.radius).toBe(20);
  });

  it("円と楕円は楕円。縦横比の違う箱では楕円に引き伸ばす", () => {
    const svg = svgOf(
      '<circle cx="5" cy="5" r="5"/><ellipse cx="5" cy="5" rx="2" ry="4" transform="rotate(45 5 5)"/>',
      'viewBox="0 0 10 10"',
    );
    const { leaves } = convertOk(svg, { width: 100, height: 50 });
    const [circle, ellipse] = leaves as [EllipseNode, EllipseNode | PathNode];
    expect([circle.type, circle.x, circle.y, circle.width, circle.height]).toEqual([
      "ellipse",
      0,
      0,
      100,
      50,
    ]);
    // 回転と縦横の違う拡大の組み合わせはパス
    expect(ellipse.type).toBe("path");
  });

  it("線は端点を写す。線がなければ作らない", () => {
    const svg = svgOf(
      '<g transform="scale(2)"><line x1="1" y1="2" x2="3" y2="4" stroke="#00f" stroke-width="3" stroke-dasharray="2 1"/><line x1="0" y1="0" x2="5" y2="5"/></g>',
    );
    const line = only(convertOk(svg).leaves, "line") as LineNode;
    expect([line.x1, line.y1, line.x2, line.y2]).toEqual([2, 4, 6, 8]);
    expect(line.stroke.width).toBe(6);
    expect(line.stroke.dash).toEqual([4, 2]);
    expect(line.stroke.color).toBe("#0000FF");
  });

  it("大きさ 0 の形、塗りも線もない形は作らない。形がなければ empty", () => {
    const result = convertSvg(
      svgOf('<rect width="0" height="10"/><circle r="5" fill="none"/><line x1="0" x2="1"/>'),
      { width: 100, height: 100, assetWidth: 100, assetHeight: 100, measurer },
    );
    expect(result).toEqual({ ok: false, reason: "empty", detail: null });
  });
});

describe("convertSvg: 見た目の属性", () => {
  it("style は表示属性より優先し、継承と currentColor と inherit を読む", () => {
    const svg = svgOf(
      `<g fill="#111111" color="#00ff00" stroke-width="3" style="stroke: currentColor">
        <rect width="10" height="10" style="fill:#222222" fill="#333333"/>
        <rect width="10" height="10" fill="inherit" stroke="none"/>
        <rect width="10" height="10" fill="currentColor" style="color: rgb(255, 0, 0)"/>
      </g>`,
    );
    const [a, b, c] = convertOk(svg).leaves as [RectNode, RectNode, RectNode];
    expect(a.fill).toEqual({ type: "solid", color: "#222222", opacity: 1 });
    expect(a.stroke?.color).toBe("#00FF00");
    expect(a.stroke?.width).toBe(3);
    expect(b.fill).toEqual({ type: "solid", color: "#111111", opacity: 1 });
    expect(b.stroke).toBeNull();
    expect(c.fill).toEqual({ type: "solid", color: "#FF0000", opacity: 1 });
  });

  it("opacity はノード、fill-opacity と stroke-opacity と色のアルファは塗りと線の不透明度", () => {
    const svg = svgOf(
      '<rect width="10" height="10" opacity="0.5" fill="#ff000080" fill-opacity="50%" stroke="rgba(0,0,255,.5)" stroke-opacity="0.4"/>',
    );
    const rect = only(convertOk(svg).leaves, "rect");
    expect(rect.opacity).toBe(0.5);
    expect(rect.fill?.type === "solid" && rect.fill.opacity).toBeCloseTo((128 / 255) * 0.5, 9);
    expect(rect.stroke?.opacity).toBeCloseTo(0.2, 9);
  });

  it("線の太さと破線は拡大率 (行列式の平方根) を掛ける", () => {
    const svg = svgOf(
      '<path transform="translate(10 10) scale(4 1)" d="M0 0L10 0" stroke="#000" stroke-width="2" stroke-dasharray="1,3,2"/>',
    );
    const { leaves, dropped } = convertOk(svg);
    const path = only(leaves, "path");
    expect(path.stroke?.width).toBe(4);
    expect(path.stroke?.dash).toEqual([2, 6, 4]);
    expect(droppedCounts(dropped)).toEqual({ nonUniformStroke: 1 });
  });

  it("g は group (子が 1 個なら作らず不透明度を掛ける)、名前は title", () => {
    const svg = svgOf(
      `<g opacity="0.5"><title>レイヤー 1</title><rect width="1" height="1"/><rect width="1" height="1"/></g>
       <g opacity="0.5"><rect width="1" height="1" opacity="0.5"/></g>`,
    );
    const { root, nodes } = convertOk(svg);
    expect(root.type).toBe("group");
    const [group, rect] = (root as { children: string[] }).children.map((id) => nodes[id]!);
    expect(group?.type).toBe("group");
    expect(group?.name).toBe("レイヤー 1");
    expect(group?.opacity).toBe(0.5);
    expect(rect?.type).toBe("rect");
    expect(rect?.opacity).toBe(0.25);
  });

  it("display: none と visibility: hidden は黙って飛ばす (子の visible は描く)", () => {
    const svg = svgOf(
      `<rect width="1" height="1" display="none"/>
       <g style="display:none"><rect width="1" height="1"/></g>
       <g visibility="hidden"><rect width="1" height="1"/><rect id="v" width="2" height="2" visibility="visible"/></g>
       <image visibility="hidden" width="1" height="1" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII="/>`,
    );
    const { leaves, dropped } = convertOk(svg);
    expect(leaves.map((n) => (n as RectNode).width)).toEqual([2]);
    expect(dropped).toEqual([]);
  });

  it("pattern の塗りは落とし、代わりの色があれば使う", () => {
    const svg = svgOf(
      `<defs><pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern></defs>
       <rect width="1" height="1" fill="url(#p) #00ff00"/>
       <rect width="1" height="1" fill="url(#p)" stroke="#000"/>
       <rect width="1" height="1" fill="url(#missing)"/>`,
    );
    const { leaves, dropped } = convertOk(svg);
    expect(leaves.map((n) => (n as RectNode).fill)).toEqual([
      { type: "solid", color: "#00FF00", opacity: 1 },
      null,
    ]);
    expect(droppedCounts(dropped)).toEqual({ pattern: 2 });
  });

  it("落とすものを種類ごとに数える", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=";
    const svg = svgOf(
      `<defs><clipPath id="c"><rect width="1" height="1"/></clipPath><mask id="m"/><filter id="f"/>
       <marker id="k"><path d="M0 0L1 1"/></marker><path id="tp" d="M0 0L10 0"/></defs>
       <g clip-path="url(#c)"><rect width="1" height="1"/></g>
       <rect width="1" height="1" mask="url(#m)" style="filter: url(#f)"/>
       <image href="${png}" width="1" height="1"/>
       <path d="M10 10L15 15" stroke="#000" marker-end="url(#k)" stroke-dasharray="1" stroke-dashoffset="1" stroke-miterlimit="10" vector-effect="non-scaling-stroke"/>
       <rect x="10" y="10" width="1" height="1" stroke="#000" paint-order="stroke"/>
       <text x="10" y="30">A<textPath href="#tp">B</textPath></text>`,
    );
    const counts = droppedCounts(convertOk(svg).dropped);
    expect(counts).toEqual({
      clipPath: 1,
      mask: 1,
      filter: 1,
      image: 1,
      marker: 1,
      textPath: 1,
      dashOffset: 1,
      miterLimit: 1,
      vectorEffect: 1,
      paintOrder: 1,
      textPosition: 1,
    });
  });

  it("線の太さが 0 と読めない色の線は作らない。上限を超える太さは上限に収める", () => {
    const svg = svgOf(
      '<rect width="1" height="1" stroke="#000" stroke-width="0"/><rect width="1" height="1" stroke="nope"/><path d="M0 0L1 0" stroke="#000" stroke-width="5000"/>',
    );
    const { leaves, dropped } = convertOk(svg);
    expect(leaves.map((n) => ("stroke" in n ? (n.stroke?.width ?? null) : null))).toEqual([
      null,
      null,
      1000,
    ]);
    expect(droppedCounts(dropped)).toEqual({ valueLimit: 1, outsideBox: 1 });
  });
});

describe("convertSvg: use / symbol / 入れ子の svg", () => {
  it("use は参照先を x / y と transform で置き、use の書式を継承させる", () => {
    const d = "M0 0L4 0L4 4Z";
    const svg = svgOf(
      `<defs><path id="tri" d="${d}"/></defs><use xlink:href="#tri" x="10" y="20" fill="#ff0000" transform="scale(2)"/><use href="#tri"/>`,
    );
    const { leaves } = convertOk(svg);
    const [a, b] = leaves as [PathNode, PathNode];
    expectSubpathsClose(absoluteSubpaths(a), pathFrom(d, multiply(scale(2), translate(10, 20))));
    expect(a.fill).toEqual({ type: "solid", color: "#FF0000", opacity: 1 });
    expectSubpathsClose(absoluteSubpaths(b), pathFrom(d, translate(0, 0)));
    expect(b.fill).toEqual({ type: "solid", color: "#000000", opacity: 1 });
  });

  it("symbol は use の width / height と symbol の viewBox で置く (はみ出すときだけ切り抜きを落とす)", () => {
    const svg = svgOf(
      `<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol><use href="#s" x="5" y="5" width="20" height="20"/>`,
    );
    const { leaves, dropped } = convertOk(svg);
    const rect = only(leaves, "rect");
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([5, 5, 20, 20]);
    expect(dropped).toEqual([]);

    const over = svgOf(
      `<symbol id="s" viewBox="0 0 10 10"><rect x="5" width="10" height="10"/></symbol><use href="#s" x="5" y="5" width="20" height="20"/>`,
    );
    expect(droppedCounts(convertOk(over).dropped)).toEqual({ nestedClip: 1 });
  });

  it("入れ子の svg は viewBox の変換 (既定は xMidYMid meet) を掛ける", () => {
    const svg = svgOf(
      `<svg x="10" y="10" width="40" height="20" viewBox="0 0 10 10" overflow="visible"><rect width="10" height="10"/></svg>`,
    );
    const { leaves, dropped } = convertOk(svg);
    const rect = only(leaves, "rect");
    // 20 × 20 に縮めて横の中央に置く
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([20, 10, 20, 20]);
    expect(dropped).toEqual([]);
  });

  it("循環する use と自分の祖先を指す use は落とす", () => {
    const svg = svgOf(
      `<g id="a"><rect width="1" height="1"/><use href="#a"/></g><use id="u1" href="#u2"/><use id="u2" href="#u1"/>`,
    );
    const { leaves, dropped } = convertOk(svg);
    expect(leaves.length).toBe(1);
    expect(droppedCounts(dropped)["useCycle"]).toBeGreaterThanOrEqual(2);
  });

  it("巨大な展開 (use の入れ子で指数的に増えるもの) は途中で止めて tooLarge", () => {
    let defs = '<rect id="l0" width="1" height="1"/>';
    for (let i = 1; i <= 8; i++)
      defs += `<g id="l${i}">${Array.from({ length: 10 }, () => `<use href="#l${i - 1}"/>`).join("")}</g>`;
    const result = convertSvg(svgOf(`<defs>${defs}</defs><use href="#l8"/>`), {
      width: 100,
      height: 100,
      assetWidth: 100,
      assetHeight: 100,
      measurer,
    });
    expect(result).toEqual({ ok: false, reason: "tooLarge", detail: null });
  });
});

describe("convertSvg: グラデーション", () => {
  /** SVG の線形グラデーションの位置 (利用者の座標の点 g、グラデーションの座標への行列 G^-1 を使わず定義どおり)。 */
  const linearT = (
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    g: { x: number; y: number },
  ) => {
    const v = { x: p2.x - p1.x, y: p2.y - p1.y };
    return ((g.x - p1.x) * v.x + (g.y - p1.y) * v.y) / (v.x * v.x + v.y * v.y);
  };

  it("objectBoundingBox の線形グラデーションは箱の 0〜1 のまま。fill-opacity は停止点に掛ける", () => {
    const svg = svgOf(
      `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f00"/><stop offset="100%" style="stop-color:#00f;stop-opacity:.5"/></linearGradient>
       <rect x="10" y="10" width="20" height="40" fill="url(#g)" fill-opacity="0.5"/>`,
    );
    const rect = only(convertOk(svg).leaves, "rect");
    expect(rect.fill).toEqual({
      type: "linear",
      from: { x: 0, y: 0 },
      to: { x: 0, y: 1 },
      stops: [
        { offset: 0, color: "#FF0000", opacity: 0.5 },
        { offset: 1, color: "#0000FF", opacity: 0.25 },
      ],
    });
  });

  it("userSpaceOnUse と gradientTransform の線形グラデーションは、色の位置が元と同じになる", () => {
    const svg = svgOf(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="40" y2="10" gradientTransform="rotate(20 25 25) scale(1 1.5)"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
       <path transform="translate(5 5) rotate(10)" d="M0 0L60 0L60 30L0 30Z" fill="url(#g)"/>`,
    );
    const path = only(convertOk(svg).leaves, "path");
    expect(path.fill?.type).toBe("linear");
    const pathM = multiply(translate(5, 5), rotate(10));
    const gt = multiply(rotate(20, 25, 25), scale(1, 1.5));
    // グラデーションの座標の点 → 利用者の座標 → 結果の座標 の対応で、色の位置を比べる
    for (const g of [
      { x: 10, y: 0 },
      { x: 40, y: 10 },
      { x: 25, y: 13 },
      { x: 0, y: 30 },
    ]) {
      const page = applyToPoint(multiply(pathM, gt), g);
      const want = linearT({ x: 10, y: 0 }, { x: 40, y: 10 }, g);
      expect(paintPosition(path.fill!, path, page)).toBeCloseTo(want, 9);
    }
  });

  it("回転した矩形の objectBoundingBox の放射グラデーションは厳密", () => {
    const svg = svgOf(
      `<radialGradient id="r" cx="0.25" cy="0.5" r="0.5"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>
       <rect transform="rotate(30 50 50)" x="30" y="40" width="40" height="20" fill="url(#r)"/>`,
    );
    const { leaves, dropped } = convertOk(svg);
    const rect = only(leaves, "rect");
    expect(rect.fill).toMatchObject({ type: "radial", center: { x: 0.25, y: 0.5 }, radius: 0.5 });
    expect(dropped).toEqual([]);
  });

  it("縦横の違う箱の userSpaceOnUse の放射は近似 (一覧に出す)。焦点と spreadMethod も出す", () => {
    const svg = svgOf(
      `<radialGradient id="r" gradientUnits="userSpaceOnUse" cx="20" cy="10" r="10" fx="15" spreadMethod="reflect"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>
       <rect width="40" height="20" fill="url(#r)"/>`,
    );
    const { leaves, dropped } = convertOk(svg);
    const rect = only(leaves, "rect");
    expect(rect.fill?.type).toBe("radial");
    expect(droppedCounts(dropped)).toEqual({
      gradientTransform: 1,
      gradientFocal: 1,
      gradientSpread: 1,
    });
  });

  it("href で停止点と属性を引き継ぐ (Inkscape の書き方)", () => {
    const svg = svgOf(
      `<defs><linearGradient id="base"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
       <linearGradient id="use" xlink:href="#base" x1="0" y1="1" x2="0" y2="0"/></defs>
       <rect width="10" height="10" fill="url(#use)"/>`,
    );
    const rect = only(convertOk(svg).leaves, "rect");
    expect(rect.fill).toMatchObject({
      type: "linear",
      from: { x: 0, y: 1 },
      to: { x: 0, y: 0 },
      stops: [{ color: "#FF0000" }, { color: "#0000FF" }],
    });
  });

  it("停止点が 1 個なら単色、線のグラデーションは単色にして一覧に出す", () => {
    const svg = svgOf(
      `<linearGradient id="one"><stop offset="0" stop-color="#123456"/></linearGradient>
       <linearGradient id="two"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
       <rect width="10" height="10" fill="url(#one)" stroke="url(#two)"/>`,
    );
    const { leaves, dropped } = convertOk(svg);
    const rect = only(leaves, "rect");
    expect(rect.fill).toEqual({ type: "solid", color: "#123456", opacity: 1 });
    expect(rect.stroke?.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(droppedCounts(dropped)).toEqual({ strokeGradient: 1 });
  });
});

describe("convertSvg: テキスト", () => {
  it("位置を指定した tspan ごとに 1 行 (auto-width)。ベースラインと揃えの点を合わせる", () => {
    const svg = svgOf(
      `<text x="50" y="20" font-size="10" text-anchor="middle" font-family="'Hiragino Sans', sans-serif" font-weight="bold">見出し<tspan x="50" y="40">2 行目</tspan></text>`,
    );
    const { leaves, dropped } = convertOk(svg);
    expect(leaves.length).toBe(2);
    const [a, b] = leaves as [TextNode, TextNode];
    expect([a.text, b.text]).toEqual(["見出し", "2 行目"]);
    for (const [node, y] of [
      [a, 20],
      [b, 40],
    ] as const) {
      expect(node.sizing).toBe("auto-width");
      expect(node.align).toBe("center");
      expect(node.fontFamily).toBe("Hiragino Sans");
      expect(node.fontWeight).toBe(700);
      expect(node.fontSize).toBe(10);
      expect(node.x + node.width / 2).toBeCloseTo(50, 9);
      expect(node.y + baselineOffset(node, measurer)).toBeCloseTo(y, 9);
    }
    expect(droppedCounts(dropped)).toEqual({ textPosition: 2 });
  });

  it("回転・拡大したテキストは、行の基準点がベースラインの揃えの点に来る", () => {
    const svg = svgOf(
      `<g transform="translate(30 40) rotate(90) scale(2)"><text x="5" y="3" font-size="8" text-anchor="end">ABC</text></g>`,
    );
    const text = only(convertOk(svg).leaves, "text");
    expect(text.rotation).toBe(90);
    expect(text.fontSize).toBe(16);
    expect(text.align).toBe("right");
    const m = nodeMatrix(text.x, text.y, text.width, text.height, text.rotation);
    const anchor = applyToPoint(m, { x: text.width, y: baselineOffset(text, measurer) });
    expectPointClose(
      anchor,
      applyToPoint(multiply(multiply(translate(30, 40), rotate(90)), scale(2)), { x: 5, y: 3 }),
    );
  });

  it("空白をまとめ、xml:space=preserve は残す。見えないチャンクは作らない", () => {
    const svg = svgOf(
      `<text x="0" y="10">  a
        b  </text><text x="0" y="30" xml:space="preserve">a  b</text><text x="0" y="50" visibility="hidden">x</text>`,
    );
    const texts = convertOk(svg).leaves as TextNode[];
    expect(texts.map((t) => t.text)).toEqual(["a b", "a  b"]);
  });

  it("線だけのテキストは線の色で塗り、テキストの線として一覧に出す", () => {
    const text = convertOk(svgOf('<text x="10" y="30" fill="none" stroke="#ff0000">A</text>'));
    expect((text.leaves[0] as TextNode).fill).toEqual({
      type: "solid",
      color: "#FF0000",
      opacity: 1,
    });
    expect(droppedCounts(text.dropped)).toEqual({ textStroke: 1, textPosition: 1 });
  });

  it("位置を持たない tspan の書式の違いは一覧に出す", () => {
    const { dropped } = convertOk(svgOf('<text x="10" y="30">A<tspan fill="red">B</tspan></text>'));
    expect(droppedCounts(dropped)).toEqual({ textStyle: 1, textPosition: 1 });
  });

  it("font-family の先頭の名前", () => {
    expect(firstFontFamily('"Noto Sans JP", sans-serif')).toBe("Noto Sans JP");
    expect(firstFontFamily("Helvetica, Arial")).toBe("Helvetica");
    expect(firstFontFamily(undefined)).toBe("serif");
  });
});

describe("convertSvg: 入力の扱い", () => {
  it("SVG ポリシーを通らない SVG は invalid", () => {
    const result = convertSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      {
        width: 1,
        height: 1,
        assetWidth: 1,
        assetHeight: 1,
        measurer,
      },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid");
  });

  it("箱の外にはみ出す形を一覧に出す (今は切り抜かれている)", () => {
    const { dropped } = convertOk(
      svgOf(
        '<rect x="-10" width="20" height="20"/><rect x="90" width="10" height="10" stroke="#000"/>',
      ),
    );
    expect(droppedCounts(dropped)).toEqual({ outsideBox: 1 });
  });

  it("接頭辞付きの名前空間でも読める", () => {
    const svg =
      '<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><s:rect width="5" height="5"/></s:svg>';
    expect(convertOk(svg, { width: 10, height: 10 }).leaves[0]?.type).toBe("rect");
  });
});
