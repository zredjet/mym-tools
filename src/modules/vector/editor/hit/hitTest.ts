/**
 * ヒットテスト (§4.5、§8.5.8)。文書の幾何だけから求める純関数で、DOM (`elementFromPoint`) には頼らない。
 *
 * 2 段に分ける。
 * 1. `hitTestPath`: 点の下にある前面のノードを、ページ直下から当たったノードまでの道として返す
 * 2. `pickTarget`: その道とスコープ・修飾キーから、選ぶノードを決める
 *
 * ページ直下の frame の名前のラベルは `hitFrameLabel` で別に調べる (ラベルは文書より前面に描く)。
 *
 * 回転 (§8.5.8): 箱を持つノードは、点をノードの座標系へ戻してから箱で判定する。frame の子は frame の座標系の点で
 * 調べる。座標系はどれも回転と平行移動だけなので、距離 (線の太さ・余裕) は変わらない。
 *
 * E・F が使うもの:
 * - `hitTestPath(doc, pageId, point, zoom, scopeId?)`: `scopeId` (今のスコープ) を渡すと、スコープかその祖先の
 *   ブーリアンの中で子を個別に当てる (子は形の輪郭の上と内側で当たる)。渡さないとブーリアンは結果の形で当たり、
 *   道の末尾に点の下の子を足す (Cmd/Ctrl のクリックで子を選べる)
 * - `pathShapeHit(subpaths, fillRule, point, hasFill, strokeWidth, slop)`: パスの形の当たり (§8.5.8 の規則)
 */
import { frameLabelRect } from "../canvas/frameLabels";
import { getBooleanEvaluation, shapeOperand, type BooleanEvaluation } from "../boolean/result";
import type { BooleanOperand } from "../boolean/index";
import { applyToPoint, invert, type Matrix, multiply } from "../geometry/matrix";
import {
  getPageBounds,
  isTranslation,
  nodeTransform,
  rectContainsPoint,
  type Rect,
} from "../model/geometry";
import { getAncestors, getNode, getPage, getParent, isGroupLike } from "../model/tree";
import type {
  BooleanNode,
  CanvasDocument,
  CanvasNode,
  FillRule,
  NodeId,
  PageId,
  PathNode,
  Point,
  Subpath,
} from "../model/types";
import { containsPoint, distanceToPath, pathBoundsRect } from "../path/measure";
import type { TextMeasurer } from "../render/types";
import { distanceToSegment, insideGrownEllipse, roundedRectDistance } from "./shapes";

/** 線の当たりの太さに足す余裕 (画面 px)。線の太さ + この値の帯が当たる (§4.5)。 */
export const STROKE_HIT_SLOP = 4;

/** ノードとその祖先がすべて表示中で、ロックされていないか。当たるか・動かせるかの判定に使う。 */
export function isInteractive(doc: CanvasDocument, id: NodeId): boolean {
  const node = getNode(doc, id);
  if (!node || !node.visible || node.locked) return false;
  return getAncestors(doc, id).every((ancestor) => ancestor.visible && !ancestor.locked);
}

/** ページ直下の frame か。 */
export function isTopLevelFrame(doc: CanvasDocument, id: NodeId): boolean {
  return getNode(doc, id)?.type === "frame" && getParent(doc, id)?.kind === "page";
}

// ---------------------------------------------------------------------------
// 1. 点の下のノード
// ---------------------------------------------------------------------------

/**
 * 図形の当たり。`d` は輪郭からの符号付き距離 (内側が負)。`strokeWidth` は線がなければ null。
 * - 塗りがあれば、内側と線の外側の半分
 * - 線があれば、線の太さ + 余裕の帯 (塗りの外側にも余裕が付く)
 * - 塗りも線もない図形は、太さ 0 の線として輪郭の近くだけ
 * 線のない塗りの図形には余裕を付けない (小さな図形が隣の図形の分まで当たらないように)
 */
function shapeHit(d: number, hasFill: boolean, strokeWidth: number | null, slop: number): boolean {
  if (hasFill && d <= (strokeWidth ?? 0) / 2) return true;
  if (strokeWidth !== null) return Math.abs(d) <= (strokeWidth + slop) / 2;
  return !hasFill && Math.abs(d) <= slop / 2;
}

/**
 * 楕円の当たり。規則は `shapeHit` と同じで、線の帯は外側へ広げた楕円と内側へ縮めた楕円で判定する
 * (内側の半径が 0 以下なら内側はない)。
 */
