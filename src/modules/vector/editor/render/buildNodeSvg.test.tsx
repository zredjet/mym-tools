import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createEllipse,
  createFrame,
  createGroup,
  createImage,
  createLine,
  createRect,
  createSvg,
  createText,
  solidPaint,
} from "../model/create";
import { fixtureDocument } from "../model/testing";
import type { CanvasDocument, CanvasNode, ImageAsset, SvgAsset } from "../model/types";
import { assetDataUrl, buildNodeSvg, cssFontFamily, defId, utf8ToBase64 } from "./buildNodeSvg";
import { svgElToReact, svgElToString } from "./svgEl";
import { fixedWidthMeasurer } from "./testing";
import type { RenderOptions, SvgEl } from "./types";

const OPTIONS: RenderOptions = { measurer: fixedWidthMeasurer(0.5), idPrefix: "t-" };

const PNG: ImageAsset = {
  kind: "image",
  mime: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  width: 1,
  height: 1,
};

const SVG_ASSET: SvgAsset = {
  kind: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>旧作品</text></svg>',
  text: "旧作品",
  width: 10,
  height: 10,
};

function docOf(
  nodes: CanvasNode[],
  top: string[],
  assets: CanvasDocument["assets"] = {},
): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets,
  };
}

function build(doc: CanvasDocument, id: string): SvgEl {
  const result = buildNodeSvg(doc, id, OPTIONS);
  if (!result) throw new Error("null");
  return result;
}

/** 木の中からタグで要素を探す (深さ優先)。 */
function findAll(tree: SvgEl | string, tag: string): SvgEl[] {
  if (typeof tree === "string") return [];
  const own = tree.tag === tag ? [tree] : [];
  return [...own, ...tree.children.flatMap((child) => findAll(child, tag))];
}

function find(tree: SvgEl, tag: string): SvgEl {
  const found = findAll(tree, tag)[0];
  if (!found) throw new Error(`no <${tag}>`);
  return found;
}

