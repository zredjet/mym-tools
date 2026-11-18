/** 開発用の画面で読み込む文書と、検証用に window へ出す口。 */
import { getCanvasViewSize, zoomToFit } from "../canvas/viewCommands";
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
import { fixtureDocument, sampleDocument } from "../model/testing";
import type {
  BooleanOp,
  CanvasDocument,
  CanvasNode,
  PathNode,
  Stroke,
  Subpath,
} from "../model/types";
import { pathBounds } from "../path/measure";
import { polygonSubpath, starSubpath } from "../path/polygon";
import { ellipseSubpaths } from "../path/shapes";
import { translateSubpaths } from "../path/transform";
import { canvasTextMeasurer } from "../render/measureText";
import { editorStore } from "../state/store";
import { fitTextNodes } from "../text/fit";

const PALETTE = [
  "#2563EB",
  "#7C3AED",
  "#DB2777",
  "#EA580C",
  "#CA8A04",
  "#16A34A",
  "#0891B2",
  "#475569",
];

/** 多数のノードを持つ文書 (描画の重さを見る)。frame `frames` 個に、矩形とテキストを `perFrame` 個ずつ。 */
export function stressDocument(frames = 40, perFrame = 50): CanvasDocument {
  const nodes: CanvasNode[] = [];
  const top: string[] = [];
  const columns = Math.ceil(Math.sqrt(frames));
  for (let f = 0; f < frames; f++) {
    const children: string[] = [];
    for (let i = 0; i < perFrame; i++) {
      const id = `r${f}_${i}`;
      const color = PALETTE[(f + i) % PALETTE.length] ?? "#2563EB";
      nodes.push(
        i % 5 === 0
          ? createText({
              id,
              x: 8 + (i % 10) * 36,
              y: 8 + Math.floor(i / 10) * 36,
              text: `T${i}`,
              fontSize: 12,
            })
          : createRect({
              id,
              x: 8 + (i % 10) * 36,
              y: 8 + Math.floor(i / 10) * 36,
              width: 28,
              height: 28,
              radius: 4,
              fill: solidPaint(color),
            }),
      );
      children.push(id);
    }
    const id = `f${f}`;
    nodes.push(
      createFrame({
        id,
        name: `フレーム ${f + 1}`,
        x: (f % columns) * 420,
        y: Math.floor(f / columns) * 260,
        width: 376,
        height: 200,
        clip: true,
        children,
      }),
    );
    top.push(id);
  }
  return {
    pages: [{ id: "page1", name: "ページ 1", children: top, guides: [{ axis: "x", position: 0 }] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

/**
 * パスを、点を囲む範囲の左上が箱の左上になるように作る (§4.12)。`subpaths` は親の座標系で渡す。
 */
function placedPath(
  id: string,
  subpaths: Subpath[],
  init: Partial<Omit<PathNode, "type" | "subpaths">> = {},
): PathNode {
  const b = pathBounds(subpaths);
  const minX = b?.minX ?? 0;
  const minY = b?.minY ?? 0;
  return createPath(translateSubpaths(subpaths, -minX, -minY), {
    id,
    x: minX,
    y: minY,
    ...init,
  });
}

const corner = (x: number, y: number) => ({ x, y, in: null, out: null, mirror: "none" as const });
const smooth = (x: number, y: number, hx: number, hy: number) => ({
  x,
  y,
  in: { x: -hx, y: -hy },
  out: { x: hx, y: hy },
  mirror: "angle-length" as const,
});
const stroke = (width: number, patch: Partial<Stroke> = {}, color = "#111827"): Stroke => ({
  ...createStroke(color, width),
  ...patch,
});

/**
 * 第 2 段階 (payload v3) の見本 (§3、§4.3)。先頭のページに、回転 (矩形・楕円・テキスト・切り抜く frame と
 * その子)、線の端・角・破線、パス (曲線、塗りの規則、開いた輪郭、点 1 個の輪郭)、ブーリアン (4 つの演算と
 * 入れ子) を並べる。ブーリアンの演算が入るまでは、子の形を重ねて描く (§4.15.3)。
 */
export function stage2Document(): CanvasDocument {
  const nodes: CanvasNode[] = [];
  const children: string[] = [];
  const add = (node: CanvasNode, top = true) => {
    nodes.push(node);
    if (top) children.push(node.id);
    return node.id;
  };

  // 回転
  add(
    createRect({
      id: "rotRect",
      name: "回転した矩形",
      x: 40,
      y: 50,
      width: 120,
      height: 80,
      rotation: 30,
      radius: 12,
      fill: {
        type: "linear",
        stops: [
          { offset: 0, color: "#2563EB", opacity: 1 },
          { offset: 1, color: "#7C3AED", opacity: 1 },
        ],
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
      },
      stroke: stroke(2, { join: "round" }),
      shadow: { x: 0, y: 6, blur: 8, color: "#000000", opacity: 0.3 },
    }),
  );
  add(
    createEllipse({
      id: "rotEllipse",
      name: "回転した楕円",
      x: 200,
      y: 50,
      width: 140,
      height: 70,
      rotation: -20,
      fill: {
        type: "radial",
        stops: [
          { offset: 0, color: "#FDE68A", opacity: 1 },
          { offset: 1, color: "#EA580C", opacity: 1 },
        ],
        center: { x: 0.3, y: 0.5 },
        radius: 0.7,
      },
    }),
  );
  add(
    createText({
      id: "rotText",
      name: "回転したテキスト",
      x: 380,
      y: 70,
      text: "回転したテキスト",
      fontSize: 20,
      rotation: 15,
    }),
  );
  add(
    createRect({
      id: "rotFrameChild",
      name: "frame の子 (切り抜かれる)",
      x: 100,
      y: 60,
      width: 100,
      height: 80,
      rotation: 20,
      fill: solidPaint("#2563EB"),
    }),
    false,
  );
  add(
    createFrame({
      id: "rotFrame",
      name: "回転した frame",
      x: 620,
      y: 40,
      width: 160,
      height: 110,
      rotation: 10,
      clip: true,
      radius: 8,
      fill: solidPaint("#EFF6FF"),
      stroke: stroke(1, { dash: [4, 2] }, "#2563EB"),
      children: ["rotFrameChild"],
    }),
  );

  // 線の端・角・破線
  (["butt", "round", "square"] as const).forEach((cap, i) =>
    add(
      createLine({
        id: `cap${i}`,
        name: `端 ${cap}`,
        x1: 60,
        y1: 210 + i * 30,
        x2: 200,
        y2: 210 + i * 30,
        stroke: stroke(12, { cap }),
      }),
    ),
  );
  add(
    createLine({
      id: "dashLine",
      name: "破線",
      x1: 60,
      y1: 310,
      x2: 200,
      y2: 310,
      stroke: stroke(4, { cap: "round", dash: [12, 8] }, "#DB2777"),
    }),
  );
  (["miter", "round", "bevel"] as const).forEach((join, i) =>
    add(
      placedPath(
        `join${i}`,
        [
          {
            closed: false,
            points: [
              corner(250 + i * 120, 300),
              corner(285 + i * 120, 210),
              corner(320 + i * 120, 300),
            ],
          },
        ],
        { name: `角 ${join}`, stroke: stroke(10, { join }) },
      ),
    ),
  );
  add(
    createRect({
      id: "dashRect",
      name: "破線の矩形",
      x: 620,
      y: 210,
      width: 160,
      height: 90,
      fill: null,
      stroke: stroke(3, { dash: [8, 4, 2, 4] }, "#16A34A"),
    }),
  );

  // パス
  add(
    placedPath("star", [starSubpath(5, 0.382, { x: 40, y: 360, width: 120, height: 115 })], {
      name: "星",
      fill: solidPaint("#F59E0B"),
      stroke: stroke(2, { join: "round" }, "#92400E"),
    }),
  );
  add(
    placedPath("hexagon", [polygonSubpath(6, { x: 190, y: 365, width: 110, height: 110 })], {
      name: "回転した六角形",
      rotation: 15,
      fill: solidPaint("#0891B2"),
      stroke: null,
      shadow: { x: 4, y: 4, blur: 0, color: "#164E63", opacity: 0.6 },
    }),
  );
  add(
    placedPath(
      "donut",
      [
        ...translateSubpaths(ellipseSubpaths(120, 120), 330, 360),
        ...translateSubpaths(ellipseSubpaths(60, 60), 360, 390),
      ],
      { name: "穴のあるパス (evenodd)", fillRule: "evenodd", fill: solidPaint("#7C3AED") },
    ),
  );
  add(
    placedPath(
      "curve",
      [
        {
          closed: false,
          points: [corner(480, 460), smooth(540, 370, 40, 0), corner(620, 460)],
        },
        // 点 1 個の輪郭は描かない (§4.3)
        { closed: false, points: [corner(550, 440)] },
      ],
      {
        name: "開いた曲線 (塗りは閉じた形)",
        fill: solidPaint("#FCE7F3"),
        stroke: stroke(3, { cap: "round", dash: [10, 5] }, "#DB2777"),
      },
    ),
  );
  add(
    placedPath(
      "wave",
      [
        {
          closed: true,
          points: [
            smooth(660, 400, 0, -25),
            smooth(720, 370, 30, 0),
            smooth(780, 400, 0, 25),
            smooth(720, 470, -30, 0),
          ],
        },
      ],
      {
        name: "滑らかな閉じたパス",
        rotation: -30,
        fill: {
          type: "linear",
          stops: [
            { offset: 0, color: "#16A34A", opacity: 1 },
            { offset: 1, color: "#CA8A04", opacity: 1 },
          ],
          from: { x: 0, y: 0 },
          to: { x: 1, y: 0 },
        },
        stroke: null,
      },
    ),
  );

  // ブーリアン
  const ops: BooleanOp[] = ["union", "subtract", "intersect", "exclude"];
  ops.forEach((op, i) => {
    const x = 40 + i * 190;
    const rect = add(
      createRect({ id: `b${i}r`, x, y: 520, width: 90, height: 90, radius: 8 }),
      false,
    );
    const ellipse = add(
      createEllipse({ id: `b${i}e`, x: x + 45, y: 555, width: 90, height: 70, rotation: 20 }),
      false,
    );
    add(
      createBoolean(op, [rect, ellipse], {
        id: `bool${i}`,
        fill: solidPaint(PALETTE[i] ?? "#2563EB"),
        stroke: stroke(2),
      }),
    );
  });
  const inner = add(
    createBoolean(
      "subtract",
      [
        add(createRect({ id: "nr", x: 800, y: 520, width: 100, height: 100 }), false),
        add(createEllipse({ id: "ne", x: 825, y: 545, width: 50, height: 50 }), false),
      ],
      { id: "nestedInner" },
    ),
    false,
  );
  add(
    createBoolean(
      "union",
      [
        inner,
        add(
          placedPath("np", [starSubpath(4, 0.4, { x: 860, y: 590, width: 60, height: 60 })], {
            fill: solidPaint("#000000"),
          }),
          false,
        ),
      ],
      { id: "nested", name: "入れ子のブーリアン", fill: solidPaint("#475569") },
    ),
  );

  const frame = createFrame({
    id: "stage2",
    name: "第 2 段階の見本",
    x: 0,
    y: 0,
    width: 960,
    height: 680,
    children,
  });
  return {
    pages: [{ id: "page1", name: "ページ 1", children: [frame.id], guides: [] }],
    nodes: Object.fromEntries([frame, ...nodes].map((node) => [node.id, node])),
    assets: {},
  };
}

export const HARNESS_DOCUMENTS = {
  full: () => fixtureDocument("full"),
  stage2: () => stage2Document(),
  empty: () => fixtureDocument("empty"),
  sample: () => sampleDocument(),
  stress: () => stressDocument(),
} as const;

export type HarnessDocumentName = keyof typeof HARNESS_DOCUMENTS;

export type Theme = "light" | "dark";

export function applyTheme(theme: Theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}

/** 読み込む文書を作る。テキストの大きさは `load` に渡す前に求め直す (§4.7)。 */
export function harnessDocument(name: HarnessDocumentName): CanvasDocument {
  return fitTextNodes(HARNESS_DOCUMENTS[name](), null, canvasTextMeasurer);
}

export function loadDocument(name: HarnessDocumentName) {
  editorStore.getState().load(harnessDocument(name));
  const size = getCanvasViewSize();
  if (size.width > 0) zoomToFit({ store: editorStore, size, measurer: canvasTextMeasurer }, 1);
}

declare global {
  interface Window {
    __canvasHarness?: {
      store: typeof editorStore;
      load(name: HarnessDocumentName): void;
      setTheme(theme: Theme): void;
      documents: typeof HARNESS_DOCUMENTS;
    };
  }
}

/** 検証用に store を window から触れるようにする (開発用の画面の中だけで呼ぶ)。 */
export function exposeHarness() {
  window.__canvasHarness = {
    store: editorStore,
    load: loadDocument,
    setTheme: applyTheme,
    documents: HARNESS_DOCUMENTS,
  };
}

export function initialTheme(): Theme {
  const param = new URLSearchParams(window.location.search).get("theme");
  if (param === "dark" || param === "light") return param;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function initialDocument(): HarnessDocumentName {
  const param = new URLSearchParams(window.location.search).get("doc");
  return param !== null && param in HARNESS_DOCUMENTS ? (param as HarnessDocumentName) : "full";
}