function ellipseHit(
  p: Point,
  rect: Rect,
  hasFill: boolean,
  strokeWidth: number | null,
  slop: number,
): boolean {
  if (hasFill && insideGrownEllipse(p, rect, (strokeWidth ?? 0) / 2)) return true;
  const half = strokeWidth !== null ? (strokeWidth + slop) / 2 : hasFill ? null : slop / 2;
  if (half === null) return false;
  return insideGrownEllipse(p, rect, half) && !insideGrownEllipse(p, rect, -half);
}

/**
 * パスの形の当たり (§8.5.8)。塗りがあれば塗りの規則で内側 (閉じていない輪郭は閉じた形)。線があれば、
 * 描かれる輪郭までの距離が太さの半分 + 余裕以内。どちらもなければ、輪郭までの距離が余裕以内。
 * `bounds` (形の範囲) を渡すと、明らかに遠い点では曲線を調べない。
 */
export function pathShapeHit(
  subpaths: readonly Subpath[],
  fillRule: FillRule,
  p: Point,
  hasFill: boolean,
  strokeWidth: number | null,
  slop: number,
  bounds: Rect | null = pathBoundsRect(subpaths),
): boolean {
  if (!bounds) return false;
  const reach = (strokeWidth ?? 0) / 2 + slop;
  if (
    p.x < bounds.x - reach ||
    p.x > bounds.x + bounds.width + reach ||
    p.y < bounds.y - reach ||
    p.y > bounds.y + bounds.height + reach
  )
    return false;
  if (hasFill && containsPoint(subpaths, p, fillRule)) return true;
  if (strokeWidth === null && hasFill) return false;
  return distanceToPath(subpaths, p) <= reach;
}

/** 形の輪郭の上か内側か (ブーリアンの子の当たり。§8.5.8)。 */
function outlineOrInside(operand: BooleanOperand, p: Point, slop: number): boolean {
  const bounds = pathBoundsRect(operand.subpaths);
  if (!bounds) return false;
  if (
    !rectContainsPoint(
      {
        x: bounds.x - slop,
        y: bounds.y - slop,
        width: bounds.width + slop * 2,
        height: bounds.height + slop * 2,
      },
      p,
    )
  )
    return false;
  return (
    containsPoint(operand.subpaths, p, operand.fillRule) ||
    distanceToPath(operand.subpaths, p) <= slop
  );
}

function boxOf(node: { x: number; y: number; width: number; height: number }, origin: Point): Rect {
  return { x: origin.x + node.x, y: origin.y + node.y, width: node.width, height: node.height };
}

/** ページの点を `m` (ページ ← ある座標系) の座標系へ戻す。逆がなければ null。 */
function toSpace(m: Matrix, p: Point): Point | null {
  if (isTranslation(m)) return { x: p.x - m.e, y: p.y - m.f };
  const inverse = invert(m);
  return inverse ? applyToPoint(inverse, p) : null;
}

/**
 * 箱を持つノードの判定に使う点と箱。回転していない座標系の回転していないノードは、ページの点と
 * ページ座標の箱 (第 1 段階と同じ計算)。そうでなければ、ノードの座標系の点と (0, 0) からの箱。
 */
function boxFrame(
  node: { x: number; y: number; width: number; height: number; rotation: number },
  space: Matrix,
  p: Point,
): { point: Point; rect: Rect } | null {
  if (node.rotation === 0 && isTranslation(space))
    return { point: p, rect: boxOf(node, { x: space.e, y: space.f }) };
  const local = toSpace(multiply(space, nodeTransform(node as CanvasNode)), p);
  return local && { point: local, rect: { x: 0, y: 0, width: node.width, height: node.height } };
}

/** パスの形の当たり (ノードの座標系で調べる)。 */
function pathNodeHit(node: PathNode, space: Matrix, p: Point, slop: number): boolean {
  const local = toSpace(multiply(space, nodeTransform(node)), p);
  if (!local) return false;
  return pathShapeHit(
    node.subpaths,
    node.fillRule,
    local,
    node.fill !== null,
    node.stroke?.width ?? null,
    slop,
  );
}