describe("buildNodeSvg: 種別ごと", () => {
  it("rect: 位置、大きさ、角丸、単色の塗り、線", () => {
    const rect = createRect({
      id: "r",
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      radius: 4,
      fill: solidPaint("#FF0000", 0.5),
      stroke: { color: "#00FF00", opacity: 1, width: 2 },
    });
    expect(build(docOf([rect], ["r"]), "r")).toEqual({
      tag: "rect",
      attrs: {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rx: 4,
        fill: "#FF0000",
        "fill-opacity": 0.5,
        stroke: "#00FF00",
        "stroke-width": 2,
      },
      children: [],
    });
  });

  it("塗りも線もなければ fill=none で stroke を出さない", () => {
    const rect = createRect({ id: "r", fill: null, stroke: null });
    const out = build(docOf([rect], ["r"]), "r");
    expect(out.attrs["fill"]).toBe("none");
    expect(out.attrs["stroke"]).toBeUndefined();
    expect(out.attrs["rx"]).toBeUndefined();
  });

  it("ellipse: 外接矩形から中心と半径を求める", () => {
    const ellipse = createEllipse({ id: "e", x: 10, y: 20, width: 40, height: 20 });
    const out = build(docOf([ellipse], ["e"]), "e");
    expect(out.tag).toBe("ellipse");
    expect(out.attrs).toMatchObject({ cx: 30, cy: 30, rx: 20, ry: 10 });
  });

  it("line: 2 点と線", () => {
    const line = createLine({
      id: "l",
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      stroke: { color: "#123456", opacity: 0.3, width: 5 },
    });
    expect(build(docOf([line], ["l"]), "l")).toEqual({
      tag: "line",
      attrs: {
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        stroke: "#123456",
        "stroke-opacity": 0.3,
        "stroke-width": 5,
      },
      children: [],
    });
  });

  it("不透明度は外側の <g> に付ける", () => {
    const rect = createRect({ id: "r", opacity: 0.4 });
    const out = build(docOf([rect], ["r"]), "r");
    expect(out.tag).toBe("g");
    expect(out.attrs["opacity"]).toBe(0.4);
    expect((out.children[0] as SvgEl).tag).toBe("rect");
  });

  it("group: 不透明度だけを持ち、子をそのまま入れる (座標系を作らない)", () => {
    const doc = docOf(
      [
        createGroup(["a", "b"], { id: "g", opacity: 0.5 }),
        createRect({ id: "a", x: 5 }),
        createRect({ id: "b", x: 50 }),
      ],
      ["g"],
    );
    const out = build(doc, "g");
    expect(out.tag).toBe("g");
    expect(out.attrs).toEqual({ opacity: 0.5 });
    expect(out.children.map((child) => (child as SvgEl).attrs["x"])).toEqual([5, 50]);
  });

  it("frame: 塗りの矩形、子を frame の位置へ移す <g>、子の上に線", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 100,
          y: 50,
          width: 200,
          height: 100,
          radius: 8,
          clip: false,
          children: ["r"],
          stroke: { color: "#000000", opacity: 1, width: 1 },
        }),
        createRect({ id: "r", x: 10, y: 10 }),
      ],
      ["f"],
    );
    const out = build(doc, "f");
    expect(out.tag).toBe("g");
    const [bg, content, stroke] = out.children as SvgEl[];
    expect(bg?.attrs).toMatchObject({
      x: 100,
      y: 50,
      width: 200,
      height: 100,
      rx: 8,
      fill: "#FFFFFF",
    });
    expect(content?.attrs).toEqual({ transform: "translate(100 50)" });
    expect((content?.children[0] as SvgEl).attrs).toMatchObject({ x: 10, y: 10 });
    expect(stroke?.attrs).toMatchObject({ fill: "none", stroke: "#000000", rx: 8 });
  });

  it("frame: clip なら子を角丸の clipPath で切り抜く (frame の座標系で 0,0 から)", () => {
    const doc = docOf(
      [
        createFrame({
          id: "f",
          x: 10,
          y: 20,
          width: 50,
          height: 60,
          radius: 6,
          clip: true,
          children: [],
        }),
      ],
      ["f"],
    );
    const out = build(doc, "f");
    const clip = find(out, "clipPath");
    expect(clip.attrs["id"]).toBe("t-f-clip");
    expect((clip.children[0] as SvgEl).attrs).toEqual({ x: 0, y: 0, width: 50, height: 60, rx: 6 });
    const content = (out.children as SvgEl[]).find((child) => child.attrs["clip-path"]);
    expect(content?.attrs).toEqual({
      transform: "translate(10 20)",
      "clip-path": "url(#t-f-clip)",
    });
  });

  it("frame: 位置が 0,0 なら transform を出さない", () => {
    const doc = docOf([createFrame({ id: "f", clip: false, fill: null, children: [] })], ["f"]);
    expect(build(doc, "f")).toEqual({ tag: "g", attrs: {}, children: [] });
  });

  it("text: layoutText の行を tspan に置き、フォントの属性を付ける", () => {
    const text = createText({
      id: "t",
      x: 10,
      y: 20,
      text: "一行目\n\n<b>&",
      fontFamily: "Hiragino Sans",
      fontSize: 10,
      fontWeight: 700,
      italic: true,
      letterSpacing: 1,
      lineHeight: 20,
    });
    const out = build(docOf([text], ["t"]), "t");
    expect(out.tag).toBe("text");
    expect(out.attrs).toMatchObject({
      "font-family": '"Hiragino Sans", sans-serif',
      "font-size": 10,
      "font-weight": 700,
      "font-style": "italic",
      "letter-spacing": 1,
      fill: "#000000",
      "xml:space": "preserve",
    });
    // 仮の layoutText: y = index * lineHeight + (lineHeight + fontSize * 0.7) / 2
    expect(out.children).toEqual([
      { tag: "tspan", attrs: { x: 10, y: 20 + 13.5 }, children: ["一行目"] },
      { tag: "tspan", attrs: { x: 10, y: 20 + 33.5 }, children: [] },
      { tag: "tspan", attrs: { x: 10, y: 20 + 53.5 }, children: ["<b>&"] },
    ]);
  });

  it("text: 斜体でなく字間 0 なら font-style と letter-spacing を出さない", () => {
    const out = build(docOf([createText({ id: "t", text: "a" })], ["t"]), "t");
    expect(out.attrs["font-style"]).toBeUndefined();
    expect(out.attrs["letter-spacing"]).toBeUndefined();
    expect(out.attrs["font-family"]).toBe("sans-serif");
  });

  it("image: data URL、preserveAspectRatio=none、角丸は clipPath", () => {
    const doc = docOf(
      [createImage("a1", { id: "i", x: 1, y: 2, width: 30, height: 40, radius: 5 })],
      ["i"],
      { a1: PNG },
    );
    const out = build(doc, "i");
    const image = find(out, "image");
    expect(image.attrs).toEqual({
      x: 1,
      y: 2,
      width: 30,
      height: 40,
      href: `data:image/png;base64,${PNG.data}`,
      preserveAspectRatio: "none",
      "clip-path": "url(#t-i-clip)",
    });
    expect(find(out, "clipPath").children[0]).toEqual({
      tag: "rect",
      attrs: { x: 1, y: 2, width: 30, height: 40, rx: 5 },
      children: [],
    });
  });

  it("image: 角丸がなければ要素 1 個", () => {
    const doc = docOf([createImage("a1", { id: "i" })], ["i"], { a1: PNG });
    expect(build(doc, "i").tag).toBe("image");
  });

  it("svg: UTF-8 を base64 にした data:image/svg+xml", () => {
    const doc = docOf([createSvg("s1", { id: "s", width: 10, height: 10 })], ["s"], {
      s1: SVG_ASSET,
    });
    const out = build(doc, "s");
    expect(out.tag).toBe("image");
    const href = String(out.attrs["href"]);
    expect(href.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(href.slice("data:image/svg+xml;base64,".length)), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(decoded).toBe(SVG_ASSET.svg);
  });

  it("アセットが見つからなければ空の <g>", () => {
    const doc = docOf([createImage("missing", { id: "i" })], ["i"]);
    expect(build(doc, "i")).toEqual({ tag: "g", attrs: {}, children: [] });
  });
});

