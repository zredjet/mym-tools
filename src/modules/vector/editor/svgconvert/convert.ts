/**
 * 埋め込み SVG の SVG 文書を、編集できるノードの断片にする (`docs/canvas-editor-design.md` §4.17)。純関数
 * (計測の `measurer` を除く)。SVG は信頼しない入力として扱う: `DOMParser` で読むだけで文書には挿入しない、
 * `href` は文書の中の `#id` だけを引く (外部の参照は読まない)、`use` の循環・深さ、要素の入れ子の深さ
 * (`MAX_NESTING`)、仕事の量 (`MAX_WORK`: 要素の展開、テキストの中の要素と文字、パスの点、長い属性) に上限を
 * 設ける。要素ごとに読んだもの (transform、形、グラデーション、テキストのチャンク、title) は使い回し、展開の
 * たびに読み直さない。塗りも線もない形は形を読まない。長すぎる値と読めない値は宣言がないものとして扱う。
 *
 * `convertSvg(svg, options)`:
 * - 結果の座標は「埋め込み SVG のノードの座標系」(箱の左上が原点、回転の前)。見た目の基準は今の描画
 *   (`<image preserveAspectRatio="none">` で箱に引き伸ばしたもの): ルートの `viewBox` を箱へ縦横別々に
 *   引き伸ばす。`viewBox` がなければ、ルートの `width` / `height` (なければアセットの大きさ) を座標系にする
 * - 断片の根は group 1 個 (子が 1 個でも)。名前・表示・ロック・不透明度は置く側 (`place.ts`) が決める
 * - 対応 (§4.17): `g` と `a` は group (子が 1 個なら作らない)、`path` `polyline` `polygon` はパス、`rect` は
 *   矩形 (角丸の縦横が違えばパス)、`circle` `ellipse` は楕円、`line` は線、`text` `tspan` はテキスト
 *   (位置を指定した `tspan` ごとに 1 行、`auto-width`)、`use` と `symbol` は展開、入れ子の `svg` は viewBox の
 *   変換を掛けて中身を展開する (切り抜きは落とす)
 * - 変換: パスと線は点に掛ける (厳密)。矩形・楕円は平行移動・回転・縦横の拡大 (反転を含む) だけなら箱と
 *   `rotation` に、傾斜があれば (回転と縦横の違う拡大の組み合わせを含む) パスにする。テキストは位置・回転・
 *   フォントサイズを近似する
 * - 線の太さと破線の長さには、変換の拡大率 (行列式の絶対値の平方根) を掛ける
 * - 塗りも線もない形は作らない。`display: none` と `visibility: hidden` の要素は黙って飛ばす
 *
 * 返すもの: `{ ok: true, fragment, dropped }` か、変換しない理由 (`invalid`: SVG ポリシーを通らない・読めない、
 * `empty`: 変換できる形が 1 つもない、`tooLarge`: 要素の展開かノードの数が上限を超える)。
 */
import {
  applyToPoint,
  decompose,
  determinant,
  IDENTITY,
  invert,
  type Matrix,
  multiply,
  nodeMatrix,
  scale,
  translate,
} from "../geometry/matrix";
import type { Fragment } from "../model/fragment";
import { getLocalBounds, type Rect } from "../model/geometry";
import { CANVAS_LIMITS } from "../model/limits";
import {
  createEllipse,
  createGroup,
  createLine,
  createPath,
  createRect,
  createText,
} from "../model/create";
import { cleanRotation } from "../model/transform";
import type {
  CanvasDocument,
  CanvasNode,
  NodeId,
  Paint,
  PathNode,
  Stroke,
  StrokeCap,
  StrokeJoin,
  Subpath,
  TextAlign,
  TextNode,
} from "../model/types";
import { pathBoundsRect } from "../path/measure";
import { parsePathData } from "../path/pathData";
import { ellipseSubpaths, rectSubpaths } from "../path/shapes";
import { transformSubpaths, translateSubpaths } from "../path/transform";
import policy from "../../policy/policy.json";
import { validateSvg } from "../../policy/svg-policy.js";
import type { TextMeasurer } from "../render/types";
import { fitTextNodes } from "../text/fit";
import { baselineOffset } from "../text/layout";
import { DroppedCollector, type DroppedItem } from "./dropped";
import {
  gradientAverageStop,
  gradientToPaint,
  readGradient,
  type BoxSpace,
  type GradientSource,
} from "./gradient";
import {
  childElements,
  computeStyle,
  descendantElements,
  hrefTarget,
  INITIAL_STYLE,
  nonInheritedValue,
  parseUrlReference,
  SVG_NS,
  type ComputedStyle,
} from "./style";
import { readTextChunks, type TextChunk } from "./text";
import {
  cleanNumber,
  parseColor,
  parseLength,
  parseNumberList,
  parseOpacity,
  parseTransformList,
  parseViewBox,
  viewBoxTransform,
  type LengthContext,
} from "./values";

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

/**
 * 変換の仕事の量の上限 (単位は下の `WORK_*`)。要素をたどる回数 (`use` の展開を含む) と、展開のたびに行う
 * 読み取り (テキストの `tspan` と文字、パスの点、長い属性の字句) を合わせて数え、超えたら `tooLarge` で断る。
 * 巨大な展開や、展開のたびに重い要素を読み直す入力で止まらないように。
 */
export const MAX_WORK = 300_000;
/** 要素 1 個をたどる (変換の対象の要素) */
const WORK_ELEMENT = 1;
/** テキストの中の要素 1 個 (`tspan` など。書式を求める) */
const WORK_TEXT_ELEMENT = 8;
/** 属性やテキストの文字をこの数だけ読むごとに 1 */
const WORK_CHARS = 256;
/** 作るパスの点をこの数だけ写すごとに 1 */
const WORK_POINTS = 16;
/** `use` の入れ子の深さの上限。 */
export const MAX_USE_DEPTH = 32;
/** 要素の入れ子の深さの上限 (`use` の展開を含む)。深すぎる入れ子で再帰が尽きないように。 */
export const MAX_NESTING = 256;

class TooLarge extends Error {}

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export interface SvgConvertOptions {
  /** 埋め込み SVG のノードの箱の大きさ (回転の前) */
  width: number;
  height: number;
  /** アセットの大きさ (`viewBox` もルートの `width` / `height` もないときの座標系) */
  assetWidth: number;
  assetHeight: number;
  measurer: TextMeasurer;
}

