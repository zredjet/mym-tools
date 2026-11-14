/**
 * 木の変更 (挿入、削除、複製、重なり順、親の付け替え、グループ化)。
 * すべて純関数で、変わらなければ引数の文書をそのまま返す。
 * 上限 (`maxDepth` / `maxNodes`) を超える変更は行わず、元の文書を返す。
 */
import { createGroup } from "./create";
import { DocDraft } from "./draft";
import { parentOrigin } from "./geometry";
import { createId } from "./ids";
import { CANVAS_LIMITS } from "./limits";
import { translateInDraft } from "./transform";
import {
  getDepth,
  getDescendantIds,
  getParent,
  isAncestorOf,
  isContainer,
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
  const node = doc.nodes[parent.id];
  return node !== undefined && isContainer(node) && getDepth(doc, node.id) > 0;
}

/** ノードを根とする部分木の高さ (葉は 1)。 */
export function subtreeHeight(nodes: Record<NodeId, CanvasNode>, id: NodeId): number {
  const node = nodes[id];
  if (!node || !isContainer(node) || node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map((child) => subtreeHeight(nodes, child)));
}

/** 空になった group を消し、空になった親の group も続けて消す (§3.3: group は子が 1 個以上)。 */
function removeEmptyGroups(draft: DocDraft, candidates: Iterable<ParentRef | null>): void {
  for (const parent of candidates) {
    let current = parent;
    while (current?.kind === "node") {
      const node = draft.get(current.id);
      if (!node || node.type !== "group" || node.children.length > 0) break;
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
 */
export function insertNode(
  doc: CanvasDocument,
  node: CanvasNode,
  parent: ParentRef,
  index?: number,
): CanvasDocument {
  if (doc.nodes[node.id] !== undefined || !parentExists(doc, parent)) return doc;
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
    const node = source[id];
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
 * ノードを子孫ごと複製し、それぞれ元のすぐ前面に置く。`offset` だけずらす。
 * Alt を押しながらの移動はずらさずに複製してから動かす。
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
    translateInDraft(draft, copyId, offset.x, offset.y);
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
 * ノードを `target` の子にする (レイヤーパネルの並べ替え、frame への出し入れ)。
 * 見た目の位置が変わらないように、座標系の原点の差だけ座標を直す。
 *
 * `index` は付け替える前の `target.children` の位置で、その位置にある子の背面に入れる
 * (省略すると最前面)。選んだノードの相対順は保つ。自分の子孫の中へは動かせず、
 * 深さが `maxDepth` を超える場合は何もしない。
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
  const depth = parentDepth(doc, target);
  if (tops.some((id) => depth + subtreeHeight(doc.nodes, id) > CANVAS_LIMITS.maxDepth)) return doc;

  const moving = new Set(tops);
  // 原点は元の文書で求める (target とその祖先は動かないので、付け替えの前後で変わらない)
  const targetOrigin = parentOrigin(doc, target);
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
    if (!sameParent(parent, target) && parent) {
      const from = parentOrigin(doc, parent);
      translateInDraft(draft, id, from.x - targetOrigin.x, from.y - targetOrigin.y);
    }
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
 * ほかの親にあるノードは、見た目の位置を保ったままその親へ移す。
 * `groupId` を渡しておくと、呼び出し側がその ID で選択し直せる。
 */
export function groupNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  groupId: NodeId = createId(doc.nodes),
  init: Partial<Omit<GroupNode, "type" | "id" | "children">> = {},
): CanvasDocument {
  const tops = topLevelIds(doc, ids);
  const front = tops[tops.length - 1];
  if (front === undefined || doc.nodes[groupId] !== undefined) return doc;
  const target = getParent(doc, front);
  if (!target) return doc;
  if (Object.keys(doc.nodes).length + 1 > CANVAS_LIMITS.maxNodes) return doc;
  const depth = parentDepth(doc, target);
  if (tops.some((id) => depth + 1 + subtreeHeight(doc.nodes, id) > CANVAS_LIMITS.maxDepth))
    return doc;

  const draft = new DocDraft(doc);
  const targetOrigin = parentOrigin(doc, target);
  const siblings = draft.children(target);
  const frontIndex = siblings.indexOf(front);
  const at = frontIndex - siblings.slice(0, frontIndex).filter((id) => tops.includes(id)).length;

  const oldParents: (ParentRef | null)[] = [];
  for (const id of tops) {
    const parent = getParent(doc, id);
    oldParents.push(parent);
    if (parent && !sameParent(parent, target)) {
      const from = parentOrigin(doc, parent);
      translateInDraft(draft, id, from.x - targetOrigin.x, from.y - targetOrigin.y);
    }
    draft.detach(id);
  }
  draft.set(createGroup(tops, { ...init, id: groupId }));
  draft.attach(groupId, target, at);
  removeEmptyGroups(draft, oldParents);
  return draft.finish();
}

/**
 * group を解除し、子を group があった位置に並べる (座標はそのまま。group は座標系を作らない)。
 * 見た目を保つため、group の不透明度は子に掛け合わせ、非表示の group の子は非表示にする。
 * group でない ID は無視する。入れ子の group を同時に解除するときは内側から解く。
 */
export function ungroupNodes(doc: CanvasDocument, ids: readonly NodeId[]): CanvasDocument {
  const groups = [...new Set(ids)]
    .filter((id) => doc.nodes[id]?.type === "group")
    .sort((a, b) => getDepth(doc, b) - getDepth(doc, a));
  if (groups.length === 0) return doc;
  const draft = new DocDraft(doc);
  for (const id of groups) {
    const group = draft.get(id);
    const parent = draft.parentOf(id);
    if (!group || group.type !== "group" || !parent) continue;
    for (const childId of group.children) {
      const child = draft.get(childId);
      if (!child) continue;
      const opacity = child.opacity * group.opacity;
      const visible = child.visible && group.visible;
      if (opacity !== child.opacity || visible !== child.visible)
        draft.set({ ...child, opacity, visible });
    }
    const siblings = [...draft.children(parent)];
    const at = siblings.indexOf(id);
    siblings.splice(at, 1, ...group.children);
    draft.setChildren(parent, siblings);
    draft.remove(id);
  }
  return draft.finish();
}
