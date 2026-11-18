/**
 * 木の変更 (挿入、削除、複製、重なり順、親の付け替え、グループ化)。
 * すべて純関数で、変わらなければ引数の文書をそのまま返す。
 * 上限 (`maxDepth` / `maxNodes`) を超える変更は行わず、元の文書を返す。
 *
 * ブーリアンの木の規則 (§8.9.1): ブーリアンの子は 1 個以上で、種類は rect / ellipse / path / boolean だけ。
 * - 挿入・断片の挿入・親の付け替え (レイヤーパネルの並べ替え) は、子にできない種類をブーリアンに入れない (何もしない)
 * - グループ化は、group を置く先がブーリアンなら何もしない
 * - 子がなくなったブーリアンは、空の group と同じく消す
 * - 解除 (`ungroupNodes`) は group とブーリアンの両方を解く (§8.9.4。子を親へ戻し、不透明度・非表示・ロックを写す)
 *
 * 回転 (§8.5.2): 親を変えるとき (付け替え、グループ化) は、ページ上の見た目を変えない。箱を持つノードは中心を
 * ページ座標で保ち、`rotation` に「元の親のページ上の角度 − 新しい親のページ上の角度」を足す。線は端点を写す
 * (パスの点は変えない)。回転していない座標系の間では、これまでどおり平行移動だけ (第 1 段階と同じ値)。
 */
import { createGroup } from "./create";
import { DocDraft } from "./draft";
import { pageVectorToLocal, parentMatrix } from "./geometry";
import { invert, multiply } from "../geometry/matrix";
import { createId, getOwn } from "./ids";
import { CANVAS_LIMITS } from "./limits";
import { transformInDraft, translateInDraft } from "./transform";
import {
  canHaveChildOfType,
  getDepth,
  getDescendantIds,
  getNode,
  getParent,
  isAncestorOf,
  isContainer,
  isGroupLike,
  sameParent,
  topLevelIds,
  type ParentRef,
} from "./tree";
import type { CanvasDocument, CanvasNode, GroupNode, NodeId, Point } from "./types";

/** 結果の文書と、新しくできたノード (選択し直すときに使う)。 */
export interface DocChange {
  doc: CanvasDocument;
  ids: NodeId[];
}

/** 親の深さ (ページは 0)。 */
export function parentDepth(doc: CanvasDocument, parent: ParentRef): number {
  return parent.kind === "page" ? 0 : getDepth(doc, parent.id);
}

/** 親が実在し、子を持てるか。 */
export function parentExists(doc: CanvasDocument, parent: ParentRef): boolean {
  if (parent.kind === "page") return doc.pages.some((page) => page.id === parent.id);
  const node = getNode(doc, parent.id);
  return node !== undefined && isContainer(node) && getDepth(doc, node.id) > 0;
}

/** ノードを根とする部分木の高さ (葉は 1)。 */
export function subtreeHeight(
  nodes: Record<NodeId, CanvasNode>,
  id: NodeId,
  seen: ReadonlySet<NodeId> = new Set(),
): number {
  const node = getOwn(nodes, id);
  if (!node || !isContainer(node) || node.children.length === 0 || seen.has(id)) return 1;
  const inner = new Set(seen).add(id);
  let max = 0;
  for (const child of node.children) max = Math.max(max, subtreeHeight(nodes, child, inner));
  return 1 + max;
}

/**
 * 空になった group とブーリアンを消し、空になった親の group・ブーリアンも続けて消す
 * (§3.3: group は子が 1 個以上。§8.9.1: ブーリアンも同じ)。
 */
function removeEmptyGroups(draft: DocDraft, candidates: Iterable<ParentRef | null>): void {
  for (const parent of candidates) {
    let current = parent;
    while (current?.kind === "node") {
      const node = draft.get(current.id);
      if (!node || !isGroupLike(node) || node.children.length > 0) break;
      const up = draft.parentOf(node.id);
      draft.detach(node.id);
      draft.remove(node.id);
      current = up;
    }
  }
}

// ---------------------------------------------------------------------------
// 挿入
// ---------------------------------------------------------------------------

/**
 * 子を持たないノード (または子のない frame) を親の `index` (省略すると最前面) に入れる。
 * 座標は親の座標系で渡す (`pageToLocal` で直す)。子を持つものは `insertFragment` を使う。
 * 親がブーリアンで、子にできない種類なら何もしない (§8.9.1)。
 */