export type SvgConvertFailure = "invalid" | "empty" | "tooLarge";

export type SvgConvertResult =
  | { ok: true; fragment: Fragment; dropped: DroppedItem[] }
  | { ok: false; reason: SvgConvertFailure; detail: string | null };

interface Context {
  /** 利用者の座標 → 結果の座標 (埋め込み SVG のノードの座標系) */
  m: Matrix;
  /** 親の書式 (継承する属性) */
  style: ComputedStyle;
  /** % の基準になる viewport */
  viewport: { width: number; height: number };
  /** 要素の入れ子の深さ (ルートの子が 1) */
  depth: number;
}

type PaintSpec =
  | { kind: "none" }
  | { kind: "color"; color: string; alpha: number }
  | { kind: "gradient"; element: Element };

// ---------------------------------------------------------------------------
// 変換
// ---------------------------------------------------------------------------

class Converter {
  readonly nodes: Record<NodeId, CanvasNode> = {};
  readonly dropped = new DroppedCollector();
  private readonly ids = new Map<string, Element>();
  private readonly useStack: Element[] = [];
  private work = 0;
  private nodeCount = 0;
  private pathPoints = 0;
  private counter = 0;
  /** 要素ごとに 1 回だけ読むもの (`use` の展開のたびに読み直さない) */
  private readonly transforms = new WeakMap<Element, Matrix>();
  private readonly titles = new WeakMap<Element, string | null>();
  private readonly geometries = new WeakMap<Element, Map<string, Geometry | null>>();
  private readonly gradients = new WeakMap<Element, Map<string, GradientSource | null>>();
  private readonly textChunks = new WeakMap<
    Element,
    Map<ComputedStyle, Map<string, { chunks: TextChunk[]; dropped: DroppedItem[] }>>
  >();
  /** `<title>` から名前を付けたノード (畳んだ group の名前を上書きしない) */
  private readonly titled = new Set<NodeId>();

  constructor(
    root: Element,
    private readonly measurer: TextMeasurer,
  ) {
    for (const element of descendantElements(root)) {
      const id = element.getAttribute("id");
      if (id !== null && !this.ids.has(id)) this.ids.set(id, element);
    }
  }

  private lookup = (id: string): Element | undefined => this.ids.get(id);

  /** 仕事の量を数え、上限を超えたら止める。 */
  private charge(units: number): void {
    this.work += units;
    if (this.work > MAX_WORK) throw new TooLarge();
  }

  private chargeChars(length: number): void {
    this.charge(1 + Math.floor(length / WORK_CHARS));
  }

  private nextId(): NodeId {
    this.counter += 1;
    return `svgc${this.counter}`;
  }

  private add<T extends CanvasNode>(node: T): T {
    this.nodeCount += 1;
    if (this.nodeCount > CANVAS_LIMITS.maxNodes) throw new TooLarge();
    if (node.type === "path") {
      // 文書の全パスの点の上限を超えるなら、置けないので早めに止める
      for (const sub of node.subpaths) this.pathPoints += sub.points.length;
      if (this.pathPoints > CANVAS_LIMITS.maxTotalPathPoints) throw new TooLarge();
    }
    this.nodes[node.id] = node;
    return node;
  }

  /** 作ったノードを、外接矩形を求めるための文書にする (ページは使わない)。 */
  private workingDocument(): CanvasDocument {
    return { pages: [], nodes: this.nodes, assets: {} };
  }

  private lengthContext(context: Context, style: ComputedStyle): LengthContext {
    return { viewport: context.viewport, fontSize: style.fontSize };
  }

  /** 要素の `<title>` (レイヤーの名前)。要素ごとに 1 回だけ読む。 */
  private titleOf(element: Element): string | null {
    const cached = this.titles.get(element);
    if (cached !== undefined) return cached;
    let title: string | null = null;
    for (const child of childElements(element)) {
      this.charge(WORK_ELEMENT);
      if (child.namespaceURI === SVG_NS && child.localName === "title") {
        const raw = child.textContent ?? "";
        this.chargeChars(raw.length);
        const text = raw.replace(/\s+/g, " ").trim();
        if (text !== "") {
          title = [...text].slice(0, CANVAS_LIMITS.maxNameLength).join("");
          break;
        }
      }
    }
    this.titles.set(element, title);
    return title;
  }

  /** `clip-path` `mask` `filter` を落とす (結果が空でないときに数える)。 */
  private countEffects(element: Element): void {
    const used = (name: string) => {
      const v = nonInheritedValue(element, name);
      return v !== null && v.toLowerCase() !== "none" && v !== "";
    };
    if (used("clip-path")) this.dropped.add("clipPath");
    if (used("mask")) this.dropped.add("mask");
    if (used("filter")) this.dropped.add("filter");
  }

  private opacityOf(element: Element): number {
    return parseOpacity(nonInheritedValue(element, "opacity")) ?? 1;
  }

  /** `transform` 属性 (要素ごとに 1 回だけ読む)。 */
  private transformOf(element: Element): Matrix {
    const cached = this.transforms.get(element);
    if (cached) return cached;
    const raw = element.getAttribute("transform");
    if (raw !== null) this.chargeChars(raw.length);
    const m = parseTransformList(raw) ?? IDENTITY;
    this.transforms.set(element, m);
    return m;
  }

  /** 形 (要素と長さの基準ごとに 1 回だけ読む)。 */
  private geometryOf(element: Element, lc: LengthContext): Geometry | null {
    const key = `${lc.viewport.width},${lc.viewport.height},${lc.fontSize}`;
    let byKey = this.geometries.get(element);
    if (!byKey) {
      byKey = new Map();
      this.geometries.set(element, byKey);
    }
    if (byKey.has(key)) return byKey.get(key) ?? null;
    const source = element.getAttribute("d") ?? element.getAttribute("points") ?? "";
    this.chargeChars(source.length);
    const geometry = readGeometry(element, lc);
    byKey.set(key, geometry);
    return geometry;
  }

  /** グラデーション (要素と長さの基準ごとに 1 回だけ読む)。 */
  private gradientOf(element: Element, lc: LengthContext): GradientSource | null {
    const key = `${lc.viewport.width},${lc.viewport.height},${lc.fontSize}`;
    let byKey = this.gradients.get(element);
    if (!byKey) {
      byKey = new Map();
      this.gradients.set(element, byKey);
    }
    if (byKey.has(key)) return byKey.get(key) ?? null;
    const source = readGradient(element, this.lookup, lc);
    this.charge(WORK_ELEMENT + (source?.stops.length ?? 0));
    byKey.set(key, source);
    return source;
  }