describe("buildNodeSvg: 塗り・影の定義", () => {
  it("線形グラデーション: 定義をすぐ隣の <defs> に置き、外接矩形へ写す", () => {
    const rect = createRect({
      id: "r",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: {
        type: "linear",
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        stops: [
          { offset: 0, color: "#000000", opacity: 1 },
          { offset: 1, color: "#FFFFFF", opacity: 0.5 },
        ],
      },
    });
    const out = build(docOf([rect], ["r"]), "r");
    expect(out.tag).toBe("g");
    const [defs, shape] = out.children as SvgEl[];
    expect(defs?.tag).toBe("defs");
    expect(defs?.children[0]).toEqual({
      tag: "linearGradient",
      attrs: {
        id: "t-r-fill",
        gradientUnits: "userSpaceOnUse",
        gradientTransform: "matrix(100 0 0 50 10 20)",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
      },
      children: [
        { tag: "stop", attrs: { offset: 0, "stop-color": "#000000" }, children: [] },
        {
          tag: "stop",
          attrs: { offset: 1, "stop-color": "#FFFFFF", "stop-opacity": 0.5 },
          children: [],
        },
      ],
    });
    expect(shape?.attrs["fill"]).toBe("url(#t-r-fill)");
  });

  it("円形グラデーション: center と radius", () => {
    const ellipse = createEllipse({
      id: "e",
      fill: {
        type: "radial",
        center: { x: 0.5, y: 0.25 },
        radius: 0.75,
        stops: [
          { offset: 0, color: "#000000", opacity: 1 },
          { offset: 1, color: "#FFFFFF", opacity: 1 },
        ],
      },
    });
    const gradient = find(build(docOf([ellipse], ["e"]), "e"), "radialGradient");
    expect(gradient.attrs).toMatchObject({ id: "t-e-fill", cx: 0.5, cy: 0.25, r: 0.75 });
  });

  it("影: feDropShadow、ぼかしは標準偏差の 2 倍、範囲は影の届く所まで", () => {
    const rect = createRect({
      id: "r",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      stroke: null,
      shadow: { x: 4, y: -6, blur: 10, color: "#112233", opacity: 0.3 },
    });
    const out = build(docOf([rect], ["r"]), "r");
    const filter = find(out, "filter");
    expect(filter.attrs).toMatchObject({
      id: "t-r-shadow",
      filterUnits: "userSpaceOnUse",
      x: -16,
      y: -22,
      width: 136,
      height: 138,
    });
    expect(filter.children[0]).toEqual({
      tag: "feDropShadow",
      attrs: { dx: 4, dy: -6, stdDeviation: 5, "flood-color": "#112233", "flood-opacity": 0.3 },
      children: [],
    });
    expect(find(out, "rect").attrs["filter"]).toBe("url(#t-r-shadow)");
  });

  it("image の影は切り抜きの外側に付ける", () => {
    const doc = docOf(
      [
        createImage("a1", {
          id: "i",
          radius: 4,
          shadow: { x: 0, y: 2, blur: 4, color: "#000000", opacity: 0.5 },
        }),
      ],
      ["i"],
      { a1: PNG },
    );
    const out = build(doc, "i");
    const wrapper = (out.children as SvgEl[])[1];
    expect(wrapper?.attrs).toEqual({ filter: "url(#t-i-shadow)" });
    expect((wrapper?.children[0] as SvgEl).attrs["clip-path"]).toBe("url(#t-i-clip)");
  });

  it("frame の影: 塗りと線の矩形が落とし、必ず子の背面に描く (影だけを出す要素を先頭に置く)", () => {
    const shadow = { x: 0, y: 2, blur: 4, color: "#112233", opacity: 0.5 };
    const stroke = { color: "#000000", opacity: 1, width: 6 };
    const frameDoc = (init: Parameters<typeof createFrame>[0]) =>
      docOf(
        [
          createFrame({ id: "f", clip: false, shadow, children: ["c"], ...init }),
          createRect({ id: "c" }),
        ],
        ["f"],
      );
    const body = (tree: SvgEl) =>
      (tree.children as SvgEl[]).filter((child) => child.tag !== "defs");

    // 塗りと線: 影の要素 → 塗り → 子 → 線。影の要素は塗りと線の両方を持つ (線の外側も影を落とす)
    const both = build(frameDoc({ stroke }), "f");
    const [shadowRect, fillRect, content, strokeRect] = body(both);
    expect(shadowRect?.attrs).toMatchObject({
      fill: "#FFFFFF",
      stroke: "#000000",
      "stroke-width": 6,
      filter: "url(#t-f-shadow)",
    });
    expect(fillRect?.attrs["filter"]).toBeUndefined();
    expect(content?.children[0]).toMatchObject({ tag: "rect" });
    expect(strokeRect?.attrs).toMatchObject({ fill: "none", stroke: "#000000" });
    expect(strokeRect?.attrs["filter"]).toBeUndefined();

    // 影だけを出すフィルタ (元の図形を重ねて描かない)
    const filter = find(both, "filter");
    expect(filter.children.map((child) => (child as SvgEl).tag)).toEqual([
      "feGaussianBlur",
      "feOffset",
      "feFlood",
      "feComposite",
    ]);
    expect((filter.children[0] as SvgEl).attrs).toEqual({ in: "SourceAlpha", stdDeviation: 2 });
    expect((filter.children[2] as SvgEl).attrs).toEqual({
      "flood-color": "#112233",
      "flood-opacity": 0.5,
    });

    // 線だけ: 影の要素は子より前 (子の上に影が重ならない)
    const strokeOnly = body(build(frameDoc({ fill: null, stroke }), "f"));
    expect(strokeOnly.map((child) => child.attrs["filter"] ?? child.tag)).toEqual([
      "url(#t-f-shadow)",
      "g",
      "rect",
    ]);
    expect(strokeOnly[0]?.attrs["fill"]).toBe("none");

    // 塗りも線もなければ影もない
    const neither = build(frameDoc({ fill: null, stroke: null }), "f");
    expect(findAll(neither, "filter")).toEqual([]);
  });

  it("大きさ 0 の外接矩形のグラデーションは、先頭の停止点の色の単色にする", () => {
    const fill = {
      type: "linear" as const,
      from: { x: 0, y: 0 },
      to: { x: 1, y: 0 },
      stops: [
        { offset: 0, color: "#123456", opacity: 0.4 },
        { offset: 1, color: "#FFFFFF", opacity: 1 },
      ],
    };
    const text = createText({ id: "t", text: "a", width: 0, height: 0, fill });
    const out = build(docOf([text], ["t"]), "t");
    expect(out.tag).toBe("text");
    expect(out.attrs).toMatchObject({ fill: "#123456", "fill-opacity": 0.4 });
    expect(findAll(out, "linearGradient")).toEqual([]);
    const flat = build(docOf([createRect({ id: "r", width: 10, height: 0, fill })], ["r"]), "r");
    expect(flat.attrs["fill"]).toBe("#123456");
  });

  it("テキストの影の領域は、斜体や行の高さからはみ出す字形が欠けないよう広げる", () => {
    const text = createText({
      id: "t",
      x: 100,
      y: 200,
      width: 96,
      height: 48,
      text: "fgjy",
      fontSize: 48,
      lineHeight: 48,
      italic: true,
      shadow: { x: 0, y: 1, blur: 0, color: "#000000", opacity: 1 },
    });
    const filter = find(build(docOf([text], ["t"]), "t"), "filter");
    const { x, y, width, height } = filter.attrs as unknown as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    // 左右と上下に フォントサイズ × 0.5 = 24 以上の余裕
    expect(x).toBeLessThanOrEqual(100 - 24);
    expect(y).toBeLessThanOrEqual(200 - 24);
    expect(x + width).toBeGreaterThanOrEqual(100 + 96 + 24);
    expect(y + height).toBeGreaterThanOrEqual(200 + 48 + 24);
  });

  it("定義の ID は idPrefix + ノード ID + 種類で、文書の中で重ならない", () => {
    const doc = fixtureDocument("full");
    const out = buildNodeSvg(doc, "frame1", { ...OPTIONS, idPrefix: "x-" });
    const ids = JSON.stringify(out).match(/"id":"[^"]+"/g) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`"id":"${defId("x-", "rect1", "fill")}"`);
    expect(ids).toContain(`"id":"${defId("x-", "rect1", "shadow")}"`);
    expect(ids).toContain(`"id":"${defId("x-", "frame1", "clip")}"`);
    expect(ids).toContain(`"id":"${defId("x-", "image1", "clip")}"`);
  });
});