export function insertNode(
  doc: CanvasDocument,
  node: CanvasNode,
  parent: ParentRef,
  index?: number,
): CanvasDocument {
  if (getNode(doc, node.id) !== undefined || !parentExists(doc, parent)) return doc;
  if (!canHaveChildOfType(doc, parent, node.type)) return doc;
  if (isContainer(node) && node.children.length > 0) return doc;
  if (parentDepth(doc, parent) + 1 > CANVAS_LIMITS.maxDepth) return doc;
  if (Object.keys(doc.nodes).length + 1 > CANVAS_LIMITS.maxNodes) return doc;
  const draft = new DocDraft(doc);
  draft.set(node);
  draft.attach(node.id, parent, index);
  return draft.finish();
}

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

/** ノードを子孫ごと消す。空になった group も消す。アセットは残す (保存時に `toPayload` が落とす)。 */
export function deleteNodes(doc: CanvasDocument, ids: readonly NodeId[]): CanvasDocument {
  const tops = topLevelIds(doc, ids);
  if (tops.length === 0) return doc;
  const draft = new DocDraft(doc);
  const parents: (ParentRef | null)[] = [];
  for (const id of tops) {
    parents.push(draft.parentOf(id));
    draft.detach(id);
    draft.removeSubtree(id);
  }
  removeEmptyGroups(draft, parents);
  return draft.finish();
}

// ---------------------------------------------------------------------------
// 複製
// ---------------------------------------------------------------------------

/**
 * `source` の部分木を新しい ID で `draft` に写す。根の新しい ID を返す。
 * `source` は別の文書やクリップボードの表でもよい。アセットの ID は `assetMap` で付け替える。
 */
export function cloneSubtreeInto(
  draft: DocDraft,
  source: Record<NodeId, CanvasNode>,
  rootId: NodeId,
  taken: Set<string>,
  assetMap?: ReadonlyMap<string, string>,
): NodeId {
  const visit = (id: NodeId): NodeId => {
    const node = getOwn(source, id);
    if (!node) throw new Error(`node not found: ${id}`);
    let newId = createId();
    while (taken.has(newId) || draft.has(newId)) newId = createId();
    taken.add(newId);
    let copy: CanvasNode;
    if (isContainer(node)) copy = { ...node, id: newId, children: node.children.map(visit) };
    else if (node.type === "image" || node.type === "svg")
      copy = { ...node, id: newId, assetId: assetMap?.get(node.assetId) ?? node.assetId };
    else copy = { ...node, id: newId };
    draft.set(copy);
    return newId;
  };
  return visit(rootId);
}

/**
 * ノードを子孫ごと複製し、それぞれ元のすぐ前面に置く。`offset` (ページ座標のずれ) だけずらす。
 * Alt を押しながらの移動はずらさずに複製してから動かす。ブーリアンの子の複製はブーリアンの中に置く。
 */
export function duplicateNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  offset: Point = { x: 0, y: 0 },
): DocChange {
  const tops = topLevelIds(doc, ids);
  if (tops.length === 0) return { doc, ids: [] };
  const added = tops.reduce((sum, id) => sum + 1 + getDescendantIds(doc, id).length, 0);
  if (Object.keys(doc.nodes).length + added > CANVAS_LIMITS.maxNodes) return { doc, ids: [] };
  const draft = new DocDraft(doc);
  const taken = new Set<string>();
  const result: NodeId[] = [];
  for (const id of tops) {
    const parent = draft.parentOf(id);
    if (!parent) continue;
    const copyId = cloneSubtreeInto(draft, doc.nodes, id, taken);
    const local = pageVectorToLocal(doc, parent, offset);
    translateInDraft(draft, copyId, local.x, local.y);
    draft.attach(copyId, parent, draft.children(parent).indexOf(id) + 1);
    result.push(copyId);
  }
  return { doc: draft.finish(), ids: result };
}

// ---------------------------------------------------------------------------
// 重なり順
// ---------------------------------------------------------------------------

export type ReorderDirection = "forward" | "backward" | "front" | "back";

/**
 * 重なり順を変える。親ごとに、選んだノードの相対順を保ったまま動かす。
 * - forward / backward: 選ばれていない隣の兄弟 1 つを越える (Cmd/Ctrl+] / [)
 * - front / back: 最前面 / 最背面 (] / [)
 */