  /**
   * 子の結果を 1 つにまとめる。0 個なら空、1 個なら group を作らず不透明度を掛ける、2 個以上なら group。
   */
  private wrap(ids: NodeId[], element: Element, opacity: number, name: string | null): NodeId[] {
    if (ids.length === 0) return [];
    this.countEffects(element);
    if (ids.length === 1) {
      const id = ids[0] as NodeId;
      let node = this.nodes[id] as CanvasNode;
      if (opacity !== 1) node = { ...node, opacity: node.opacity * opacity };
      // 畳んだ要素の名前は、子に自分の名前 (`<title>`) がなければ子に渡す
      if (name !== null && !this.titled.has(id)) {
        node = { ...node, name };
        this.titled.add(id);
      }
      this.nodes[id] = node;
      return ids;
    }
    const group = createGroup(ids, {
      id: this.nextId(),
      opacity,
      ...(name === null ? {} : { name }),
    });
    if (name !== null) this.titled.add(group.id);
    return [this.add(group).id];
  }

  /** 要素を変換し、作ったノード (この要素の階層の根) の ID を返す。 */
  visit(element: Element, context: Context): NodeId[] {
    this.charge(WORK_ELEMENT);
    if (context.depth > MAX_NESTING) throw new TooLarge();
    if (element.namespaceURI !== SVG_NS) return [];
    if (nonInheritedValue(element, "display")?.toLowerCase() === "none") return [];
    const style = computeStyle(element, context.style, this.lengthContext(context, context.style));
    switch (element.localName) {
      case "g":
      case "a":
        return this.visitGroup(element, context, style);
      case "svg":
        return this.visitNestedSvg(element, context, style, null);
      case "use":
        return this.visitUse(element, context, style);
      case "path":
      case "rect":
      case "circle":
      case "ellipse":
      case "line":
      case "polyline":
      case "polygon":
        return this.visitShape(element, context, style);
      case "text":
        return this.visitText(element, context, style);
      case "image":
        if (!isHidden(style)) this.dropped.add("image");
        return [];
      default:
        // defs、symbol (use から展開する)、title、desc、グラデーション、clipPath、mask、marker、pattern、filter
        return [];
    }
  }

  private visitChildren(element: Element, context: Context): NodeId[] {
    const ids: NodeId[] = [];
    const inner = { ...context, depth: context.depth + 1 };
    for (const child of childElements(element)) ids.push(...this.visit(child, inner));
    return ids;
  }

  private visitGroup(element: Element, context: Context, style: ComputedStyle): NodeId[] {
    const m = multiply(context.m, this.transformOf(element));
    const ids = this.visitChildren(element, { ...context, m, style });
    return this.wrap(ids, element, this.opacityOf(element), this.titleOf(element));
  }

  /**
   * 入れ子の `svg` (と `use` が指す `svg` / `symbol`)。`size` は `use` の `width` / `height` (省略は null)。
   * 切り抜き (`overflow` が visible でないもの) は落とす。
   */
  private visitNestedSvg(
    element: Element,
    context: Context,
    style: ComputedStyle,
    size: { width: number | null; height: number | null } | null,
  ): NodeId[] {
    const lc = this.lengthContext(context, style);
    const isSymbol = element.localName === "symbol";
    const x = isSymbol ? 0 : (parseLength(element.getAttribute("x"), lc, "x") ?? 0);
    const y = isSymbol ? 0 : (parseLength(element.getAttribute("y"), lc, "y") ?? 0);
    const width =
      size?.width ?? parseLength(element.getAttribute("width"), lc, "x") ?? context.viewport.width;
    const height =
      size?.height ??
      parseLength(element.getAttribute("height"), lc, "y") ??
      context.viewport.height;
    if (!(width > 0) || !(height > 0)) return [];
    const viewBox = parseViewBox(element.getAttribute("viewBox"));
    const inner = viewBox
      ? viewBoxTransform(viewBox, width, height, element.getAttribute("preserveAspectRatio"))
      : IDENTITY;
    const m = multiply(
      multiply(context.m, isSymbol ? IDENTITY : this.transformOf(element)),
      multiply(translate(x, y), inner),
    );
    const viewport = viewBox ? { width: viewBox.width, height: viewBox.height } : { width, height };
    const ids = this.visitChildren(element, { m, style, viewport, depth: context.depth });
    const overflow = nonInheritedValue(element, "overflow")?.toLowerCase();
    // 切り抜きは、中身が viewport (x, y, width, height) からはみ出すときだけ落とすものに数える
    if (ids.length > 0 && overflow !== "visible" && overflow !== "auto") {
      const viewportSpace = multiply(
        multiply(context.m, isSymbol ? IDENTITY : this.transformOf(element)),
        translate(x, y),
      );
      const toViewport = invert(viewportSpace);
      const doc = this.workingDocument();
      if (
        !toViewport ||
        ids.some((id) =>
          leafExtents(doc, id, this.measurer).some(
            (rect) => !rectInside(mappedRect(toViewport, rect), width, height),
          ),
        )
      )
        this.dropped.add("nestedClip");
    }
    return this.wrap(ids, element, this.opacityOf(element), this.titleOf(element));
  }

  private visitUse(element: Element, context: Context, style: ComputedStyle): NodeId[] {
    const id = hrefTarget(element);
    if (id !== null) this.chargeChars(id.length);
    const target = id === null ? undefined : this.lookup(id);
    if (!target || target.namespaceURI !== SVG_NS) return [];
    if (
      target === element ||
      target.contains(element) ||
      this.useStack.includes(target) ||
      this.useStack.length >= MAX_USE_DEPTH
    ) {
      this.dropped.add("useCycle");
      return [];
    }
    const lc = this.lengthContext(context, style);
    const x = parseLength(element.getAttribute("x"), lc, "x") ?? 0;
    const y = parseLength(element.getAttribute("y"), lc, "y") ?? 0;
    const m = multiply(multiply(context.m, this.transformOf(element)), translate(x, y));
    const inner: Context = { ...context, m, style, depth: context.depth + 1 };
    this.useStack.push(target);
    let ids: NodeId[];
    try {
      if (target.localName === "symbol" || target.localName === "svg") {
        if (nonInheritedValue(target, "display")?.toLowerCase() === "none") ids = [];
        else {
          const width = parseLength(element.getAttribute("width"), lc, "x");
          const height = parseLength(element.getAttribute("height"), lc, "y");
          const targetStyle = computeStyle(target, style, lc);
          ids = this.visitNestedSvg(target, inner, targetStyle, {
            width: width ?? parseLength(target.getAttribute("width"), lc, "x"),
            height: height ?? parseLength(target.getAttribute("height"), lc, "y"),
          });
        }
      } else ids = this.visit(target, inner);
    } finally {
      this.useStack.pop();
    }
    return this.wrap(ids, element, this.opacityOf(element), this.titleOf(element));
  }

