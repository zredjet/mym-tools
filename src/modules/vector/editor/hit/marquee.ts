/**
 * 範囲選択 (§4.5) と、ドロップ先の frame (§4.6) の候補 (純関数)。
 *
 * どちらもドラッグの開始時に候補を 1 回だけ集め (文書はドラッグの間変わらないか、動くのは
 * 選んだノードだけ)、ポインターが動くたびに全ノードを調べ直さない。
 */
import { getPageBounds, rectContains, rectsIntersect, type Rect } from "../model/geometry";
import { getAncestors, getChildren, getNode, getPage, type ParentRef } from "../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, PageId, Point } from "../model/types";
import { isInteractive } from "./hitTest";

/** 2 つの矩形の重なり。重ならなければ null (辺が接するだけなら幅 0 の矩形)。 */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right < x || bottom < y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

// ---------------------------------------------------------------------------
// 範囲選択
// ---------------------------------------------------------------------------

export interface MarqueeCandidate {
  id: NodeId;
  /** ページ座標の外接矩形 (切り抜く frame の中なら、frame の矩形との重なり) */
  bounds: Rect;
  /**
   * ページ直下の frame は、全体が囲まれたときだけ frame 自身を選ぶ。
   * 囲まれていなければ、子 (`children`) のうち重なるものを選ぶ
   */
  children?: MarqueeCandidate[];
}

function frameChildCandidates(doc: CanvasDocument, frameId: NodeId, clip: Rect | null) {
  const result: MarqueeCandidate[] = [];
  for (const id of getChildren(doc, { kind: "node", id: frameId })) {
    const candidate = intersectCandidate(doc, id, clip);
    if (candidate) result.push(candidate);
  }
  return result;
}

function intersectCandidate(
  doc: CanvasDocument,
  id: NodeId,
  clip: Rect | null,
): MarqueeCandidate | null {
  const node = getNode(doc, id);
  if (!node || !node.visible || node.locked) return null;
  const bounds = getPageBounds(doc, id);
  if (!bounds) return null;
  const visible = clip ? intersectRects(bounds, clip) : bounds;
  return visible ? { id, bounds: visible } : null;
}

/**
 * スコープの中で見えている範囲 (ページ座標)。スコープとその祖先のうち、子を切り抜く frame の矩形を
 * すべて掛け合わせたもの (group のスコープでも、外側の frame の切り抜きを見る)。
 * 切り抜く frame がなければ undefined、重なりがなければ null。
 */
function scopeClip(doc: CanvasDocument, scopeId: NodeId): Rect | null | undefined {
  let clip: Rect | undefined;
  for (const id of [scopeId, ...getAncestors(doc, scopeId).map((ancestor) => ancestor.id)]) {
    const node = getNode(doc, id);
    if (node?.type !== "frame" || !node.clip) continue;
    const rect = getPageBounds(doc, id);
    if (!rect) continue;
    const next: Rect | null = clip ? intersectRects(clip, rect) : rect;
    if (!next) return null;
    clip = next;
  }
  return clip;
}

/**
 * 範囲選択の候補。スコープがあればスコープの子、なければページ直下のノードと、
 * ページ直下の frame の子 (frame が囲まれていないときに選ぶ)。非表示とロック中は除く。
 */
export function marqueeCandidates(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId | null,
): MarqueeCandidate[] {
  if (scopeId !== null) {
    if (!isInteractive(doc, scopeId)) return [];
    const clip = scopeClip(doc, scopeId);
    if (clip === null) return []; // すべて切り抜かれて見えない
    const parent: ParentRef = { kind: "node", id: scopeId };
    const result: MarqueeCandidate[] = [];
    for (const id of getChildren(doc, parent)) {
      const candidate = intersectCandidate(doc, id, clip ?? null);
      if (candidate) result.push(candidate);
    }
    return result;
  }
  const page = getPage(doc, pageId);
  if (!page) return [];
  const result: MarqueeCandidate[] = [];
  for (const id of page.children) {
    const node = getNode(doc, id);
    if (!node || !node.visible || node.locked) continue;
    const bounds = getPageBounds(doc, id);
    if (!bounds) continue;
    if (node.type === "frame")
      result.push({
        id,
        bounds,
        children: frameChildCandidates(doc, id, node.clip ? bounds : null),
      });
    else result.push({ id, bounds });
  }
  return result;
}

/** 範囲 (ページ座標) で選ぶノード。候補の順 (背面から) のまま返す。 */
export function marqueeSelect(candidates: readonly MarqueeCandidate[], rect: Rect): NodeId[] {
  const result: NodeId[] = [];
  for (const candidate of candidates) {
    if (candidate.children) {
      // 子は frame からはみ出していることがあるので、frame に重ならなくても調べる
      if (rectContains(rect, candidate.bounds)) result.push(candidate.id);
      else
        for (const child of candidate.children)
          if (rectsIntersect(rect, child.bounds)) result.push(child.id);
    } else if (rectsIntersect(rect, candidate.bounds)) result.push(candidate.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// ドロップ先の frame
// ---------------------------------------------------------------------------

export interface DropFrame {
  id: NodeId;
  /** ページ座標で見えている範囲 (祖先の frame が切り抜く分を除く) */
  rect: Rect;
}

/**
 * ドロップ先になれる frame を、描く順 (背面から前面) に集める。
 * 非表示・ロック中のノードの中と、`exclude` (動かしているノード) の中は除く。
 */
export function dropFrames(
  doc: CanvasDocument,
  pageId: PageId,
  exclude: ReadonlySet<NodeId>,
): DropFrame[] {
  const page = getPage(doc, pageId);
  if (!page) return [];
  const result: DropFrame[] = [];
  const seen = new Set<NodeId>();
  const visit = (ids: readonly NodeId[], origin: Point, clip: Rect | null) => {
    for (const id of ids) {
      const node: CanvasNode | undefined = getNode(doc, id);
      if (!node || seen.has(id) || exclude.has(id) || !node.visible || node.locked) continue;
      seen.add(id);
      if (node.type === "group") visit(node.children, origin, clip);
      else if (node.type === "frame") {
        const rect = {
          x: origin.x + node.x,
          y: origin.y + node.y,
          width: node.width,
          height: node.height,
        };
        const visible = clip ? intersectRects(rect, clip) : rect;
        if (!visible) continue;
        result.push({ id, rect: visible });
        visit(node.children, { x: rect.x, y: rect.y }, node.clip ? visible : clip);
      }
    }
  };
  visit(page.children, { x: 0, y: 0 }, null);
  return result;
}

/** 点の下で最も前面の frame。なければ null (ページ直下)。 */
export function dropTargetAt(frames: readonly DropFrame[], point: Point): NodeId | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const { id, rect } = frames[i] as DropFrame;
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    )
      return id;
  }
  return null;
}