describe("buildNodeSvg: 表示と構造", () => {
  it("visible が false なら null、子にも出さない", () => {
    const doc = docOf(
      [
        createGroup(["a", "b"], { id: "g" }),
        createRect({ id: "a", visible: false }),
        createRect({ id: "b" }),
      ],
      ["g"],
    );
    expect(buildNodeSvg(doc, "a", OPTIONS)).toBeNull();
    expect(build(doc, "g").children).toHaveLength(1);
    const hiddenGroup = {
      ...doc,
      nodes: { ...doc.nodes, g: { ...doc.nodes["g"]!, visible: false } },
    };
    expect(buildNodeSvg(hiddenGroup, "g", OPTIONS)).toBeNull();
  });

  it("存在しないノードは null", () => {
    expect(buildNodeSvg(docOf([], []), "nope", OPTIONS)).toBeNull();
  });

  it("壊れた文書 (子が祖先を指す) でも止まる", () => {
    const doc = docOf([createGroup(["g"], { id: "g" })], ["g"]);
    expect(build(doc, "g")).toEqual({ tag: "g", attrs: {}, children: [] });
  });

  it("契約データ full を描ける", () => {
    const doc = fixtureDocument("full");
    for (const id of ["frame1", "svg1", "frame2"])
      expect(buildNodeSvg(doc, id, OPTIONS)).not.toBeNull();
    const svg = svgElToString(build(doc, "frame1"));
    expect(svg).toContain("<tspan");
    expect(svg).toContain("見出し　テキスト");
  });
});