  // ---- 塗りと線 ----

  private paintSpec(
    value: string | undefined,
    style: ComputedStyle,
    which: "fill" | "stroke",
  ): PaintSpec {
    const raw = (value ?? "none").trim();
    this.chargeChars(raw.length);
    const lower = raw.toLowerCase();
    if (lower === "none" || lower === "") return { kind: "none" };
    if (lower === "currentcolor") return this.colorSpec(style.values["color"] ?? "black", which);
    const reference = parseUrlReference(raw);
    if (reference) {
      const target = this.lookup(reference.id);
      if (
        target?.namespaceURI === SVG_NS &&
        (target.localName === "linearGradient" || target.localName === "radialGradient")
      )
        return { kind: "gradient", element: target };
      if (target?.namespaceURI === SVG_NS && target.localName === "pattern")
        this.dropped.add("pattern");
      // 代わりの値は none か色だけ (再帰しない。書式の検証で、それ以外の値は宣言ごと読まない)
      const fallback = reference.fallback?.trim().toLowerCase() ?? "none";
      if (fallback === "none") return { kind: "none" };
      if (fallback === "currentcolor")
        return this.colorSpec(style.values["color"] ?? "black", which);
      return parseColor(fallback) ? this.colorSpec(fallback, which) : { kind: "none" };
    }
    return this.colorSpec(raw, which);
  }

  private colorSpec(value: string, which: "fill" | "stroke"): PaintSpec {
    const v = value.trim().toLowerCase() === "currentcolor" ? "black" : value;
    const color = parseColor(v);
    // 読めない色は無いものとして初期値にする (塗りは黒、線はなし)
    if (!color)
      return which === "fill" ? { kind: "color", color: "#000000", alpha: 1 } : { kind: "none" };
    return { kind: "color", color: color.color, alpha: color.alpha };
  }

  /** 塗りの §3 の値。グラデーションはノードの箱 (`space`) に写す。 */
  private paint(
    spec: PaintSpec,
    opacity: number,
    space: BoxSpace,
    context: Context,
    style: ComputedStyle,
  ): Paint | null {
    if (spec.kind === "none") return null;
    if (spec.kind === "color")
      return { type: "solid", color: spec.color, opacity: spec.alpha * opacity };
    const source = this.gradientOf(spec.element, this.lengthContext(context, style));
    if (!source) return null;
    return gradientToPaint(source, opacity, space, this.dropped);
  }

  /** 線。太さが 0 以下か塗りがなければ null。`factor` は変換の拡大率。 */
  private stroke(
    element: Element,
    style: ComputedStyle,
    context: Context,
    m: Matrix,
    hasFill: boolean,
  ): Stroke | null {
    const v = style.values;
    const spec = this.paintSpec(v["stroke"], style, "stroke");
    if (spec.kind === "none") return null;
    const lc = this.lengthContext(context, style);
    const width = parseLength(v["stroke-width"], lc, "other") ?? 1;
    if (!(width > 0)) return null;
    const opacity = parseOpacity(v["stroke-opacity"]) ?? 1;
    let color: string;
    let alpha: number;
    if (spec.kind === "color") {
      color = spec.color;
      alpha = spec.alpha;
    } else {
      const source = this.gradientOf(spec.element, lc);
      const stop = source ? gradientAverageStop(source) : null;
      if (!stop) return null;
      this.dropped.add("strokeGradient");
      color = stop.color;
      alpha = stop.opacity;
    }
    const factor = Math.sqrt(Math.abs(determinant(m)));
    const scaled = width * factor;
    if (!(scaled > 0) || !Number.isFinite(scaled)) return null;
    // 縦横で違う拡大 (特異値の比) は線の太さを近似する
    const d = decompose(m);
    if (d && (d.hasSkew || Math.abs(Math.abs(d.scaleY) / d.scaleX - 1) > 1e-3))
      this.dropped.add("nonUniformStroke");
    const limited = this.limit(scaled, CANVAS_LIMITS.maxStrokeWidth);
    const cap = v["stroke-linecap"]?.toLowerCase();
    const join = v["stroke-linejoin"]?.toLowerCase();
    const strokeCap: StrokeCap = cap === "round" || cap === "square" ? cap : "butt";
    const strokeJoin: StrokeJoin = join === "round" || join === "bevel" ? join : "miter";
    const dashOffset = parseLength(v["stroke-dashoffset"], lc, "other");
    const dash = this.dashArray(v["stroke-dasharray"], lc, factor);
    if (dash.length > 0 && dashOffset !== null && dashOffset !== 0) this.dropped.add("dashOffset");
    const miter = Number(v["stroke-miterlimit"] ?? "4");
    if (strokeJoin === "miter" && miter !== 4) this.dropped.add("miterLimit");
    const effect = nonInheritedValue(element, "vector-effect")?.toLowerCase();
    if (effect && effect !== "none") this.dropped.add("vectorEffect");
    const order = v["paint-order"]?.toLowerCase().trim();
    if (hasFill && order && order !== "normal" && order.startsWith("stroke"))
      this.dropped.add("paintOrder");
    return {
      color,
      opacity: Math.min(1, Math.max(0, alpha * opacity)),
      width: limited,
      cap: strokeCap,
      join: strokeJoin,
      dash,
    };
  }

  private dashArray(value: string | undefined, lc: LengthContext, factor: number): number[] {
    if (!value || value.trim().toLowerCase() === "none") return [];
    this.chargeChars(value.length);
    const parts = value.trim().split(/[\s,]+/);
    const lengths: number[] = [];
    for (const part of parts) {
      const length = parseLength(part, lc, "other");
      // 負の値・読めない値は破線全体を無効にする (SVG の規則。実線で描く)
      if (length === null || length < 0) return [];
      lengths.push(length * factor);
    }
    const sum = lengths.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return [];
    if (lengths.length > CANVAS_LIMITS.maxDashCount) {
      this.dropped.add("valueLimit");
      return [];
    }
    return lengths.map((length) => this.limit(length, CANVAS_LIMITS.maxDashLength));
  }

