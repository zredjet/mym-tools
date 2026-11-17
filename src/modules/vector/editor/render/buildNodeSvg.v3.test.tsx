/**
 * 第 2 段階 (payload v3) の描画 (§8.4)。回転、線の端・角・破線、パス、ブーリアン。
 * 回転 0 と線の既定値の出力が v2 と同じことは、`buildNodeSvg.test.tsx` (v2 からのテスト) が確かめる。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBoolean,
  createEllipse,
  createFrame,
  createLine,
  createPath,
  createRect,
  createStroke,
  createText,
  solidPaint,
} from "../model/create";
import { fixtureDocument } from "../model/testing";
import type { CanvasDocument, CanvasNode, Subpath } from "../model/types";
import { buildNodeSvg } from "./buildNodeSvg";
import { svgElToString } from "./svgEl";
import { fixedWidthMeasurer } from "./testing";
import type { RenderOptions, SvgEl } from "./types";

const operation = vi.hoisted(() => ({
  result: null as Subpath[] | null,
  throws: false,
  calls: 0,
}));
vi.mock("../boolean/index", () => ({
  booleanOperation: () => {
    operation.calls++;
    if (operation.throws) throw new Error("boom");
    return operation.result;
  },
}));

beforeEach(() => {
  operation.result = null;
  operation.throws = false;
  operation.calls = 0;
});

const OPTIONS: RenderOptions = { measurer: fixedWidthMeasurer(0.5), idPrefix: "t-" };

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

function build(doc: CanvasDocument, id: string): SvgEl {
  const result = buildNodeSvg(doc, id, OPTIONS);
  if (!result) throw new Error("null");
  return result;
}

function findAll(tree: SvgEl | string, tag: string): SvgEl[] {
  if (typeof tree === "string") return [];
  const own = tree.tag === tag ? [tree] : [];
  return [...own, ...tree.children.flatMap((child) => findAll(child, tag))];
}

const corner = (x: number, y: number) => ({ x, y, in: null, out: null, mirror: "none" as const });

describe("回転 (§8.4)", () => {
  it("回転した矩形は自分の要素に rotate(θ cx cy) を付ける (中心は箱の中心、親の座標系)", () => {
    const rect = createRect({ id: "r", x: 10, y: 20, width: 40, height: 30, rotation: 30 });
    expect(build(docOf([rect], ["r"]), "r").attrs).toMatchObject({
      x: 10,
      y: 20,
      width: 40,
      height: 30,
      transform: "rotate(30 30 35)",
    });
  });

  it("影や不透明度で <g> に包むときは、最も外側の <g> に付ける (影も一緒に回る)", () => {
    const rect = createRect({
      id: "r",
      width: 10,
      height: 10,
      rotation: -45,
      opacity: 0.5,
      shadow: { x: 2, y: 2, blur: 4, color: "#000000", opacity: 0.5 },
    });
    const tree = build(docOf([rect], ["r"]), "r");
    expect(tree.tag).toBe("g");
    expect(tree.attrs).toEqual({ opacity: 0.5, transform: "rotate(-45 5 5)" });
    const shape = findAll(tree, "rect")[0];
    expect(shape?.attrs["filter"]).toBe("url(#t-r-shadow)");
    expect(shape?.attrs["transform"]).toBeUndefined();
  });

  it("frame は子と切り抜きも含めて回す。子だけの <g> なら translate の前に置く", () => {
    const child = createRect({ id: "c", x: 5, y: 5 });
    const bare = createFrame({
      id: "f",
      x: 100,
      y: 50,
      width: 200,
      height: 100,
      rotation: 90,
      clip: false,
      fill: null,
      children: ["c"],
    });
    const tree = build(docOf([bare, child], ["f"]), "f");
    expect(tree.attrs["transform"]).toBe("rotate(90 200 100) translate(100 50)");

    const clipped = { ...bare, clip: true, fill: solidPaint("#FFFFFF") };
    const wrapped = build(docOf([clipped, child], ["f"]), "f");
    expect(wrapped.attrs["transform"]).toBe("rotate(90 200 100)");
    // 子は frame の座標系のまま
    const inner = findAll(wrapped, "g").find((g) => g.attrs["clip-path"] !== undefined);
    expect(inner?.attrs["transform"]).toBe("translate(100 50)");
    expect(findAll(wrapped, "rect").some((rect) => rect.attrs["x"] === 5)).toBe(true);
  });

  it("テキスト、楕円、画像の箱にも同じく付ける。数値は小数第 4 位で丸める", () => {
    const text = createText({ id: "t", x: 0, y: 0, width: 33.333333, height: 10, text: "a" });
    const rotated = { ...text, rotation: 12.345678 };
    expect(build(docOf([rotated], ["t"]), "t").attrs["transform"]).toBe(
      "rotate(12.3457 16.6667 5)",
    );
    const ellipse = createEllipse({
      id: "e",
      x: -10,
      y: -10,
      width: 20,
      height: 20,
      rotation: 180,
    });
    expect(build(docOf([ellipse], ["e"]), "e").attrs["transform"]).toBe("rotate(180 0 0)");
  });

  it("回転 0 では transform を付けない", () => {
    const rect = createRect({ id: "r", x: 10, y: 20 });
    expect(build(docOf([rect], ["r"]), "r").attrs["transform"]).toBeUndefined();
  });
});

describe("線の端・角・破線 (§8.4)", () => {
  it("既定値 (butt、miter、空) では属性を付けない", () => {
    const line = createLine({ id: "l", stroke: createStroke("#000000", 2) });
    const attrs = build(docOf([line], ["l"]), "l").attrs;
    expect(attrs["stroke-linecap"]).toBeUndefined();
    expect(attrs["stroke-linejoin"]).toBeUndefined();
    expect(attrs["stroke-dasharray"]).toBeUndefined();
  });

  it("端・角・破線を stroke-linecap / stroke-linejoin / stroke-dasharray にする", () => {
    const stroke = { ...createStroke("#000000", 2), cap: "round", join: "bevel", dash: [4, 2.5] };
    const rect = createRect({ id: "r", stroke } as Parameters<typeof createRect>[0]);
    expect(build(docOf([rect], ["r"]), "r").attrs).toMatchObject({
      "stroke-linecap": "round",
      "stroke-linejoin": "bevel",
      "stroke-dasharray": "4 2.5",
    });
  });

  it("破線の数値は小数第 4 位で丸めて末尾の 0 を落とす", () => {
    const stroke = { ...createStroke(), cap: "square" as const, dash: [1 / 3, 2, 0.00001] };
    const line = createLine({ id: "l", stroke });
    expect(build(docOf([line], ["l"]), "l").attrs).toMatchObject({
      "stroke-linecap": "square",
      "stroke-dasharray": "0.3333 2 0",
    });
  });

  it("frame の線と影の要素にも付ける", () => {
    const stroke = { ...createStroke("#000000", 2), join: "round" as const, dash: [3] };
    const frame = createFrame({
      id: "f",
      stroke,
      shadow: { x: 0, y: 0, blur: 2, color: "#000000", opacity: 1 },
    });
    const rects = findAll(build(docOf([frame], ["f"]), "f"), "rect").filter(
      (rect) => rect.attrs["stroke"] !== undefined,
    );
    expect(rects).toHaveLength(2);
    for (const rect of rects)
      expect(rect.attrs).toMatchObject({ "stroke-linejoin": "round", "stroke-dasharray": "3" });
  });
});

describe("パス (§8.4、§8.6)", () => {
  const triangle: Subpath = { closed: true, points: [corner(0, 0), corner(10, 0), corner(5, 8)] };

  it("<path d> 1 つと fill-rule で描く。点には箱の x y だけを足す", () => {
    const path = createPath([triangle], {
      id: "p",
      x: 100,
      y: 50,
      fill: solidPaint("#FF0000"),
      stroke: null,
      fillRule: "evenodd",
    });
    expect(build(docOf([path], ["p"]), "p")).toEqual({
      tag: "path",
      attrs: { d: "M100 50 L110 50 L105 58 L100 50 Z", "fill-rule": "evenodd", fill: "#FF0000" },
      children: [],
    });
  });

  it("曲線は C、回転は transform で付ける", () => {
    const curve: Subpath = {
      closed: false,
      points: [
        { x: 0, y: 10, in: null, out: { x: 5, y: -10 }, mirror: "none" },
        { x: 20, y: 10, in: { x: -5, y: -10 }, out: null, mirror: "none" },
      ],
    };
    const path = createPath([curve], { id: "p", x: 1, y: 2, rotation: 45 });
    const attrs = build(docOf([path], ["p"]), "p").attrs;
    expect(attrs["d"]).toBe("M1 12 C6 2 16 2 21 12");
    // 箱は曲線の範囲に合わせて作るので、描く位置は渡した点の座標 + (1, 2) のまま
    expect(path.y).toBeCloseTo(4.5, 10);
    expect(attrs["transform"]).toBe(
      `rotate(45 ${path.x + path.width / 2} ${path.y + path.height / 2})`,
    );
    expect(attrs).toMatchObject({ fill: "none", stroke: "#000000", "fill-rule": "nonzero" });
  });

  it("箱の外に点を渡しても、点は箱に収まり、影のフィルタの範囲が形を囲む", () => {
    const far: Subpath = {
      closed: true,
      points: [corner(50, 50), corner(150, 50), corner(150, 150), corner(50, 150)],
    };
    const path = createPath([far], {
      id: "p",
      stroke: null,
      fill: solidPaint("#000000"),
      shadow: { x: 0, y: 0, blur: 0, color: "#000000", opacity: 1 },
    });
    const tree = build(docOf([path], ["p"]), "p");
    expect(findAll(tree, "path")[0]?.attrs["d"]).toBe("M50 50 L150 50 L150 150 L50 150 L50 50 Z");
    expect(findAll(tree, "filter")[0]?.attrs).toMatchObject({
      x: 49,
      y: 49,
      width: 102,
      height: 102,
    });
  });

  it("点が 1 個だけの輪郭は描かない。描く輪郭がなければ空の <g>", () => {
    const dot: Subpath = { closed: false, points: [corner(3, 3)] };
    const mixed = createPath([dot, triangle], { id: "p" });
    expect(build(docOf([mixed], ["p"]), "p").attrs["d"]).toBe("M0 0 L10 0 L5 8 L0 0 Z");
    const only = createPath([dot], { id: "q" });
    expect(build(docOf([only], ["q"]), "q")).toEqual({ tag: "g", attrs: {}, children: [] });
  });

  it("グラデーションは回転の前の箱へ写し、影はマイターの角の届く所まで範囲を広げる", () => {
    const path = createPath([triangle], {
      id: "p",
      x: 10,
      y: 20,
      fill: {
        type: "linear",
        stops: [
          { offset: 0, color: "#000000", opacity: 1 },
          { offset: 1, color: "#FFFFFF", opacity: 1 },
        ],
        from: { x: 0, y: 0 },
        to: { x: 1, y: 0 },
      },
      stroke: createStroke("#000000", 4),
      shadow: { x: 0, y: 0, blur: 0, color: "#000000", opacity: 1 },
    });
    const tree = build(docOf([path], ["p"]), "p");
    expect(findAll(tree, "linearGradient")[0]?.attrs["gradientTransform"]).toBe(
      "matrix(10 0 0 8 10 20)",
    );
    // 太さ 4 のマイターは 4 × 4 / 2 = 8 まで届く。ぼかし 0 なら余白は 8 + 1
    expect(findAll(tree, "filter")[0]?.attrs).toMatchObject({ x: 1, y: 11, width: 28, height: 26 });
  });
});

describe("ブーリアン (§8.4、§8.9.3)", () => {
  const children = () => [
    createRect({ id: "a", x: 0, y: 0, width: 10, height: 10 }),
    createEllipse({ id: "b", x: 5, y: 5, width: 10, height: 10 }),
  ];
  const booleanDoc = (init: Parameters<typeof createBoolean>[2] = {}) =>
    docOf([createBoolean("union", ["a", "b"], { id: "u", ...init }), ...children()], ["u"]);

  it("結果を <path d> 1 つにして、自分の塗り・線で描く。子は個別に描かず、transform も付けない", () => {
    operation.result = [{ closed: true, points: [corner(0, 0), corner(15, 0), corner(15, 15)] }];
    const tree = build(booleanDoc({ stroke: createStroke("#111111", 2) }), "u");
    expect(tree).toEqual({
      tag: "path",
      attrs: {
        d: "M0 0 L15 0 L15 15 L0 0 Z",
        "fill-rule": "nonzero",
        fill: "#D9D9D9",
        stroke: "#111111",
        "stroke-width": 2,
      },
      children: [],
    });
  });

  it("グラデーションを写す箱は結果の外接矩形", () => {
    operation.result = [{ closed: true, points: [corner(2, 4), corner(12, 4), corner(12, 24)] }];
    const tree = build(
      booleanDoc({
        fill: {
          type: "radial",
          stops: [
            { offset: 0, color: "#000000", opacity: 1 },
            { offset: 1, color: "#FFFFFF", opacity: 1 },
          ],
          center: { x: 0.5, y: 0.5 },
          radius: 0.5,
        },
      }),
      "u",
    );
    expect(findAll(tree, "radialGradient")[0]?.attrs["gradientTransform"]).toBe(
      "matrix(10 0 0 20 2 4)",
    );
  });

  it("結果が空なら何も描かない (空の <g>)", () => {
    operation.result = [];
    expect(build(booleanDoc(), "u")).toEqual({ tag: "g", attrs: {}, children: [] });
  });

  it("求められなければ、子の形をブーリアンの塗りでそれぞれ重ねて描き、影はまとめて落とす", () => {
    operation.result = null;
    const tree = build(
      booleanDoc({ shadow: { x: 1, y: 1, blur: 0, color: "#000000", opacity: 1 } }),
      "u",
    );
    const group = findAll(tree, "g").find((g) => g.attrs["filter"] !== undefined);
    expect(group?.attrs["filter"]).toBe("url(#t-u-shadow)");
    const paths = findAll(tree, "path");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.attrs).toMatchObject({ d: "M0 0 L10 0 L10 10 L0 10 L0 0 Z", fill: "#D9D9D9" });
    expect(paths[1]?.attrs["d"]).toMatch(/^M15 10 C/);
    // 影の範囲は子の形を囲む範囲 (0,0)〜(15,15) から
    expect(findAll(tree, "filter")[0]?.attrs).toMatchObject({
      x: -1,
      y: -1,
      width: 18,
      height: 18,
    });
  });

  it("演算が例外を投げても描画は止めず、求められなかったものとして描く", () => {
    operation.throws = true;
    expect(findAll(build(booleanDoc(), "u"), "path")).toHaveLength(2);
  });

  it("不透明度と回転のない入れ物として、結果の SVG を文字列にできる", () => {
    operation.result = [{ closed: true, points: [corner(0, 0), corner(1, 0), corner(1, 1)] }];
    expect(svgElToString(build(booleanDoc({ opacity: 0.5 }), "u"))).toBe(
      '<g opacity="0.5"><path d="M0 0 L1 0 L1 1 L0 0 Z" fill-rule="nonzero" fill="#D9D9D9"/></g>',
    );
  });
});

describe("契約データ", () => {
  it("full の 2 ページ目 (回転したパスとブーリアン) を描ける", () => {
    const doc = fixtureDocument("full");
    const out = svgElToString(build(doc, "frame2"));
    expect(out).toContain('stroke-dasharray="8 4 2 4"');
    expect(out).toContain("rotate(15 100 110)");
    expect(out).toContain('fill="#F59E0B"');
    // 子を個別に描かない (ブーリアンの子の名前や色はそのままでは出ない)
    expect(out).not.toContain("#FFFFFF");
  });
});
