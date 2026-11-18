/**
 * SVG のグラデーションを §3 のグラデーションにする (§8.12)。
 *
 * §3 のグラデーションは「ノードの箱を 0〜1 に正規化した座標」で持ち、描画は箱への引き伸ばし
 * (`gradientTransform="matrix(w 0 0 h x y)"`) で描く。SVG のグラデーションの座標 g から、正規化した箱の座標
 * u への変換を K (アフィン) とすると:
 *
 * - 線形: 色の位置 t は g の 1 次式なので、K で写しても線形のまま厳密に表せる。始点は K(p1)、向きは
 *   K の線形部分 L で t の勾配を写したもの (L^-T v / |v|²) から求める
 * - 放射: L が相似 (回転と一様な拡大、反転を含む) なら円は円に写るので厳密。そうでなければ (箱の縦横が
 *   違う userSpaceOnUse など) 半径を √|det L| 倍にした円で近似し、一覧に出す。焦点 (fx, fy, fr) は表せない
 * - `spreadMethod` の reflect / repeat は表せない (pad で描く)。停止点の上限 (16 個) を超えたら間引く
 * - `fill-opacity` は停止点の不透明度に掛ける (§3 の塗りはグラデーション全体の不透明度を持たない)
 *
 * `href` で別のグラデーションの属性と停止点を引き継ぐ (Inkscape の書き方)。循環と長さの上限を設ける。
 */
import {
  applyToPoint,
  determinant,
  IDENTITY,
  invert,
  type Matrix,
  multiply,
  scale,
  translate,
} from "../geometry/matrix";
import { CANVAS_LIMITS } from "../model/limits";
import type { GradientStop, Paint, Point } from "../model/types";
import type { DroppedCollector } from "./dropped";
import { childElements, hrefTarget, nonInheritedValue, ownValue, SVG_NS } from "./style";
import {
  cleanNumber,
  parseColor,
  parseLength,
  parseNumber,
  parseOpacity,
  parseTransformList,
  type LengthContext,
} from "./values";

/** href をたどる回数の上限。 */
const MAX_HREF_CHAIN = 16;

export interface GradientSource {
  type: "linear" | "radial";
  units: "objectBoundingBox" | "userSpaceOnUse";
  /** gradientTransform */
  transform: Matrix;
  spread: "pad" | "reflect" | "repeat";
  /** 線形: x1 y1 x2 y2。放射: cx cy r fx fy fr */
  coords: Readonly<Record<string, number>>;
  /** offset の昇順 (同値可)、不透明度は `stop-opacity` と色のアルファ */
  stops: GradientStop[];
}

const LINEAR_DEFAULTS: Readonly<Record<string, string>> = {
  x1: "0%",
  y1: "0%",
  x2: "100%",
  y2: "0%",
};
const RADIAL_DEFAULTS: Readonly<Record<string, string>> = {
  cx: "50%",
  cy: "50%",
  r: "50%",
  fr: "0%",
};

function isGradient(element: Element): boolean {
  return (
    element.namespaceURI === SVG_NS &&
    (element.localName === "linearGradient" || element.localName === "radialGradient")
  );
}