/** ブーリアンの結果の形の当たり。求められなかったときは、子の形をそれぞれ塗りと線で描いたもの (§8.9.3)。 */
function booleanShapeHit(
  node: BooleanNode,
  evaluation: BooleanEvaluation | null,
  q: Point,
  slop: number,
): boolean {
  const hasFill = node.fill !== null;
  const strokeWidth = node.stroke?.width ?? null;
  if (!evaluation) return false;
  const { result } = evaluation;
  if (result)
    return pathShapeHit(result.subpaths, "nonzero", q, hasFill, strokeWidth, slop, result.bounds);
  return evaluation.operands.some((operand) =>
    pathShapeHit(operand.subpaths, operand.fillRule, q, hasFill, strokeWidth, slop),
  );
}

/** 葉 (frame / group / ブーリアン以外) が点に当たるか。`space` はページ ← 親の座標系。 */
function leafHit(node: CanvasNode, space: Matrix, p: Point, slop: number): boolean {
  switch (node.type) {
    case "line": {
      const origin = isTranslation(space) ? { x: space.e, y: space.f } : null;
      const a = origin
        ? { x: origin.x + node.x1, y: origin.y + node.y1 }
        : applyToPoint(space, { x: node.x1, y: node.y1 });
      const b = origin
        ? { x: origin.x + node.x2, y: origin.y + node.y2 }
        : applyToPoint(space, { x: node.x2, y: node.y2 });
      return distanceToSegment(p, a, b) <= (node.stroke.width + slop) / 2;
    }
    case "rect": {
      const f = boxFrame(node, space, p);
      if (!f) return false;
      const d = roundedRectDistance(f.point, f.rect, node.radius);
      return shapeHit(d, node.fill !== null, node.stroke?.width ?? null, slop);
    }
    case "ellipse": {
      const f = boxFrame(node, space, p);
      return (
        f !== null &&
        ellipseHit(f.point, f.rect, node.fill !== null, node.stroke?.width ?? null, slop)
      );
    }
    case "image": {
      const f = boxFrame(node, space, p);
      return f !== null && roundedRectDistance(f.point, f.rect, node.radius) <= 0;
    }
    // テキストと埋め込み SVG は枠の中が当たる
    case "text":
    case "svg": {
      const f = boxFrame(node, space, p);
      return f !== null && roundedRectDistance(f.point, f.rect, 0) <= 0;
    }
    case "path":
      return pathNodeHit(node, space, p, slop);
    default:
      return false;
  }
}

interface HitContext {
  doc: CanvasDocument;
  slop: number;
  /** スコープとその祖先。この中のブーリアンは子を個別に当てる */
  scopeChain: ReadonlySet<NodeId>;
}

/**
 * ブーリアンの子のうち、点の下の最も前面のものへの道。子は形 (輪郭) の線の上と内側で当たる (§8.5.8)。
 * スコープの中の子のブーリアンは、さらにその子を個別に当てる。
 */
function hitBooleanChildren(
  ctx: HitContext,
  node: BooleanNode,
  space: Matrix,
  p: Point,
  q: Point,
  depth: number,
): NodeId[] | null {
  if (depth > 64) return null; // 壊れた文書の循環で止まるように
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = getNode(ctx.doc, node.children[i] as NodeId);
    if (!child || !child.visible || child.locked) continue;
    if (child.type === "boolean") {
      if (ctx.scopeChain.has(child.id)) {
        const inner = hitNode(ctx, child, space, p, depth + 1);
        if (inner) return inner;
        continue;
      }
      const evaluation = getBooleanEvaluation(ctx.doc, child.id);
      const operands = evaluation?.result
        ? [{ subpaths: evaluation.result.subpaths, fillRule: "nonzero" as const }]
        : (evaluation?.operands ?? []);
      if (operands.some((operand) => outlineOrInside(operand, q, ctx.slop))) {
        const deeper = hitBooleanChildren(ctx, child, space, p, q, depth + 1);
        return deeper ? [child.id, ...deeper] : [child.id];
      }
      continue;
    }
    const operand = shapeOperand(child);
    if (operand && outlineOrInside(operand, q, ctx.slop)) return [child.id];
  }
  return null;
}

/**
 * ノード (子を含む) が点に当たれば、そのノードから当たったノードまでの道を返す。
 * `space` はページ ← ノードの親の座標系、`p` はページ座標の点。
 * frame は子を先に調べ (子は frame の前面)、子に当たらなければ frame の矩形の中が当たる。
 * 子を切り抜く frame の外では子に当たらない。
 */