  private limit(value: number, max: number): number {
    if (value <= max) return value;
    this.dropped.add("valueLimit");
    return max;
  }

  private countMarkers(element: Element, style: ComputedStyle): void {
    if (!["path", "line", "polyline", "polygon"].includes(element.localName)) return;
    for (const name of ["marker-start", "marker-mid", "marker-end"]) {
      const v = style.values[name]?.toLowerCase();
      if (v && v !== "none") {
        this.dropped.add("marker");
        return;
      }
    }
  }

  // ---- 形 ----

  private visitShape(element: Element, context: Context, style: ComputedStyle): NodeId[] {
    if (isHidden(style)) return [];
    const v = style.values;
    // 塗りも線もない形は、形を読まずに飛ばす (読むだけ読んでノードを作らない仕事をしない)
    const fillValue = element.localName === "line" ? "none" : (v["fill"] ?? "none");
    const strokeValue = v["stroke"] ?? "none";
    if (fillValue.trim().toLowerCase() === "none" && strokeValue.trim().toLowerCase() === "none")
      return [];
    const geometry = this.geometryOf(element, this.lengthContext(context, style));
    if (!geometry) return [];
    const m = multiply(context.m, this.transformOf(element));
    const fillSpec =
      element.localName === "line"
        ? ({ kind: "none" } as const)
        : this.paintSpec(v["fill"], style, "fill");
    const stroke = this.stroke(element, style, context, m, fillSpec.kind !== "none");
    if (fillSpec.kind === "none" && stroke === null) return [];
    const fillOpacity = parseOpacity(v["fill-opacity"]) ?? 1;
    const title = this.titleOf(element);
    const common = {
      id: this.nextId(),
      opacity: this.opacityOf(element),
      ...(title === null ? {} : { name: title }),
    };
    let node: CanvasNode;

    if (geometry.kind === "line") {
      if (stroke === null) return [];
      const a = applyToPoint(m, geometry.from);
      const b = applyToPoint(m, geometry.to);
      node = createLine({
        ...common,
        x1: cleanNumber(a.x),
        y1: cleanNumber(a.y),
        x2: cleanNumber(b.x),
        y2: cleanNumber(b.y),
        stroke,
      });
    } else {
      const box = geometry.kind === "box" ? boxNodeGeometry(geometry, m, stroke) : null;
      if (box && geometry.kind === "box") {
        const space: BoxSpace = {
          userToBox: userToBoxMatrix(box, m),
          bbox: { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height },
        };
        const fill = this.paint(fillSpec, fillOpacity, space, context, style);
        if (fill === null && stroke === null) return [];
        const init = {
          ...common,
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          rotation: box.rotation,
          fill,
          stroke,
        };
        node =
          geometry.shape === "rect"
            ? createRect({ ...init, radius: box.radius })
            : createEllipse(init);
      } else {
        const local = geometry.kind === "box" ? boxSubpaths(geometry) : geometry.subpaths;
        if (local.length === 0) return [];
        let count = 0;
        for (const sub of local) count += sub.points.length;
        this.charge(1 + Math.floor(count / WORK_POINTS));
        const subpaths = transformSubpaths(local, m);
        const path: PathNode = createPath(subpaths, {
          ...common,
          fillRule: v["fill-rule"]?.toLowerCase() === "evenodd" ? "evenodd" : "nonzero",
          fill: null,
          stroke,
        });
        if (path.width === 0 && path.height === 0) return [];
        const bbox = pathBoundsRect(local);
        const space: BoxSpace = {
          userToBox: userToBoxMatrix({ ...path, radius: 0 }, m),
          bbox,
        };
        const fill = this.paint(fillSpec, fillOpacity, space, context, style);
        if (fill === null && stroke === null) return [];
        node = { ...path, fill };
      }
    }
    this.countMarkers(element, style);
    this.countEffects(element);
    if (title !== null) this.titled.add(node.id);
    return [this.add(node).id];
  }

  // ---- テキスト ----

  private visitText(element: Element, context: Context, style: ComputedStyle): NodeId[] {
    const m = multiply(context.m, this.transformOf(element));
    const lc = this.lengthContext(context, style);
    const chunks = this.textChunksOf(element, context, style, lc);
    const ids: NodeId[] = [];
    const factor = Math.sqrt(Math.abs(determinant(m)));
    const rotation = textRotation(m);
    for (const chunk of chunks) {
      const font = fontOf(chunk.style, factor);
      if (chunk.mixedStyle) this.dropped.add("textStyle");
      const v = chunk.style.values;
      const fillSpec = this.paintSpec(v["fill"], chunk.style, "fill");
      const strokeSpec = this.paintSpec(v["stroke"], chunk.style, "stroke");
      const strokeWidth = parseLength(v["stroke-width"], lc, "other") ?? 1;
      const hasStroke = strokeSpec.kind !== "none" && strokeWidth > 0;
      if (hasStroke) this.dropped.add("textStroke");
      // 線だけのテキストは、線の色で塗る (テキストは線を持たない)
      const spec = fillSpec.kind === "none" && hasStroke ? strokeSpec : fillSpec;
      if (spec.kind === "none") continue;
      const opacity =
        parseOpacity(fillSpec.kind === "none" ? v["stroke-opacity"] : v["fill-opacity"]) ?? 1;
      const fontSize = this.clampRange(
        font.size,
        CANVAS_LIMITS.minFontSize,
        CANVAS_LIMITS.maxFontSize,
      );
      const letterSpacing = this.clampRange(
        font.letterSpacing,
        -CANVAS_LIMITS.maxLetterSpacing,
        CANVAS_LIMITS.maxLetterSpacing,
      );
      let text = chunk.text;
      if ([...text].length > CANVAS_LIMITS.maxTextLength) {
        this.dropped.add("valueLimit");
        text = [...text].slice(0, CANVAS_LIMITS.maxTextLength).join("");
      }
      const anchor = v["text-anchor"]?.toLowerCase();
      const align: TextAlign = anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
      const p = applyToPoint(m, { x: chunk.x, y: chunk.y });
      let node: TextNode = createText({
        id: this.nextId(),
        text,
        fontFamily: font.family,
        fontSize,
        fontWeight: font.weight,
        italic: font.italic,
        letterSpacing,
        align,
        sizing: "auto-width",
        rotation,
        opacity: 1,
        fill: null,
      });
      // ベースラインを合わせる: 箱の上の辺 (揃えの基準の点) を、行の基準点からベースラインまで上へずらす
      const baseline = baselineOffset(node, this.measurer);
      const rad = (rotation * Math.PI) / 180;
      node = { ...node, x: p.x + baseline * Math.sin(rad), y: p.y - baseline * Math.cos(rad) };
      node = fitSingleText(node, this.measurer);
      const box = { ...node, radius: 0 };
      const space: BoxSpace = {
        userToBox: userToBoxMatrix(box, m),
        bbox: approximateTextBox(node, m),
      };
      const fill = this.paint(spec, opacity, space, context, chunk.style);
      if (fill === null) continue;
      this.dropped.add("textPosition");
      ids.push(this.add({ ...node, fill }).id);
    }
    return this.wrap(ids, element, this.opacityOf(element), this.titleOf(element));
  }

