/**
 * ヒットテスト (§4.5)。文書の幾何だけから求める純関数で、DOM (`elementFromPoint`) には頼らない。
 *
 * 2 段に分ける。
 * 1. `hitTestPath`: 点の下にある前面のノードを、ページ直下から当たったノードまでの道として返す
 * 2. `pickTarget`: その道とスコープ・修飾キーから、選ぶノードを決める
 *
 * ページ直下の frame の名前のラベルは `hitFrameLabel` で別に調べる (ラベルは文書より前面に描く)。
 */
import { frameLabelRect } from "../canvas/frameLabels";
import { getPageBounds, rectContainsPoint, type Rect } from "../model/geometry";
import { getAncestors, getNode, getPage, getParent } from "../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, PageId, Point } from "../model/types";
import type { TextMeasurer } from "../render/types";
import { distanceToSegment, ellipseDistance, roundedRectDistance } from "./shapes";

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
 * 図形の当たり。`d` は輪郭からの符号付き距離 (内側が負)。
 * 塗りがあれば内側と線の外側の半分、なければ線の上だけ (線の太さ + 余裕の帯)。
 * 線のない図形は太さ 0 の線として扱う (輪郭の近くを押せば当たる)。
 */
function shapeHit(d: number, hasFill: boolean, strokeWidth: number, slop: number): boolean {
  if (hasFill && d <= strokeWidth / 2) return true;
  return Math.abs(d) <= (strokeWidth + slop) / 2;
}

function boxOf(node: { x: number; y: number; width: number; height: number }, origin: Point): Rect {
  return { x: origin.x + node.x, y: origin.y + node.y, width: node.width, height: node.height };
}

/** 葉 (frame / group 以外) が点に当たるか。 */
function leafHit(node: CanvasNode, origin: Point, p: Point, slop: number): boolean {
  switch (node.type) {
    case "line": {
      const a = { x: origin.x + node.x1, y: origin.y + node.y1 };
      const b = { x: origin.x + node.x2, y: origin.y + node.y2 };
      return distanceToSegment(p, a, b) <= (node.stroke.width + slop) / 2;
    }
    case "rect": {
      const d = roundedRectDistance(p, boxOf(node, origin), node.radius);
      return shapeHit(d, node.fill !== null, node.stroke?.width ?? 0, slop);
    }
    case "ellipse": {
      const d = ellipseDistance(p, boxOf(node, origin));
      return shapeHit(d, node.fill !== null, node.stroke?.width ?? 0, slop);
    }
    case "image":
      return roundedRectDistance(p, boxOf(node, origin), node.radius) <= 0;
    // テキストと埋め込み SVG は枠の中が当たる
    case "text":
    case "svg":
      return roundedRectDistance(p, boxOf(node, origin), 0) <= 0;
    default:
      return false;
  }
}

/**
 * ノード (子を含む) が点に当たれば、そのノードから当たったノードまでの道を返す。
 * frame は子を先に調べ (子は frame の前面)、子に当たらなければ frame の矩形の中が当たる。
 * 子を切り抜く frame の外では子に当たらない。
 */
function hitNode(
  doc: CanvasDocument,
  node: CanvasNode,
  origin: Point,
  p: Point,
  slop: number,
  depth: number,
): NodeId[] | null {
  if (!node.visible || node.locked) return null;
  if (node.type === "group") {
    if (depth > 64) return null; // 壊れた文書の循環で止まるように
    const child = hitChildren(doc, node.children, origin, p, slop, depth + 1);
    return child ? [node.id, ...child] : null;
  }
  if (node.type !== "frame") return leafHit(node, origin, p, slop) ? [node.id] : null;
  const rect = boxOf(node, origin);
  const d = roundedRectDistance(p, rect, node.radius);
  if (depth <= 64 && !(node.clip && d > 0)) {
    const child = hitChildren(doc, node.children, { x: rect.x, y: rect.y }, p, slop, depth + 1);
    if (child) return [node.id, ...child];
  }
  return d <= (node.stroke?.width ?? 0) / 2 ? [node.id] : null;
}

function hitChildren(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  origin: Point,
  p: Point,
  slop: number,
  depth: number,
): NodeId[] | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const node = getNode(doc, ids[i] as NodeId);
    if (!node) continue;
    const path = hitNode(doc, node, origin, p, slop, depth);
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
 */
export function hitTestPath(
  doc: CanvasDocument,
  pageId: PageId,
  point: Point,
  zoom: number,
): NodeId[] | null {
  const page = getPage(doc, pageId);
  if (!page) return null;
  return hitChildren(doc, page.children, { x: 0, y: 0 }, point, STROKE_HIT_SLOP / zoom, 1);
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
 * - group で、押した所がその外接矩形の中の何もない場所 (道がスコープの祖先だけか、何もない)
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
  // 押した所にスコープの外のノードがなければ、group の外接矩形の中はスコープの中
  const empty = !path || path.every((id) => chain.includes(id));
  for (const id of chain) {
    if (path?.includes(id)) return isTopLevelFrame(doc, id) ? null : id;
    if (empty && point && getNode(doc, id)?.type === "group") {
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
 * - group と入れ子の frame は、スコープの外からは全体が選ばれる (ダブルクリックで中へ)
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
 * ダブルクリックで中に入れるノードか (group と、ページ直下でない frame)。
 * ページ直下の frame の子は最初から直接選べるので、ページ直下の frame には入らない。
 */
export function canEnter(doc: CanvasDocument, id: NodeId): boolean {
  const node = getNode(doc, id);
  if (!node) return false;
  if (node.type === "group") return node.children.length > 0;
  return node.type === "frame" && !isTopLevelFrame(doc, id);
}