function hitNode(
  ctx: HitContext,
  node: CanvasNode,
  space: Matrix,
  p: Point,
  depth: number,
): NodeId[] | null {
  if (!node.visible || node.locked) return null;
  const { doc, slop } = ctx;
  if (node.type === "group") {
    if (depth > 64) return null; // 壊れた文書の循環で止まるように
    const child = hitChildren(ctx, node.children, space, p, depth + 1);
    return child ? [node.id, ...child] : null;
  }
  if (node.type === "boolean") {
    const q = toSpace(space, p);
    if (!q) return null;
    const inside = ctx.scopeChain.has(node.id);
    if (inside) {
      const child = hitBooleanChildren(ctx, node, space, p, q, depth + 1);
      if (child) return [node.id, ...child];
    }
    if (!booleanShapeHit(node, getBooleanEvaluation(doc, node.id), q, slop)) return null;
    // スコープの外では結果の形で当たる。道の末尾に点の下の子を足す (Cmd/Ctrl のクリックで子を選ぶ)
    const child = inside ? null : hitBooleanChildren(ctx, node, space, p, q, depth + 1);
    return child ? [node.id, ...child] : [node.id];
  }
  if (node.type !== "frame") return leafHit(node, space, p, slop) ? [node.id] : null;
  const f = boxFrame(node, space, p);
  if (!f) return null;
  const d = roundedRectDistance(f.point, f.rect, node.radius);
  if (depth <= 64 && !(node.clip && d > 0)) {
    const child = hitChildren(
      ctx,
      node.children,
      multiply(space, nodeTransform(node)),
      p,
      depth + 1,
    );
    if (child) return [node.id, ...child];
  }
  return d <= (node.stroke?.width ?? 0) / 2 ? [node.id] : null;
}

function hitChildren(
  ctx: HitContext,
  ids: readonly NodeId[],
  space: Matrix,
  p: Point,
  depth: number,
): NodeId[] | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const node = getNode(ctx.doc, ids[i] as NodeId);
    if (!node) continue;
    const path = hitNode(ctx, node, space, p, depth);
    if (path) return path;
  }
  return null;
}

/**
 * 点 (ページ座標) の下にある最も前面のノードを、ページ直下のノードから当たったノードまでの
 * 道 (`[ページ直下, …, 当たったノード]`) で返す。何もなければ null。
 *
 * - 前面から順に調べる。`visible` が false か `locked` が true のノードとその子孫は当たらない
 * - 塗りのない図形は線の上だけが当たる。線は太さに `STROKE_HIT_SLOP` 画面 px を足す
 * - frame は、子に当たらなければ矩形の中が当たる (道が frame で終わる)
 * - パスとブーリアンは §8.5.8 の規則 (`pathShapeHit`)。ブーリアンは結果の形で当たり、`scopeId` かその祖先の
 *   ブーリアンの中では、子を個別に (輪郭の上と内側で) 当てる
 */
export function hitTestPath(
  doc: CanvasDocument,
  pageId: PageId,
  point: Point,
  zoom: number,
  scopeId: NodeId | null = null,
): NodeId[] | null {
  const page = getPage(doc, pageId);
  if (!page) return null;
  const scopeChain = new Set<NodeId>();
  if (scopeId !== null && getNode(doc, scopeId)) {
    scopeChain.add(scopeId);
    for (const ancestor of getAncestors(doc, scopeId)) scopeChain.add(ancestor.id);
  }
  const ctx: HitContext = { doc, slop: STROKE_HIT_SLOP / zoom, scopeChain };
  return hitChildren(ctx, page.children, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, point, 1);
}

