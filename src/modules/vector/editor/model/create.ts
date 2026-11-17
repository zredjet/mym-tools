/**
 * 文書とノードの作成。既定値は `docs/canvas-editor-design.md` §3、§5.7、§8.3 に合わせる。
 * どの関数も `init` で任意のフィールドを上書きできる (`id` を省くと新しい ID を振る)。
 */
import { pathBounds } from "../path/measure";
import { createId } from "./ids";
import type {
  BooleanNode,
  BooleanOp,
  CanvasDocument,
  EllipseNode,
  FrameNode,
  GroupNode,
  ImageNode,
  LineNode,
  NodeId,
  Page,
  PathNode,
  RectNode,
  SolidPaint,
  Stroke,
  StrokeCap,
  StrokeJoin,
  Subpath,
  SvgNode,
  TextNode,
} from "./types";

/** 新しい文書の先頭ページ。v1 からの変換 (§3.7) と同じ ID と名前にする。 */
export const FIRST_PAGE_ID = "page1";
export const FIRST_PAGE_NAME = "ページ 1";

/** 新しいテキストの既定 (§5.7)。フォントは PC によって変わるので、テキストのセッションが上書きする。 */
export const DEFAULT_FONT_FAMILY = "sans-serif";
export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_FONT_WEIGHT = 400;

/** 種別ごとの既定の名前。レイヤーパネルに出る。 */
export const DEFAULT_NODE_NAMES = {
  frame: "フレーム",
  group: "グループ",
  rect: "矩形",
  ellipse: "楕円",
  line: "線",
  text: "テキスト",
  image: "画像",
  svg: "SVG",
  path: "パス",
  boolean: "ブーリアン",
} as const;

/** ブーリアンの演算ごとの名前 (§8.9.4)。新しいブーリアンの名前と、画面の演算の表示に使う。 */
export const BOOLEAN_OP_NAMES: Readonly<Record<BooleanOp, string>> = {
  union: "合体",
  subtract: "型抜き",
  intersect: "交差",
  exclude: "中マド",
};

/** 線の端・角・破線の既定 (§8.4)。描画はこの値のとき属性を付けない (v2 と同じ出力)。 */
export const DEFAULT_STROKE_CAP: StrokeCap = "butt";
export const DEFAULT_STROKE_JOIN: StrokeJoin = "miter";

export function solidPaint(color: string, opacity = 1): SolidPaint {
  return { type: "solid", color, opacity };
}

/** 線。端・角・破線は既定 (なし・マイター・実線)。 */
export function createStroke(color = "#000000", width = 1, opacity = 1): Stroke {
  return { color, opacity, width, cap: DEFAULT_STROKE_CAP, join: DEFAULT_STROKE_JOIN, dash: [] };
}

/** ページ 1 つ、ノードなしの文書。 */
export function createEmptyDocument(): CanvasDocument {
  return {
    pages: [createPage({ id: FIRST_PAGE_ID, name: FIRST_PAGE_NAME })],
    nodes: {},
    assets: {},
  };
}

export function createPage(init: Partial<Page> = {}): Page {
  return { id: createId(), name: FIRST_PAGE_NAME, children: [], guides: [], ...init };
}

type Init<T> = Partial<Omit<T, "type">>;

const common = (init: { id?: NodeId }, name: string) => ({
  id: init.id ?? createId(),
  name,
  visible: true,
  locked: false,
  opacity: 1,
});

export function createFrame(init: Init<FrameNode> = {}): FrameNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.frame),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    children: [],
    clip: true,
    fill: solidPaint("#FFFFFF"),
    stroke: null,
    radius: 0,
    shadow: null,
    ...init,
    type: "frame",
  };
}

/** group は子が 1 個以上必要なので、子の ID を必ず受け取る。 */
export function createGroup(children: readonly NodeId[], init: Init<GroupNode> = {}): GroupNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.group),
    ...init,
    children: [...children],
    type: "group",
  };
}

export function createRect(init: Init<RectNode> = {}): RectNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.rect),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fill: solidPaint("#D9D9D9"),
    stroke: null,
    radius: 0,
    shadow: null,
    ...init,
    type: "rect",
  };
}

export function createEllipse(init: Init<EllipseNode> = {}): EllipseNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.ellipse),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fill: solidPaint("#D9D9D9"),
    stroke: null,
    shadow: null,
    ...init,
    type: "ellipse",
  };
}

export function createLine(init: Init<LineNode> = {}): LineNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.line),
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 0,
    stroke: createStroke(),
    ...init,
    type: "line",
  };
}

export function createText(init: Init<TextNode> = {}): TextNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.text),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    text: "",
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    fontWeight: DEFAULT_FONT_WEIGHT,
    italic: false,
    lineHeight: null,
    letterSpacing: 0,
    align: "left",
    sizing: "auto-width",
    fill: solidPaint("#000000"),
    shadow: null,
    ...init,
    type: "text",
  };
}

/** `assetId` は `addAsset` (assets.ts) が返した ID を渡す。 */
export function createImage(assetId: string, init: Init<ImageNode> = {}): ImageNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.image),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    radius: 0,
    shadow: null,
    ...init,
    assetId,
    type: "image",
  };
}

/** `assetId` は `addAsset` (assets.ts) が返した ID を渡す。 */
export function createSvg(assetId: string, init: Init<SvgNode> = {}): SvgNode {
  return {
    ...common(init, DEFAULT_NODE_NAMES.svg),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    ...init,
    assetId,
    type: "svg",
  };
}

/**
 * パス。点は自分の座標系 (箱の左上が原点、回転の前) で渡す。`width` / `height` を省くと、曲線の範囲
 * (`pathBounds`) の大きさにする。範囲の左上が (0, 0) でなければ、`fitPathNodes` (§8.6) が箱を合わせ直す。
 * 既定はペンと同じ (塗りなし、線は `createStroke()`、名前は「パス」)。多角形・星は塗りと線を上書きする。
 */
export function createPath(subpaths: readonly Subpath[], init: Init<PathNode> = {}): PathNode {
  const bounds = pathBounds(subpaths);
  return {
    ...common(init, DEFAULT_NODE_NAMES.path),
    x: 0,
    y: 0,
    width: bounds ? bounds.maxX - bounds.minX : 0,
    height: bounds ? bounds.maxY - bounds.minY : 0,
    rotation: 0,
    fillRule: "nonzero",
    fill: null,
    stroke: createStroke(),
    shadow: null,
    ...init,
    subpaths: subpaths.map((sub) => ({
      closed: sub.closed,
      points: sub.points.map((p) => ({
        x: p.x,
        y: p.y,
        in: p.in && { x: p.in.x, y: p.in.y },
        out: p.out && { x: p.out.x, y: p.out.y },
        mirror: p.mirror,
      })),
    })),
    type: "path",
  };
}

/**
 * ブーリアン。子は 1 個以上 (rect / ellipse / path / boolean) なので、子の ID を必ず受け取る。
 * 名前は演算の名前 (§8.9.4)。塗り・線・影は、作る操作が最背面の子のものを写して上書きする。
 */
export function createBoolean(
  op: BooleanOp,
  children: readonly NodeId[],
  init: Init<BooleanNode> = {},
): BooleanNode {
  return {
    ...common(init, BOOLEAN_OP_NAMES[op]),
    fill: solidPaint("#D9D9D9"),
    stroke: null,
    shadow: null,
    ...init,
    op,
    children: [...children],
    type: "boolean",
  };
}