  /**
   * テキストのチャンク (要素と、継承した書式と長さの基準ごとに 1 回だけ読む)。読むときは、中の要素と文字の数を
   * 仕事の量に数える。
   */
  private textChunksOf(
    element: Element,
    context: Context,
    style: ComputedStyle,
    lc: LengthContext,
  ): TextChunk[] {
    const key = `${lc.viewport.width},${lc.viewport.height}`;
    let byStyle = this.textChunks.get(element);
    if (!byStyle) {
      byStyle = new Map();
      this.textChunks.set(element, byStyle);
    }
    let byKey = byStyle.get(context.style);
    if (!byKey) {
      byKey = new Map();
      byStyle.set(context.style, byKey);
    }
    let entry = byKey.get(key);
    if (!entry) {
      entry = this.readChunks(element, style, lc);
      byKey.set(key, entry);
    }
    // 読んだときの落とすもの (textPath) は、使うたびに数える
    for (const item of entry.dropped) this.dropped.add(item.kind, item.count);
    return entry.chunks;
  }

  private readChunks(
    element: Element,
    style: ComputedStyle,
    lc: LengthContext,
  ): { chunks: TextChunk[]; dropped: DroppedItem[] } {
    const dropped = new DroppedCollector();
    const chunks = readTextChunks(element, style, {
      context: lc,
      dropped,
      measureWidth: (text, s) => this.measurer.measure(text, fontOf(s, 1)),
      charge: (elements, chars) => {
        this.charge(elements * WORK_TEXT_ELEMENT);
        if (chars > 0) this.chargeChars(chars);
      },
      maxDepth: MAX_NESTING,
      tooDeep: () => {
        throw new TooLarge();
      },
    });
    return { chunks, dropped: dropped.list() };
  }

  private clampRange(value: number, min: number, max: number): number {
    if (value >= min && value <= max) return value;
    this.dropped.add("valueLimit");
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }
}

function isHidden(style: ComputedStyle): boolean {
  const v = style.values["visibility"]?.toLowerCase();
  return v === "hidden" || v === "collapse";
}

// ---------------------------------------------------------------------------
// 形の読み取り
// ---------------------------------------------------------------------------

type Geometry =
  | {
      kind: "box";
      shape: "rect" | "ellipse";
      x: number;
      y: number;
      width: number;
      height: number;
      /** 角丸 (SVG の規則で幅・高さの半分に収めた値) */
      rx: number;
      ry: number;
    }
  | { kind: "line"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: "subpaths"; subpaths: Subpath[] };

function corner(x: number, y: number) {
  return { x, y, in: null, out: null, mirror: "none" as const };
}

/** 要素の形 (利用者の座標)。描かれない形 (大きさ 0、負の値) は null。 */
function readGeometry(element: Element, lc: LengthContext): Geometry | null {
  const len = (name: string, axis: "x" | "y" | "other") =>
    parseLength(element.getAttribute(name), lc, axis);
  switch (element.localName) {
    case "rect": {
      const width = len("width", "x") ?? 0;
      const height = len("height", "y") ?? 0;
      if (!(width > 0 && height > 0)) return null;
      let rx = len("rx", "x");
      let ry = len("ry", "y");
      if (rx !== null && rx < 0) rx = null;
      if (ry !== null && ry < 0) ry = null;
      const rxv = rx ?? ry ?? 0;
      const ryv = ry ?? rx ?? 0;
      return {
        kind: "box",
        shape: "rect",
        x: len("x", "x") ?? 0,
        y: len("y", "y") ?? 0,
        width,
        height,
        rx: Math.min(rxv, width / 2),
        ry: Math.min(ryv, height / 2),
      };
    }
    case "circle": {
      const r = len("r", "other") ?? 0;
      if (!(r > 0)) return null;
      const cx = len("cx", "x") ?? 0;
      const cy = len("cy", "y") ?? 0;
      return {
        kind: "box",
        shape: "ellipse",
        x: cx - r,
        y: cy - r,
        width: 2 * r,
        height: 2 * r,
        rx: 0,
        ry: 0,
      };
    }
    case "ellipse": {
      const rxRaw = len("rx", "x");
      const ryRaw = len("ry", "y");
      const rx = rxRaw ?? ryRaw ?? 0;
      const ry = ryRaw ?? rxRaw ?? 0;
      if (!(rx > 0 && ry > 0)) return null;
      const cx = len("cx", "x") ?? 0;
      const cy = len("cy", "y") ?? 0;
      return {
        kind: "box",
        shape: "ellipse",
        x: cx - rx,
        y: cy - ry,
        width: 2 * rx,
        height: 2 * ry,
        rx: 0,
        ry: 0,
      };
    }
    case "line":
      return {
        kind: "line",
        from: { x: len("x1", "x") ?? 0, y: len("y1", "y") ?? 0 },
        to: { x: len("x2", "x") ?? 0, y: len("y2", "y") ?? 0 },
      };
    case "polyline":
    case "polygon": {
      const numbers = parseNumberList(element.getAttribute("points"));
      const points = [];
      for (let i = 0; i + 1 < numbers.length; i += 2)
        points.push(corner(numbers[i] as number, numbers[i + 1] as number));
      if (points.length < 2) return null;
      return { kind: "subpaths", subpaths: [{ closed: element.localName === "polygon", points }] };
    }
    case "path": {
      const subpaths = parsePathData(element.getAttribute("d") ?? "").subpaths;
      return subpaths.length === 0 ? null : { kind: "subpaths", subpaths };
    }
    default:
      return null;
  }
}