/** 点の下にあるページ直下の frame の名前のラベル (前面のものから)。ロック中と非表示の frame は当たらない。 */
export function hitFrameLabel(
  doc: CanvasDocument,
  pageId: PageId,
  point: Point,
  zoom: number,
  measurer: TextMeasurer,
): NodeId | null {
  const page = getPage(doc, pageId);
  if (!page) return null;
  for (let i = page.children.length - 1; i >= 0; i--) {
    const id = page.children[i] as NodeId;
    const node = getNode(doc, id);
    if (node?.type !== "frame" || !node.visible || node.locked) continue;
    const rect = frameLabelRect(doc, id, zoom, measurer);
    if (
      rect &&
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    )
      return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. 選ぶノード
// ---------------------------------------------------------------------------

export interface PickOptions {
  /** Cmd/Ctrl: いちばん深いノードを選ぶ */
  deep?: boolean;
  /** 今の選択。点の下に選択済みのノードがあれば、それを選ぶ (選択したままドラッグできるように) */
  selection?: ReadonlySet<NodeId>;
  /** 押した点 (ページ座標)。group のスコープの外接矩形の中かを調べる */
  point?: Point;
}

export interface PickResult {
  /** 選ぶノード。null は何もない場所 (選択の解除と範囲選択) */
  id: NodeId | null;
  /**
   * 押した場所に合うスコープ。スコープの外を押したときは、スコープの祖先のうち押した場所を
   * 含むもの (なければ null) になる。ページ直下の frame まで出たときは null にする
   */
  scopeId: NodeId | null;
}

/**
 * 押した場所に合うスコープ。スコープとその祖先 (内側から) のうち、
 * - 道に入っているもの (押した所がその中のノードか、frame の中の何もない場所)
 * - group かブーリアンで、押した所がその外接矩形の中の何もない場所 (道がスコープの祖先だけか、何もない)
 * の最も内側のもの。ページ直下の frame まで出たら、ページ直下 (null) として扱う。
 */
function effectiveScope(
  doc: CanvasDocument,
  path: readonly NodeId[] | null,
  scopeId: NodeId | null,
  point: Point | undefined,
): NodeId | null {
  if (scopeId === null) return null;
  if (path?.includes(scopeId)) return scopeId;
  const chain = [scopeId, ...getAncestors(doc, scopeId).map((ancestor) => ancestor.id)];
  // 押した所にスコープの外のノードがなければ、group の外接矩形の中はスコープの中。
  // ページ直下の frame の何もない場所 (道が frame だけ) も何もない場所として扱う
  const empty =
    !path ||
    path.every((id) => chain.includes(id)) ||
    (path.length === 1 && isTopLevelFrame(doc, path[0] as NodeId));
  for (const id of chain) {
    if (path?.includes(id)) return isTopLevelFrame(doc, id) ? null : id;
    const node = getNode(doc, id);
    if (empty && point && node && isGroupLike(node)) {
      const bounds = getPageBounds(doc, id);
      if (bounds && rectContainsPoint(bounds, point)) return id;
    }
  }
  return null;
}

/**
 * `hitTestPath` の道から、クリックで選ぶノードを決める (§4.5)。
 *
 * - ページ直下の frame の中の何もない場所は選ばない (null)。frame の子は直接選べる
 * - group・ブーリアンと入れ子の frame は、スコープの外からは全体が選ばれる (ダブルクリックで中へ)
 * - スコープの中では、スコープの子を選ぶ。スコープの中の何もない場所は null
 *   (group のスコープは外接矩形の中がスコープの中。`point` を渡す)
 * - `deep` (Cmd/Ctrl) はいちばん深いノード
 * - それ以外で、道に選択済みのノードがあれば、その最も深いものを選ぶ
 */
export function pickTarget(
  doc: CanvasDocument,
  path: readonly NodeId[] | null,
  scopeId: NodeId | null,
  options: PickOptions = {},
): PickResult {
  const scope = effectiveScope(doc, path, scopeId, options.point);
  if (!path || path.length === 0) return { id: null, scopeId: scope };
  const last = path[path.length - 1] as NodeId;
  const emptyArea = (id: NodeId) => id === scope || (path.length === 1 && isTopLevelFrame(doc, id));

  if (options.deep) return { id: emptyArea(last) ? null : last, scopeId: scope };

  if (options.selection && options.selection.size > 0) {
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i] as NodeId;
      if (options.selection.has(id) && !emptyArea(id)) return { id, scopeId: scope };
    }
  }

  if (scope !== null) {
    const index = path.indexOf(scope);
    return { id: index < 0 ? null : (path[index + 1] ?? null), scopeId: scope };
  }
  const top = path[0] as NodeId;
  if (isTopLevelFrame(doc, top)) return { id: path[1] ?? null, scopeId: null };
  return { id: top, scopeId: null };
}

/**
 * ダブルクリックで中に入れるノードか (group・ブーリアンと、ページ直下でない frame)。
 * ページ直下の frame の子は最初から直接選べるので、ページ直下の frame には入らない。
 */
export function canEnter(doc: CanvasDocument, id: NodeId): boolean {
  const node = getNode(doc, id);
  if (!node) return false;
  if (isGroupLike(node)) return node.children.length > 0;
  return node.type === "frame" && !isTopLevelFrame(doc, id);
}