/** 自分から href をたどったグラデーションの並び (循環と上限で止める)。 */
function gradientChain(element: Element, lookup: (id: string) => Element | undefined): Element[] {
  const chain = [element];
  let current = element;
  while (chain.length < MAX_HREF_CHAIN) {
    const id = hrefTarget(current);
    const next = id === null ? undefined : lookup(id);
    if (!next || !isGradient(next) || chain.includes(next)) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

/** 祖先をたどって `color` を求める (`currentColor` の停止点のため)。 */
function inheritedColor(element: Element): string {
  for (let e: Element | null = element; e; e = e.parentElement) {
    const own = ownValue(e, "color");
    if (own !== null && own.toLowerCase() !== "inherit") return own;
  }
  return "black";
}

function readStops(gradient: Element): GradientStop[] {
  const stops: GradientStop[] = [];
  let previous = 0;
  for (const child of childElements(gradient)) {
    if (child.namespaceURI !== SVG_NS || child.localName !== "stop") continue;
    const raw = child.getAttribute("offset")?.trim() ?? "0";
    const n = raw.endsWith("%") ? parseNumber(raw.slice(0, -1)) : parseNumber(raw);
    const offset = Math.max(
      previous,
      Math.min(1, Math.max(0, n === null ? 0 : raw.endsWith("%") ? n / 100 : n)),
    );
    previous = offset;
    let colorValue = nonInheritedValue(child, "stop-color") ?? "black";
    if (colorValue.toLowerCase() === "currentcolor") colorValue = inheritedColor(child);
    const color = parseColor(colorValue) ?? { color: "#000000", alpha: 1 };
    const opacity = parseOpacity(nonInheritedValue(child, "stop-opacity")) ?? 1;
    stops.push({ offset, color: color.color, opacity: color.alpha * opacity });
  }
  return stops;
}

/** グラデーションの要素を読む (href の引き継ぎを含む)。 */
export function readGradient(
  element: Element,
  lookup: (id: string) => Element | undefined,
  context: LengthContext,
): GradientSource | null {
  if (!isGradient(element)) return null;
  const type = element.localName === "linearGradient" ? "linear" : "radial";
  const chain = gradientChain(element, lookup);
  const common = (name: string) => {
    for (const e of chain) {
      const value = e.getAttribute(name);
      if (value !== null) return value;
    }
    return null;
  };
  const own = (name: string) => {
    for (const e of chain) {
      if (e.localName !== element.localName) continue;
      const value = e.getAttribute(name);
      if (value !== null) return value;
    }
    return null;
  };
  const units =
    common("gradientUnits") === "userSpaceOnUse" ? "userSpaceOnUse" : "objectBoundingBox";
  const transform = parseTransformList(common("gradientTransform")) ?? IDENTITY;
  const spreadValue = common("spreadMethod");
  const spread = spreadValue === "reflect" || spreadValue === "repeat" ? spreadValue : "pad";

  const coordinate = (raw: string, axis: "x" | "y" | "other"): number | null => {
    if (units === "objectBoundingBox") {
      const v = raw.trim();
      if (v.endsWith("%")) {
        const n = parseNumber(v.slice(0, -1));
        return n === null ? null : n / 100;
      }
      return parseNumber(v);
    }
    return parseLength(raw, context, axis);
  };
  const defaults = type === "linear" ? LINEAR_DEFAULTS : RADIAL_DEFAULTS;
  const axes: Readonly<Record<string, "x" | "y" | "other">> = {
    x1: "x",
    x2: "x",
    y1: "y",
    y2: "y",
    cx: "x",
    cy: "y",
    fx: "x",
    fy: "y",
    r: "other",
    fr: "other",
  };
  const coords: Record<string, number> = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const raw = own(name);
    coords[name] =
      (raw === null ? null : coordinate(raw, axes[name] ?? "other")) ??
      (coordinate(fallback, axes[name] ?? "other") as number);
  }
  if (type === "radial") {
    const fx = own("fx");
    const fy = own("fy");
    coords["fx"] = (fx === null ? null : coordinate(fx, "x")) ?? (coords["cx"] as number);
    coords["fy"] = (fy === null ? null : coordinate(fy, "y")) ?? (coords["cy"] as number);
  }
  const stopsOwner = chain.find((e) =>
    [...childElements(e)].some((c) => c.namespaceURI === SVG_NS && c.localName === "stop"),
  );
  return { type, units, transform, spread, coords, stops: stopsOwner ? readStops(stopsOwner) : [] };
}

// ---------------------------------------------------------------------------
// §3 のグラデーションへ
// ---------------------------------------------------------------------------

export interface BoxSpace {
  /** 利用者の座標 (要素の座標系) → ノードの箱を 0〜1 に正規化した座標。箱の大きさが 0 なら null */
  userToBox: Matrix | null;
  /** objectBoundingBox の基準になる、要素の座標系での外接矩形 */
  bbox: { x: number; y: number; width: number; height: number } | null;
}

const MAX_GRADIENT_COORD = 100;

/** 停止点を上限の数に間引く (先頭と末尾は残し、間を等しい間隔で選ぶ)。 */
function limitStops(stops: GradientStop[], dropped: DroppedCollector): GradientStop[] {
  const max = CANVAS_LIMITS.maxGradientStops;
  if (stops.length <= max) return stops;
  dropped.add("gradientStops");
  const result: GradientStop[] = [];
  for (let i = 0; i < max; i++) {
    const index = Math.round((i * (stops.length - 1)) / (max - 1));
    result.push(stops[index] as GradientStop);
  }
  return result;
}

function solid(stop: GradientStop): Paint {
  return { type: "solid", color: stop.color, opacity: stop.opacity };
}

/** 位置 t (0〜1) の色に近い停止点 (表せないときの代わりの単色)。 */
function stopNear(stops: readonly GradientStop[], t: number): GradientStop {
  let best = stops[0] as GradientStop;
  for (const stop of stops) if (Math.abs(stop.offset - t) < Math.abs(best.offset - t)) best = stop;
  return best;
}

const cleanPoint = (p: Point): Point => ({ x: cleanNumber(p.x), y: cleanNumber(p.y) });

const inRange = (p: Point) =>
  Math.abs(p.x) <= MAX_GRADIENT_COORD && Math.abs(p.y) <= MAX_GRADIENT_COORD;

/** L が相似 (回転と一様な拡大、反転を含む) か。 */
function isSimilarity(m: Matrix): boolean {
  const size = Math.max(Math.abs(m.a), Math.abs(m.b), Math.abs(m.c), Math.abs(m.d));
  const eps = size * 1e-6;
  const rotation = Math.abs(m.a - m.d) <= eps && Math.abs(m.b + m.c) <= eps;
  const reflection = Math.abs(m.a + m.d) <= eps && Math.abs(m.b - m.c) <= eps;
  return rotation || reflection;
}

/**
 * 読んだグラデーションを、ノードの箱の §3 の塗りにする。`opacity` は `fill-opacity` (停止点に掛ける)。
 * 停止点がなければ null (SVG では塗らない)。1 個なら単色。
 */
export function gradientToPaint(
  source: GradientSource,
  opacity: number,
  space: BoxSpace,
  dropped: DroppedCollector,
): Paint | null {
  if (source.stops.length === 0) return null;
  const stops = limitStops(
    source.stops.map((stop) => ({ ...stop, opacity: stop.opacity * opacity })),
    dropped,
  );
  const first = stops[0] as GradientStop;
  const last = stops[stops.length - 1] as GradientStop;
  if (stops.length === 1) return solid(first);
  if (source.spread !== "pad") dropped.add("gradientSpread");

  let base: Matrix = source.transform;
  if (source.units === "objectBoundingBox") {
    const bbox = space.bbox;
    // 大きさのない形には、objectBoundingBox のグラデーションは描かれない (SVG の規則)
    if (!bbox || !(bbox.width > 0) || !(bbox.height > 0)) return null;
    base = multiply(
      multiply(translate(bbox.x, bbox.y), scale(bbox.width, bbox.height)),
      source.transform,
    );
  }
  // 箱の大きさが 0 のノードは、描画が先頭の停止点の色で塗る
  if (!space.userToBox) return solid(first);
  const k = multiply(space.userToBox, base);
  const linear: Matrix = { a: k.a, b: k.b, c: k.c, d: k.d, e: 0, f: 0 };
  const c = source.coords;

  if (source.type === "linear") {
    const p1 = { x: c["x1"] as number, y: c["y1"] as number };
    const v = { x: (c["x2"] as number) - p1.x, y: (c["y2"] as number) - p1.y };
    const length2 = v.x * v.x + v.y * v.y;
    // 始点と終点が同じなら、最後の停止点の色で塗る (SVG の規則)
    if (!(length2 > 0)) return solid(last);
    const inv = invert(linear);
    if (!inv) return solid(stopNear(stops, 0.5));
    // n = L^-T v / |v|²: 正規化した箱の座標での t の勾配
    const n = {
      x: (inv.a * v.x + inv.b * v.y) / length2,
      y: (inv.c * v.x + inv.d * v.y) / length2,
    };
    const n2 = n.x * n.x + n.y * n.y;
    if (!(n2 > 0) || !Number.isFinite(n2)) return solid(stopNear(stops, 0.5));
    const d = { x: n.x / n2, y: n.y / n2 };
    let from = applyToPoint(k, p1);
    // t は d の向きの位置だけで決まるので、始点を d に垂直な向きに動かして原点に寄せる (値の範囲に収めるため)
    const d2 = d.x * d.x + d.y * d.y;
    const along = (from.x * d.x + from.y * d.y) / d2;
    from = { x: along * d.x, y: along * d.y };
    const to = { x: from.x + d.x, y: from.y + d.y };
    if (!inRange(from) || !inRange(to)) {
      dropped.add("gradientTransform");
      // 箱の中心での位置の色にする
      const t = ((0.5 - from.x) * d.x + (0.5 - from.y) * d.y) / d2;
      return solid(stopNear(stops, Math.min(1, Math.max(0, t))));
    }
    return { type: "linear", stops, from: cleanPoint(from), to: cleanPoint(to) };
  }

  const r = c["r"] as number;
  if (!(r > 0)) return solid(last);
  if (!isSimilarity(linear)) dropped.add("gradientTransform");
  if (c["fx"] !== c["cx"] || c["fy"] !== c["cy"] || (c["fr"] as number) > 0)
    dropped.add("gradientFocal");
  const center = applyToPoint(k, { x: c["cx"] as number, y: c["cy"] as number });
  let radius = r * Math.sqrt(Math.abs(determinant(linear)));
  if (!(radius > 0) || !Number.isFinite(radius)) return solid(stopNear(stops, 0.5));
  if (radius > MAX_GRADIENT_COORD || !inRange(center)) {
    dropped.add("valueLimit");
    radius = Math.min(radius, MAX_GRADIENT_COORD);
    center.x = Math.min(MAX_GRADIENT_COORD, Math.max(-MAX_GRADIENT_COORD, center.x));
    center.y = Math.min(MAX_GRADIENT_COORD, Math.max(-MAX_GRADIENT_COORD, center.y));
  }
  return { type: "radial", stops, center: cleanPoint(center), radius: cleanNumber(radius) };
}

/** 停止点の中ほどの色 (線のグラデーションの代わりの単色)。停止点がなければ null。 */
export function gradientAverageStop(source: GradientSource): GradientStop | null {
  if (source.stops.length === 0) return null;
  return stopNear(source.stops, 0.5);
}