export function reorderNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  direction: ReorderDirection,
): CanvasDocument {
  const tops = topLevelIds(doc, ids);
  if (tops.length === 0) return doc;
  const draft = new DocDraft(doc);
  const byParent = new Map<string, { parent: ParentRef; ids: Set<NodeId> }>();
  for (const id of tops) {
    const parent = getParent(doc, id);
    if (!parent) continue;
    const key = `${parent.kind}:${parent.id}`;
    const entry = byParent.get(key) ?? { parent, ids: new Set<NodeId>() };
    entry.ids.add(id);
    byParent.set(key, entry);
  }
  for (const { parent, ids: selected } of byParent.values()) {
    const children = [...draft.children(parent)];
    switch (direction) {
      case "front":
        draft.setChildren(parent, [
          ...children.filter((id) => !selected.has(id)),
          ...children.filter((id) => selected.has(id)),
        ]);
        break;
      case "back":
        draft.setChildren(parent, [
          ...children.filter((id) => selected.has(id)),
          ...children.filter((id) => !selected.has(id)),
        ]);
        break;
      case "forward":
        for (let i = children.length - 2; i >= 0; i--) {
          const a = children[i] as NodeId;
          const b = children[i + 1] as NodeId;
          if (selected.has(a) && !selected.has(b)) {
            children[i] = b;
            children[i + 1] = a;
          }
        }
        draft.setChildren(parent, children);
        break;
      case "backward":
        for (let i = 1; i < children.length; i++) {
          const a = children[i - 1] as NodeId;
          const b = children[i] as NodeId;
          if (selected.has(b) && !selected.has(a)) {
            children[i - 1] = b;
            children[i] = a;
          }
        }
        draft.setChildren(parent, children);
        break;
    }
  }
  return draft.finish();
}

// ---------------------------------------------------------------------------
// 親の付け替え
// ---------------------------------------------------------------------------

/** `target` の子にできるか (自分自身や子孫の中へは入れられない)。 */
function canMoveInto(doc: CanvasDocument, id: NodeId, target: ParentRef): boolean {
  if (target.kind === "page") return true;
  return target.id !== id && !isAncestorOf(doc, id, target.id);
}

/**
 * 下書きの中でノードを、元の親の座標系から新しい親の座標系へ写す (見た目の位置を変えない。§8.5.2)。
 * 原点と行列は元の文書で求める (付け替えの前後で、`from` と `to` とその祖先は動かない)。
 */
function relocateInDraft(
  doc: CanvasDocument,
  draft: DocDraft,
  id: NodeId,
  from: ParentRef,
  to: ParentRef,
): void {
  const source = parentMatrix(doc, from);
  const target = parentMatrix(doc, to);
  const back = invert(target);
  if (!back) return;
  const m = multiply(back, source);
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) {
    // 回転していない座標系の間は、原点の差だけ動かす (第 1 段階と同じ計算)
    translateInDraft(draft, id, source.e - target.e, source.f - target.f);
    return;
  }
  transformInDraft(draft, id, m);
}

/**
 * ノードを `target` の子にする (レイヤーパネルの並べ替え、frame への出し入れ)。
 * 見た目の位置が変わらないように、座標系の原点の差だけ座標を直す。
 *
 * `index` は付け替える前の `target.children` の位置で、その位置にある子の背面に入れる
 * (省略すると最前面)。選んだノードの相対順は保つ。自分の子孫の中へは動かせず、
 * 深さが `maxDepth` を超える場合は何もしない。`target` がブーリアンで、子にできない種類が混ざるなら
 * 何もしない (§8.9.1)。回転した frame の間の付け替えは、見た目を保つように回転も写す (§8.5.2)。
 */
export function moveNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  target: ParentRef,
  index?: number,
): CanvasDocument {
  if (!parentExists(doc, target)) return doc;
  const tops = topLevelIds(doc, ids).filter((id) => canMoveInto(doc, id, target));
  if (tops.length === 0) return doc;
  if (
    tops.some((id) => {
      const node = getNode(doc, id);
      return !node || !canHaveChildOfType(doc, target, node.type);
    })
  )
    return doc;
  const depth = parentDepth(doc, target);
  if (tops.some((id) => depth + subtreeHeight(doc.nodes, id) > CANVAS_LIMITS.maxDepth)) return doc;

  const moving = new Set(tops);
  const draft = new DocDraft(doc);
  const children = draft.children(target);
  // 入れる位置の目印: index の位置から前面へ、動かさない最初の子
  let anchor: NodeId | null = null;
  if (index !== undefined)
    for (let i = Math.max(0, index); i < children.length; i++) {
      const child = children[i] as NodeId;
      if (!moving.has(child)) {
        anchor = child;
        break;
      }
    }

  const oldParents: (ParentRef | null)[] = [];
  for (const id of tops) {
    const parent = getParent(doc, id);
    oldParents.push(parent);
    if (!sameParent(parent, target) && parent) relocateInDraft(doc, draft, id, parent, target);
    draft.detach(id);
  }
  const rest = [...draft.children(target)];
  const at = anchor === null ? rest.length : rest.indexOf(anchor);
  rest.splice(at, 0, ...tops);
  draft.setChildren(target, rest);
  removeEmptyGroups(draft, oldParents);
  return draft.finish();
}