/** 矩形・楕円の点の形 (利用者の座標)。角丸の縦横が違う矩形も表す。 */
function boxSubpaths(g: Extract<Geometry, { kind: "box" }>): Subpath[] {
  if (g.shape === "ellipse") return translateSubpaths(ellipseSubpaths(g.width, g.height), g.x, g.y);
  if (g.rx === g.ry || g.rx === 0 || g.ry === 0)
    return translateSubpaths(
      rectSubpaths(g.width, g.height, g.rx === 0 || g.ry === 0 ? 0 : g.rx),
      g.x,
      g.y,
    );
  // 縦横の違う角丸: x を ry/rx 倍した空間で円の角丸を作り、戻す
  const k = g.ry / g.rx;
  const circular = rectSubpaths(g.width * k, g.height, g.ry);
  return transformSubpaths(circular, multiply(translate(g.x, g.y), scale(1 / k, 1)));
}

interface BoxGeometryResult {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  radius: number;
}

/**
 * 矩形・楕円を、変換 `m` の後の箱と回転で表す。傾斜がある、角丸を 1 つの値で表せない、反転して破線がある
 * (破線の向きが逆になる) なら null (パスにする)。
 */
function boxNodeGeometry(
  g: Extract<Geometry, { kind: "box" }>,
  m: Matrix,
  stroke: Stroke | null,
): BoxGeometryResult | null {
  const d = decompose(m);
  if (!d || d.hasSkew) return null;
  const sx = d.scaleX;
  const sy = Math.abs(d.scaleY);
  if (!(sx > 0 && sy > 0)) return null;
  if (d.scaleY < 0 && stroke !== null && stroke.dash.length > 0) return null;
  const width = g.width * sx;
  const height = g.height * sy;
  let radius = 0;
  if (g.shape === "rect" && g.rx > 0 && g.ry > 0) {
    // 描画は rx = min(R, W/2)、ry = min(R, H/2)。SVG の結果 (a, b) に合う R を探す
    const a = g.rx * sx;
    const b = g.ry * sy;
    const close = (p: number, q: number) =>
      Math.abs(p - q) <= 1e-9 * Math.max(1, Math.abs(p), Math.abs(q));
    if (close(a, b)) radius = a;
    else if (a < b && close(a, width / 2)) radius = b;
    else if (b < a && close(b, height / 2)) radius = a;
    else return null;
    if (radius > CANVAS_LIMITS.maxRadius) return null;
  }
  const c = applyToPoint(m, { x: g.x + g.width / 2, y: g.y + g.height / 2 });
  return {
    x: cleanNumber(c.x - width / 2),
    y: cleanNumber(c.y - height / 2),
    width: cleanNumber(width),
    height: cleanNumber(height),
    rotation: cleanRotation(d.rotation),
    radius: cleanNumber(radius),
  };
}

/** 利用者の座標 → ノードの箱を 0〜1 に正規化した座標。箱の大きさが 0 なら null。 */
function userToBoxMatrix(box: BoxGeometryResult, m: Matrix): Matrix | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  const toBox = multiply(
    nodeMatrix(box.x, box.y, box.width, box.height, box.rotation),
    scale(box.width, box.height),
  );
  const inverse = invert(toBox);
  return inverse ? multiply(inverse, m) : null;
}

