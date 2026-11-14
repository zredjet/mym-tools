/**
 * 文書とノードの作成。既定値は `docs/canvas-editor-design.md` §3 と §5.7 に合わせる。
 * どの関数も `init` で任意のフィールドを上書きできる (`id` を省くと新しい ID を振る)。
 */
import { createId } from "./ids";
import type {
  CanvasDocument,
  EllipseNode,
  FrameNode,
  GroupNode,
  ImageNode,
  LineNode,
  NodeId,
  Page,
  RectNode,
  SolidPaint,
  Stroke,
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
} as const;

export function solidPaint(color: string, opacity = 1): SolidPaint {
  return { type: "solid", color, opacity };
}

export function createStroke(color = "#000000", width = 1, opacity = 1): Stroke {
  return { color, opacity, width };
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
    ...init,
    assetId,
    type: "svg",
  };
}