describe("フォントと data URL", () => {
  it("cssFontFamily: 総称はそのまま、ほかは引用符で囲み sans-serif を続ける", () => {
    expect(cssFontFamily("serif")).toBe("serif");
    expect(cssFontFamily("System-UI")).toBe("System-UI");
    expect(cssFontFamily('A "B" \\ C')).toBe('"A \\"B\\" \\\\ C", sans-serif');
  });

  it("utf8ToBase64: 多バイト文字と大きな文字列", () => {
    expect(utf8ToBase64("あ")).toBe("44GC");
    const big = "あ".repeat(200_000);
    expect(atob(utf8ToBase64(big)).length).toBe(600_000);
  });

  it("assetDataUrl: 同じアセットのオブジェクトなら同じ文字列を使い回す", () => {
    const first = assetDataUrl(SVG_ASSET);
    expect(assetDataUrl(SVG_ASSET)).toBe(first);
    expect(assetDataUrl(PNG)).toBe(`data:image/png;base64,${PNG.data}`);
  });
});

describe("文字列と React 要素", () => {
  const parse = (markup: string) =>
    new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
      "image/svg+xml",
    ).documentElement;

  it("同じ木から作った文字列と React 要素は同じ SVG になる", () => {
    const doc = fixtureDocument("full");
    for (const id of ["frame1", "svg1"]) {
      const tree = build(doc, id);
      const fromString = parse(svgElToString(tree));
      const fromReact = parse(
        renderToStaticMarkup(<svg>{svgElToReact(tree)}</svg>).replace(/^<svg>|<\/svg>$/g, ""),
      );
      expect(fromString.querySelector("parsererror")).toBeNull();
      expect(fromReact.querySelector("parsererror")).toBeNull();
      expect(fromReact.isEqualNode(fromString)).toBe(true);
    }
  });
});