// ---------------------------------------------------------------------------
// グループ化
// ---------------------------------------------------------------------------

/**
 * ノードをまとめて group にする。group は最も前面のノードの親の、そのノードがあった位置に置く。
 * ほかの親にあるノードは、見た目の位置を保ったままその親へ移す (回転した frame の間でも見た目を保つ)。
 * `groupId` を渡しておくと、呼び出し側がその ID で選択し直せる。
 * group を置く先がブーリアンなら何もしない (ブーリアンの中ではグループ化できない。§8.9.1)。
 */
export function groupNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  groupId: NodeId = createId(doc.nodes),
  init: Partial<Omit<GroupNode, "type" | "id" | "children">> = {},
): CanvasDocument {
  const tops = topLevelIds(doc, ids);
  const front = tops[tops.length - 1];
  if (front === undefined || getNode(doc, groupId) !== undefined) return doc;
  const target = getParent(doc, front);
  if (!target) return doc;
  if (!canHaveChildOfType(doc, target, "group")) return doc;
  if (Object.keys(doc.nodes).length + 1 > CANVAS_LIMITS.maxNodes) return doc;
  const depth = parentDepth(doc, target);
  if (tops.some((id) => depth + 1 + subtreeHeight(doc.nodes, id) > CANVAS_LIMITS.maxDepth))
    return doc;

  const draft = new DocDraft(doc);
  const siblings = draft.children(target);
  const frontIndex = siblings.indexOf(front);
  const at = frontIndex - siblings.slice(0, frontIndex).filter((id) => tops.includes(id)).length;

  const oldParents: (ParentRef | null)[] = [];
  for (const id of tops) {
    const parent = getParent(doc, id);
    oldParents.push(parent);
    if (parent && !sameParent(parent, target)) relocateInDraft(doc, draft, id, parent, target);
    draft.detach(id);
  }
  draft.set(createGroup(tops, { ...init, id: groupId }));
  draft.attach(groupId, target, at);
  removeEmptyGroups(draft, oldParents);
  return draft.finish();
}

/**
 * group とブーリアンを解除し、子をそれがあった位置に並べる (座標はそのまま。どちらも座標系を作らない)。
 * 見た目と状態を保つため、不透明度は子に掛け合わせ、非表示なら子を非表示に、ロック中なら子をロックにする
 * (§4.6、§8.9.4)。ブーリアンの子は、解除すると自分の塗りで描かれるようになる。
 * group・ブーリアンでない ID は無視する。入れ子を同時に解除するときは内側から解く。
 */
export function ungroupNodes(doc: CanvasDocument, ids: readonly NodeId[]): CanvasDocument {
  const groups = [...new Set(ids)]
    .filter((id) => {
      const node = getNode(doc, id);
      return node !== undefined && isGroupLike(node);
    })
    .sort((a, b) => getDepth(doc, b) - getDepth(doc, a));
  if (groups.length === 0) return doc;
  const draft = new DocDraft(doc);
  for (const id of groups) {
    const group = draft.get(id);
    const parent = draft.parentOf(id);
    if (!group || !isGroupLike(group) || !parent) continue;
    for (const childId of group.children) {
      const child = draft.get(childId);
      if (!child) continue;
      const opacity = child.opacity * group.opacity;
      const visible = child.visible && group.visible;
      const locked = child.locked || group.locked;
      if (opacity !== child.opacity || visible !== child.visible || locked !== child.locked)
        draft.set({ ...child, opacity, visible, locked });
    }
    const siblings = [...draft.children(parent)];
    const at = siblings.indexOf(id);
    siblings.splice(at, 1, ...group.children);
    draft.setChildren(parent, siblings);
    draft.remove(id);
  }
  return draft.finish();
}
