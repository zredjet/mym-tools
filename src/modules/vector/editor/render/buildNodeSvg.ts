/**
 * ノードを `SvgEl` にする (§4.3、契約は `render/types.ts` の `BuildNodeSvg`)。
 *
 * 形の規則は `buildNodeShell` (ノード 1 個、子は差し込み位置のまま) にだけ書く。
 * 書き出し用の `buildNodeSvg` はそれを再帰で組み立て、画面 (`canvas/DocumentLayer.tsx`) は
 * ノードごとのコンポーネントが同じ関数を呼んで子のコンポーネントを差し込む。
 */
import { hasOwn } from "../model/ids";
import { getNode, isContainer } from "../model/tree";
import type {
  Asset,
  CanvasDocument,
  CanvasNode,
  NodeId,
  Paint,
  Shadow,
  Stroke,
  TextNode,
} from "../model/types";
import { layoutText } from "../text/layout";
import { CHILDREN_SLOT, el, fillSlot } from "./svgEl";
import type {
  BuildNodeSvg,
  FontSpec,
  RenderOptions,
  SvgEl,
  TextLayout,
  TextMeasurer,
} from "./types";

/** `buildNodeShell` に渡すもの。画像と埋め込み SVG のアセットは呼び出し側が引いて渡す。 */
export interface ShellContext {
  measurer: TextMeasurer;
  idPrefix: string;
  /** image / svg ノードが指すアセット。見つからなければ undefined */
  asset: Asset | undefined;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// 定義の ID
// ---------------------------------------------------------------------------

export type DefKind = "fill" | "shadow" | "clip";

/** `<defs>` に置く定義の ID。`idPrefix` + ノード ID + 種類。 */
export function defId(idPrefix: string, nodeId: NodeId, kind: DefKind): string {
  return `${idPrefix}${nodeId}-${kind}`;
}

// ---------------------------------------------------------------------------
// フォント
// ---------------------------------------------------------------------------

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

/**
 * CSS の `font-family` の値。総称フォントはそのまま、ほかは引用符で囲み、
 * その PC にないときのために `sans-serif` を続ける (§4.7)。計測と描画で同じ値を使う。
 */
export function cssFontFamily(family: string): string {
  const trimmed = family.trim();
  if (GENERIC_FAMILIES.has(trimmed.toLowerCase())) return trimmed;
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", sans-serif`;
}

export function fontSpecOf(node: TextNode): FontSpec {
  return {
    family: node.fontFamily,
    size: node.fontSize,
    weight: node.fontWeight,
    italic: node.italic,
    letterSpacing: node.letterSpacing,
  };
}

/** canvas の `ctx.font` に渡す文字列 (字間は含まない)。 */
export function cssFont(font: FontSpec): string {
  return `${font.italic ? "italic " : ""}${font.weight} ${font.size}px ${cssFontFamily(font.family)}`;
}

// ---------------------------------------------------------------------------
// アセットの data URL
// ---------------------------------------------------------------------------

/** UTF-8 の文字列を base64 にする (大きな文字列でも引数の上限に当たらないよう区切って変換する)。 */
export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const dataUrlCache = new WeakMap<Asset, string>();

/** アセットの data URL。組み立ては重いので、アセットのオブジェクトをキーにして使い回す。 */
export function assetDataUrl(asset: Asset): string {
  const cached = dataUrlCache.get(asset);
  if (cached !== undefined) return cached;
  const url =
    asset.kind === "image"
      ? `data:${asset.mime};base64,${asset.data}`
      : `data:image/svg+xml;base64,${utf8ToBase64(asset.svg)}`;
  dataUrlCache.set(asset, url);
  return url;
}

// ---------------------------------------------------------------------------
// 塗り・線・影
// ---------------------------------------------------------------------------

/**
 * 塗りの属性。グラデーションは `defs` に定義を足す。
 * 座標は外接矩形を 0〜1 に正規化した値なので、`gradientTransform` で外接矩形へ写す
 * (`objectBoundingBox` と同じ結果で、文字の字形の外接矩形ではなくノードの矩形を基準にできる)。
 * 外接矩形の幅か高さが 0 なら、先頭の停止点の色の単色にする (§4.3)。
 */
function paintAttrs(
  paint: Paint | null,
  box: Box,
  id: string,
  defs: SvgEl[],
): Record<string, string | number | undefined> {
  if (paint === null) return { fill: "none" };
  if (paint.type === "solid") {
    return { fill: paint.color, "fill-opacity": paint.opacity === 1 ? undefined : paint.opacity };
  }
  if (box.width === 0 || box.height === 0) {
    // 大きさ 0 の外接矩形には写せない (変換行列が潰れる) ので、先頭の停止点の色で塗る
    const first = paint.stops[0];
    if (!first) return { fill: "none" };
    return { fill: first.color, "fill-opacity": first.opacity === 1 ? undefined : first.opacity };
  }
  const stops = paint.stops.map((stop) =>
    el("stop", {
      offset: stop.offset,
      "stop-color": stop.color,
      "stop-opacity": stop.opacity === 1 ? undefined : stop.opacity,
    }),
  );
  const common = {
    id,
    gradientUnits: "userSpaceOnUse",
    gradientTransform: `matrix(${box.width} 0 0 ${box.height} ${box.x} ${box.y})`,
  };
  defs.push(
    paint.type === "linear"
      ? el(
          "linearGradient",
          { ...common, x1: paint.from.x, y1: paint.from.y, x2: paint.to.x, y2: paint.to.y },
          stops,
        )
      : el(
          "radialGradient",
          { ...common, cx: paint.center.x, cy: paint.center.y, r: paint.radius },
          stops,
        ),
  );
  return { fill: `url(#${id})` };
}

function strokeAttrs(stroke: Stroke | null): Record<string, string | number | undefined> {
  if (stroke === null) return {};
  return {
    stroke: stroke.color,
    "stroke-opacity": stroke.opacity === 1 ? undefined : stroke.opacity,
    "stroke-width": stroke.width,
  };
}

/**
 * ドロップシャドウの `filter`。ぼかしは CSS の box-shadow と同じく標準偏差の 2 倍として扱う。
 * フィルターの範囲は既定 (外接矩形の ±10%) では足りないので、影の届く範囲を利用者空間で指定する。
 *
 * `shadowOnly` なら元の図形を出さず影だけを出す (`feDropShadow` と同じ影を基本の部品で組む)。
 * frame は影を子の背面に描くため、影だけの要素を子より先に置く。
 */
function shadowFilter(
  shadow: Shadow,
  box: Box,
  strokeWidth: number,
  id: string,
  shadowOnly = false,
): SvgEl {
  const pad = shadow.blur * 1.5 + strokeWidth / 2 + 1;
  const primitives = shadowOnly
    ? [
        el("feGaussianBlur", { in: "SourceAlpha", stdDeviation: shadow.blur / 2 }),
        el("feOffset", { dx: shadow.x, dy: shadow.y, result: "offset" }),
        el("feFlood", { "flood-color": shadow.color, "flood-opacity": shadow.opacity }),
        el("feComposite", { in2: "offset", operator: "in" }),
      ]
    : [
        el("feDropShadow", {
          dx: shadow.x,
          dy: shadow.y,
          stdDeviation: shadow.blur / 2,
          "flood-color": shadow.color,
          "flood-opacity": shadow.opacity,
        }),
      ];
  return el(
    "filter",
    {
      id,
      filterUnits: "userSpaceOnUse",
      x: box.x - pad + Math.min(0, shadow.x),
      y: box.y - pad + Math.min(0, shadow.y),
      width: box.width + pad * 2 + Math.abs(shadow.x),
      height: box.height + pad * 2 + Math.abs(shadow.y),
      "color-interpolation-filters": "sRGB",
    },
    primitives,
  );
}

/** 定義があれば `<defs>` を先頭に置き、不透明度があれば `<g>` で包む。どちらもなければ要素そのもの。 */
function wrap(node: CanvasNode, defs: SvgEl[], body: SvgEl[]): SvgEl {
  const opacity = node.opacity === 1 ? undefined : node.opacity;
  if (defs.length === 0 && body.length === 1 && body[0] && opacity === undefined) return body[0];
  const children = defs.length > 0 ? [el("defs", {}, defs), ...body] : body;
  return el("g", { opacity }, children);
}

function roundedClip(box: Box, radius: number, id: string): SvgEl {
  return el("clipPath", { id }, [
    el("rect", {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      rx: radius > 0 ? radius : undefined,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// テキストの字形の範囲
// ---------------------------------------------------------------------------

/**
 * 字形が行の箱からはみ出しうる量 (フォントサイズに対する倍率)。斜体の左右、
 * 行の高さがフォントサイズ以下のときのアセンダー・ディセンダーを含める。
 * 影のフィルタ領域 (ここ) と画面外の判定 (`canvas/culling.ts`) で同じ値を使う。
 */
export const TEXT_INK_OVERFLOW = 0.5;

/**
 * テキストの字形が描かれうる範囲 (親の座標系)。ノードの矩形と行分割の結果
 * (fixed ははみ出した行も描く) を合わせ、フォントサイズ × `TEXT_INK_OVERFLOW` だけ広げる。
 */
export function textInkExtent(node: TextNode, layout: TextLayout): Box {
  let left = 0;
  let right = node.width;
  for (const line of layout.lines) {
    left = Math.min(left, line.x);
    right = Math.max(right, line.x + line.width);
  }
  const bottom = Math.max(node.height, layout.height);
  const pad = node.fontSize * TEXT_INK_OVERFLOW;
  return {
    x: node.x + left - pad,
    y: node.y - pad,
    width: right - left + pad * 2,
    height: bottom + pad * 2,
  };
}

// ---------------------------------------------------------------------------
// ノード
// ---------------------------------------------------------------------------

function boxOf(node: { x: number; y: number; width: number; height: number }): Box {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/**
 * ノード 1 個を `SvgEl` にする。frame / group の子は `CHILDREN_SLOT` の要素で置き、
 * 呼び出し側が差し込む。`visible` が false なら null。座標は親の座標系。
 */
export function buildNodeShell(node: CanvasNode, ctx: ShellContext): SvgEl | null {
  if (!node.visible) return null;
  const defs: SvgEl[] = [];
  const id = (kind: DefKind) => defId(ctx.idPrefix, node.id, kind);

  switch (node.type) {
    case "group":
      return el("g", { opacity: node.opacity === 1 ? undefined : node.opacity }, [
        el(CHILDREN_SLOT),
      ]);

    case "frame": {
      const box = boxOf(node);
      const rx = node.radius > 0 ? node.radius : undefined;
      const body: SvgEl[] = [];
      // 影は frame 自身の矩形 (塗りと線) が落とし、子の形の影にはしない。必ず子の背面に描くため、
      // 影だけを出す要素を塗りより先に置く (§4.3)。塗りも線もなければ影もない
      const fill = node.fill === null ? null : paintAttrs(node.fill, box, id("fill"), defs);
      if (node.shadow !== null && (node.fill !== null || node.stroke !== null)) {
        defs.push(shadowFilter(node.shadow, box, node.stroke?.width ?? 0, id("shadow"), true));
        body.push(
          el("rect", {
            ...box,
            rx,
            ...(fill ?? { fill: "none" }),
            ...strokeAttrs(node.stroke),
            filter: `url(#${id("shadow")})`,
          }),
        );
      }
      if (fill !== null) body.push(el("rect", { ...box, rx, ...fill }));
      if (node.clip)
        defs.push(
          roundedClip(
            { x: 0, y: 0, width: box.width, height: box.height },
            node.radius,
            id("clip"),
          ),
        );
      body.push(
        el(
          "g",
          {
            transform: node.x === 0 && node.y === 0 ? undefined : `translate(${node.x} ${node.y})`,
            "clip-path": node.clip ? `url(#${id("clip")})` : undefined,
          },
          [el(CHILDREN_SLOT)],
        ),
      );
      // 線は子の上に描く (Figma と同じ)
      if (node.stroke !== null) {
        body.push(
          el("rect", {
            ...box,
            rx,
            fill: "none",
            ...strokeAttrs(node.stroke),
          }),
        );
      }
      return wrap(node, defs, body);
    }

    case "rect":
    case "ellipse": {
      const box = boxOf(node);
      const filter =
        node.shadow === null
          ? undefined
          : (defs.push(shadowFilter(node.shadow, box, node.stroke?.width ?? 0, id("shadow"))),
            `url(#${id("shadow")})`);
      const paint = {
        ...paintAttrs(node.fill, box, id("fill"), defs),
        ...strokeAttrs(node.stroke),
        filter,
      };
      const shape =
        node.type === "rect"
          ? el("rect", { ...box, rx: node.radius > 0 ? node.radius : undefined, ...paint })
          : el("ellipse", {
              cx: node.x + node.width / 2,
              cy: node.y + node.height / 2,
              rx: node.width / 2,
              ry: node.height / 2,
              ...paint,
            });
      return wrap(node, defs, [shape]);
    }

    case "line":
      return wrap(node, defs, [
        el("line", {
          x1: node.x1,
          y1: node.y1,
          x2: node.x2,
          y2: node.y2,
          ...strokeAttrs(node.stroke),
        }),
      ]);

    case "text": {
      const layout = layoutText(node, ctx.measurer);
      const box = boxOf(node);
      const extent = textInkExtent(node, layout);
      const filter =
        node.shadow === null
          ? undefined
          : (defs.push(shadowFilter(node.shadow, extent, 0, id("shadow"))),
            `url(#${id("shadow")})`);
      const tspans = layout.lines.map((line) =>
        el(
          "tspan",
          { x: node.x + line.x, y: node.y + line.y },
          line.text === "" ? [] : [line.text],
        ),
      );
      const text = el(
        "text",
        {
          "font-family": cssFontFamily(node.fontFamily),
          "font-size": node.fontSize,
          "font-weight": node.fontWeight,
          "font-style": node.italic ? "italic" : undefined,
          "letter-spacing": node.letterSpacing === 0 ? undefined : node.letterSpacing,
          ...paintAttrs(node.fill, box, id("fill"), defs),
          filter,
          "xml:space": "preserve",
          // 字の送りを表示の倍率 (Retina、キャンバスのズーム、UI スケール) に関係なく、指定のフォントサイズで
          // 組ませる。付けないと、大きさで送りの比が変わるフォント (Apple Color Emoji、SF) の幅が計測と合わない
          "text-rendering": "geometricPrecision",
        },
        tspans,
      );
      return wrap(node, defs, [text]);
    }

    case "image":
    case "svg": {
      const box = boxOf(node);
      if (!ctx.asset) return wrap(node, defs, [el("g")]);
      const radius = node.type === "image" ? node.radius : 0;
      if (radius > 0) defs.push(roundedClip(box, radius, id("clip")));
      const image = el("image", {
        ...box,
        href: assetDataUrl(ctx.asset),
        preserveAspectRatio: "none",
        "clip-path": radius > 0 ? `url(#${id("clip")})` : undefined,
      });
      if (node.type === "image" && node.shadow !== null) {
        // 切り抜きの後に影を落とすため、影は外側の <g> に付ける
        defs.push(shadowFilter(node.shadow, box, 0, id("shadow")));
        return wrap(node, defs, [el("g", { filter: `url(#${id("shadow")})` }, [image])]);
      }
      return wrap(node, defs, [image]);
    }
  }
}

/** image / svg ノードが指すアセット。 */
export function assetOf(doc: CanvasDocument, node: CanvasNode): Asset | undefined {
  if (node.type !== "image" && node.type !== "svg") return undefined;
  return hasOwn(doc.assets, node.assetId) ? doc.assets[node.assetId] : undefined;
}

/** ノード 1 個 (子を含む) を `SvgEl` にする。契約は `render/types.ts`。 */
export const buildNodeSvg: BuildNodeSvg = (doc, nodeId, options) =>
  buildRecursive(doc, nodeId, options, new Set());

function buildRecursive(
  doc: CanvasDocument,
  nodeId: NodeId,
  options: RenderOptions,
  ancestors: Set<NodeId>,
): SvgEl | null {
  if (ancestors.has(nodeId)) return null; // 壊れた文書の循環でも止まるように
  const node = getNode(doc, nodeId);
  if (!node) return null;
  const shell = buildNodeShell(node, {
    measurer: options.measurer,
    idPrefix: options.idPrefix,
    asset: assetOf(doc, node),
  });
  if (!shell || !isContainer(node)) return shell;
  ancestors.add(nodeId);
  const children: SvgEl[] = [];
  for (const child of node.children) {
    const built = buildRecursive(doc, child, options, ancestors);
    if (built) children.push(built);
  }
  ancestors.delete(nodeId);
  return fillSlot(shell, children);
}