/** テキストの objectBoundingBox の近似: ノードの箱を利用者の座標へ戻した外接矩形。 */
function approximateTextBox(node: TextNode, m: Matrix): Rect | null {
  const inverse = invert(m);
  if (!inverse || !(node.width > 0 && node.height > 0)) return null;
  const box = nodeMatrix(node.x, node.y, node.width, node.height, node.rotation);
  const corners = [
    { x: 0, y: 0 },
    { x: node.width, y: 0 },
    { x: node.width, y: node.height },
    { x: 0, y: node.height },
  ].map((p) => applyToPoint(multiply(inverse, box), p));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// ---------------------------------------------------------------------------
// フォント
// ---------------------------------------------------------------------------

interface FontInfo {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
  letterSpacing: number;
}

/** `font-family` の先頭の名前 (引用符を外す)。 */
export function firstFontFamily(value: string | undefined): string {
  const raw = (value ?? "").trim();
  const match = /^\s*(?:"([^"]*)"|'([^']*)'|([^,]*))/.exec(raw);
  // 制御文字 (U+0000〜U+001F、U+007F〜U+009F) は §3.5 で使えないので落とす
  const printable = [...(match?.[1] ?? match?.[2] ?? match?.[3] ?? "")]
    .filter((c) => {
      const code = c.codePointAt(0) as number;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join("");
  const name = printable.replace(/\s+/g, " ").trim();
  if (name === "") return "serif";
  return [...name].slice(0, CANVAS_LIMITS.maxFontFamilyLength).join("");
}

function fontWeightOf(value: string | undefined): number {
  const v = (value ?? "normal").trim().toLowerCase();
  if (v === "bold" || v === "bolder") return 700;
  if (v === "normal") return 400;
  if (v === "lighter") return 300;
  const n = Number(v);
  if (!Number.isFinite(n)) return 400;
  return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
}

/** 書式からフォント (拡大率 `factor` を掛けた大きさ)。 */
function fontOf(style: ComputedStyle, factor: number): FontInfo {
  const v = style.values;
  const fontStyle = v["font-style"]?.toLowerCase() ?? "normal";
  const spacing = v["letter-spacing"]?.trim().toLowerCase();
  const letterSpacing =
    spacing === undefined || spacing === "normal"
      ? 0
      : (parseLength(spacing, { viewport: { width: 0, height: 0 }, fontSize: style.fontSize }) ??
        0);
  return {
    family: firstFontFamily(v["font-family"]),
    size: style.fontSize * factor,
    weight: fontWeightOf(v["font-weight"]),
    italic: fontStyle === "italic" || fontStyle.startsWith("oblique"),
    letterSpacing: letterSpacing * factor,
  };
}

/** テキスト 1 個の大きさを求め直す (`fitTextNodes` を 1 ノードの文書で使う)。 */
function fitSingleText(node: TextNode, measurer: TextMeasurer): TextNode {
  const doc: CanvasDocument = {
    pages: [{ id: "convert", name: "", children: [node.id], guides: [] }],
    nodes: { [node.id]: node },
    assets: {},
  };
  return fitTextNodes(doc, [node.id], measurer).nodes[node.id] as TextNode;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** テキストの字の範囲の近似 (行の箱ではなく、ベースラインから上へ 0.8 em、下へ 0.2 em)。 */
function textInkBounds(node: TextNode, measurer: TextMeasurer): Rect {
  const baseline = baselineOffset(node, measurer);
  const m = nodeMatrix(node.x, node.y, node.width, node.height, node.rotation);
  const top = baseline - node.fontSize * 0.8;
  const bottom = baseline + node.fontSize * 0.2;
  const corners = [
    { x: 0, y: top },
    { x: node.width, y: top },
    { x: node.width, y: bottom },
    { x: 0, y: bottom },
  ].map((p) => applyToPoint(m, p));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * ノード (group なら中の葉) の範囲。線の太さの半分を含め、テキストは字の範囲の近似。親の座標系の
 * 軸に平行な矩形。
 */
function leafExtents(doc: CanvasDocument, id: NodeId, measurer: TextMeasurer): Rect[] {
  const node = doc.nodes[id];
  if (!node) return [];
  if (node.type === "group")
    return node.children.flatMap((child) => leafExtents(doc, child, measurer));
  const bounds = node.type === "text" ? textInkBounds(node, measurer) : getLocalBounds(doc, id);
  if (!bounds) return [];
  const half = "stroke" in node && node.stroke ? node.stroke.width / 2 : 0;
  return [
    {
      x: bounds.x - half,
      y: bounds.y - half,
      width: bounds.width + 2 * half,
      height: bounds.height + 2 * half,
    },
  ];
}

/** 矩形の 4 隅を行列で写したものの外接矩形。 */
function mappedRect(m: Matrix, rect: Rect): Rect {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((p) => applyToPoint(m, p));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** 矩形が (0, 0)〜(width, height) に収まるか (0.5 の余裕)。 */
function rectInside(rect: Rect, width: number, height: number): boolean {
  const tolerance = 0.5;
  return (
    rect.x >= -tolerance &&
    rect.y >= -tolerance &&
    rect.x + rect.width <= width + tolerance &&
    rect.y + rect.height <= height + tolerance
  );
}

/**
 * 結果の形が箱 (0〜width, 0〜height) の外へはみ出すか。今の描画は埋め込み SVG を箱で切り抜いているので、
 * はみ出した部分は変換すると見えるようになる。
 */
function overflowsBox(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  width: number,
  height: number,
  measurer: TextMeasurer,
): boolean {
  return ids.some((id) =>
    leafExtents(doc, id, measurer).some((rect) => !rectInside(rect, width, height)),
  );
}

/**
 * テキストの向き (度)。テキストは鏡像を表せないので、行列の反転を除き、テキストの下向き (自分の y 軸) が
 * 行列で写した y 軸の向きになる角度にする (左右反転したテキストは正立した文字になる)。
 */
function textRotation(m: Matrix): number {
  const down = { x: m.c, y: m.d };
  if (!(Math.hypot(down.x, down.y) > 0)) return 0;
  return cleanRotation((Math.atan2(-down.x, down.y) * 180) / Math.PI);
}

/** ルートの座標系 (利用者の座標 → 箱) と viewport。 */
function rootSpace(
  root: Element,
  options: SvgConvertOptions,
): { m: Matrix; viewport: { width: number; height: number } } {
  const viewBox = parseViewBox(root.getAttribute("viewBox"));
  if (viewBox)
    return {
      m: multiply(
        scale(options.width / viewBox.width, options.height / viewBox.height),
        translate(-viewBox.x, -viewBox.y),
      ),
      viewport: { width: viewBox.width, height: viewBox.height },
    };
  const lc: LengthContext = {
    viewport: { width: options.assetWidth, height: options.assetHeight },
    fontSize: INITIAL_STYLE.fontSize,
  };
  const absolute = (name: string, axis: "x" | "y", fallback: number) => {
    const raw = root.getAttribute(name);
    if (raw === null || raw.trim().endsWith("%")) return fallback;
    const value = parseLength(raw, lc, axis);
    return value !== null && value > 0 ? value : fallback;
  };
  const width = absolute("width", "x", options.assetWidth);
  const height = absolute("height", "y", options.assetHeight);
  return { m: scale(options.width / width, options.height / height), viewport: { width, height } };
}

/** SVG 文書を、埋め込み SVG のノードの座標系の断片にする。 */
export function convertSvg(svg: string, options: SvgConvertOptions): SvgConvertResult {
  try {
    validateSvg(svg, policy);
  } catch (error) {
    return { ok: false, reason: "invalid", detail: error instanceof Error ? error.message : null };
  }
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg")
    return { ok: false, reason: "invalid", detail: null };

  const converter = new Converter(root, options.measurer);
  const space = rootSpace(root, options);
  const lc: LengthContext = { viewport: space.viewport, fontSize: INITIAL_STYLE.fontSize };
  const rootStyle = computeStyle(root, INITIAL_STYLE, lc);
  let ids: NodeId[];
  try {
    ids = [];
    for (const child of childElements(root))
      ids.push(
        ...converter.visit(child, {
          m: space.m,
          style: rootStyle,
          viewport: space.viewport,
          depth: 1,
        }),
      );
  } catch (error) {
    if (error instanceof TooLarge) return { ok: false, reason: "tooLarge", detail: null };
    throw error;
  }
  if (ids.length === 0) return { ok: false, reason: "empty", detail: null };

  const rootOpacity = parseOpacity(nonInheritedValue(root, "opacity")) ?? 1;
  const rootId = "svgc0";
  const group = createGroup(ids, { id: rootId, opacity: rootOpacity });
  const nodes: Record<NodeId, CanvasNode> = { ...converter.nodes, [rootId]: group };
  const fragmentDoc: CanvasDocument = {
    pages: [{ id: "convert", name: "", children: [rootId], guides: [] }],
    nodes,
    assets: {},
  };
  if (overflowsBox(fragmentDoc, ids, options.width, options.height, options.measurer))
    converter.dropped.add("outsideBox");
  const used = (name: string) => {
    const value = nonInheritedValue(root, name);
    return value !== null && value.toLowerCase() !== "none";
  };
  if (used("clip-path")) converter.dropped.add("clipPath");
  if (used("mask")) converter.dropped.add("mask");
  if (used("filter")) converter.dropped.add("filter");
  return {
    ok: true,
    fragment: { roots: [rootId], nodes, assets: {} },
    dropped: converter.dropped.list(),
  };
}
