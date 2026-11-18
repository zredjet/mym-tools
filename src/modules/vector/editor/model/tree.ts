/**
 * 木の参照。文書は平たい `nodes` と `children` で木を表す (§3.1) ので、親は索引を作って引く。
 * 索引は文書のオブジェクトをキーに WeakMap で使い回す (文書は書き換えない前提なので安全)。
 *
 * 子を持つノードは frame・group・ブーリアン (`isContainer`)。そのうち座標系を作るのは frame だけで、
 * group とブーリアンは「座標系を作らない入れ物」(`isGroupLike`。子は自分の親の座標系で持つ、§8.3.1、§8.9.1)。
 * group だけを見ていた判定 (中に入れるか、移動、範囲選択、画面外の判定、コマンドなど) は `isGroupLike` を使う。
 *
 * E・F・G が使うもの:
 * - `isContainer(node)`: 子を持つノード (frame / group / ブーリアン) か
 * - `isGroupLike(node)`: 座標系を作らない入れ物 (group / ブーリアン) か
 * - `canBeBooleanChild(type)` / `BOOLEAN_CHILD_TYPES`: ブーリアンの子にできる種類か (rect / ellipse / path / boolean)
 * - `canHaveChildOfType(doc, parent, type)`: 親 (ページ / frame / group / ブーリアン) がその種類の子を持てるか
 * - `insertionParent(doc, parent, types)`: 親がブーリアンで、子にできない種類が混ざるなら、ブーリアンの外の
 *   最も近い親 (§8.9.1 の「ブーリアンの親に置く」)
 * - `outsideBooleans(doc, parent)`: ブーリアンの外の最も近い親 (作成ツール・ペン・取込の親)
 */
import { hasOwn } from "./ids";
import type {
  BooleanNode,
  CanvasDocument,
  CanvasNode,
  FrameNode,
  GroupNode,
  NodeId,
  NodeType,
  Page,
  PageId,
} from "./types";

/** 子を持つノード (frame / group / ブーリアン)。 */
export type ParentNode = FrameNode | GroupNode | BooleanNode;

/** 座標系を作らない入れ物 (group / ブーリアン)。子は自分の親の座標系で持つ。 */
export type GroupLikeNode = GroupNode | BooleanNode;

/** ノードの親。ページ直下ならページ、そうでなければ frame か group かブーリアン。 */
export type ParentRef = { kind: "page"; id: PageId } | { kind: "node"; id: NodeId };

interface ParentEntry {
  parent: ParentRef;
  /** 親の `children` の中の位置 */
  index: number;
  pageId: PageId;
  /** ページ直下を 1 とする深さ */
  depth: number;
}

const indexCache = new WeakMap<CanvasDocument, Map<NodeId, ParentEntry>>();

function buildIndex(doc: CanvasDocument): Map<NodeId, ParentEntry> {
  const index = new Map<NodeId, ParentEntry>();
  for (const page of doc.pages) {
    const visit = (ids: readonly NodeId[], parent: ParentRef, depth: number) => {
      ids.forEach((id, i) => {
        if (index.has(id)) return; // 壊れた文書でも止まらないように (検証は validate.ts の役目)
        index.set(id, { parent, index: i, pageId: page.id, depth });
        const node = getNode(doc, id);
        if (node && isContainer(node)) visit(node.children, { kind: "node", id }, depth + 1);
      });
    };
    visit(page.children, { kind: "page", id: page.id }, 1);
  }
  return index;
}

function entryOf(doc: CanvasDocument, id: NodeId): ParentEntry | undefined {
  let index = indexCache.get(doc);
  if (!index) {
    index = buildIndex(doc);
    indexCache.set(doc, index);
  }
  return index.get(id);
}

/** 子を持つノード (frame / group / ブーリアン) か。 */
export function isContainer(node: CanvasNode): node is ParentNode {
  return node.type === "frame" || node.type === "group" || node.type === "boolean";
}

/** 座標系を作らない入れ物 (group / ブーリアン) か。 */
export function isGroupLike(node: CanvasNode): node is GroupLikeNode {
  return node.type === "group" || node.type === "boolean";
}

/** ブーリアンの子にできる種類 (§8.3.2、§8.9.1)。 */
export const BOOLEAN_CHILD_TYPES: readonly NodeType[] = ["rect", "ellipse", "path", "boolean"];

/** ブーリアンの子にできる種類か。 */
export function canBeBooleanChild(type: NodeType): boolean {
  return BOOLEAN_CHILD_TYPES.includes(type);
}

/**
 * 親がその種類の子を持てるか。ページ・frame・group は何でも、ブーリアンは `canBeBooleanChild` の種類だけ。
 * 子を持たないノードや見つからない親は false。
 */
export function canHaveChildOfType(
  doc: CanvasDocument,
  parent: ParentRef,
  type: NodeType,
): boolean {
  if (parent.kind === "page") return true;
  const node = getNode(doc, parent.id);
  if (!node || !isContainer(node)) return false;
  return node.type !== "boolean" || canBeBooleanChild(type);
}

/**
 * ブーリアンの外の最も近い親。`parent` がブーリアン (の中) なら、祖先のブーリアンも越えて出る。
 * 作成ツール・ペン・取込の親に使う (§8.9.1)。
 */
export function outsideBooleans(doc: CanvasDocument, parent: ParentRef): ParentRef {
  let current = parent;
  for (let guard = 0; guard < 1000 && current.kind === "node"; guard++) {
    if (getNode(doc, current.id)?.type !== "boolean") return current;
    const up = getParent(doc, current.id);
    if (!up) return current;
    current = up;
  }
  return current;
}

/**
 * `types` の種類のノードを入れる親。`parent` がブーリアンで、子にできない種類が混ざるなら、
 * ブーリアンの外の最も近い親 (祖先のブーリアンも越える) にする。そうでなければ `parent` のまま。
 */
export function insertionParent(
  doc: CanvasDocument,
  parent: ParentRef,
  types: Iterable<NodeType>,
): ParentRef {
  const list = [...types];
  let current = parent;
  for (let guard = 0; guard < 1000 && current.kind === "node"; guard++) {
    const node = getNode(doc, current.id);
    if (node?.type !== "boolean" || list.every(canBeBooleanChild)) return current;
    const up = getParent(doc, current.id);
    if (!up) return current;
    current = up;
  }
  return current;
}

/** ノードを引く。`toString` のような ID で `Object.prototype` のものを拾わない。 */
export function getNode(doc: CanvasDocument, id: NodeId): CanvasNode | undefined {
  return hasOwn(doc.nodes, id) ? doc.nodes[id] : undefined;
}

export function getPage(doc: CanvasDocument, pageId: PageId): Page | undefined {
  return doc.pages.find((page) => page.id === pageId);
}

/** ノードの親。木に入っていなければ null。 */
export function getParent(doc: CanvasDocument, id: NodeId): ParentRef | null {
  return entryOf(doc, id)?.parent ?? null;
}

/** 親が frame / group / ブーリアンならそのノード、ページ直下か木に入っていなければ null。 */
export function getParentNode(doc: CanvasDocument, id: NodeId): ParentNode | null {
  const parent = getParent(doc, id);
  if (parent?.kind !== "node") return null;
  const node = getNode(doc, parent.id);
  return node && isContainer(node) ? node : null;
}

/** 親の `children` の中の位置。木に入っていなければ -1。 */
export function getIndexInParent(doc: CanvasDocument, id: NodeId): number {
  return entryOf(doc, id)?.index ?? -1;
}

/** ページ直下を 1 とする深さ。木に入っていなければ 0。 */
export function getDepth(doc: CanvasDocument, id: NodeId): number {
  return entryOf(doc, id)?.depth ?? 0;
}

/** ノードが属するページ。 */
export function getPageOf(doc: CanvasDocument, id: NodeId): Page | null {
  const pageId = entryOf(doc, id)?.pageId;
  return pageId === undefined ? null : (getPage(doc, pageId) ?? null);
}

/** 親の `children`。ページかノードが見つからなければ空配列。 */
export function getChildren(doc: CanvasDocument, parent: ParentRef): readonly NodeId[] {
  if (parent.kind === "page") return getPage(doc, parent.id)?.children ?? [];
  const node = getNode(doc, parent.id);
  return node && isContainer(node) ? node.children : [];
}

export function sameParent(a: ParentRef | null, b: ParentRef | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.id === b.id;
}

/** 祖先の frame / group / ブーリアンを近い順に返す (ページは含まない)。 */
export function getAncestors(doc: CanvasDocument, id: NodeId): ParentNode[] {
  const result: ParentNode[] = [];
  let current = getParentNode(doc, id);
  while (current) {
    result.push(current);
    current = getParentNode(doc, current.id);
  }
  return result;
}

/** `ancestorId` が `id` の祖先 (自分自身は含まない) か。 */
export function isAncestorOf(doc: CanvasDocument, ancestorId: NodeId, id: NodeId): boolean {
  return getAncestors(doc, id).some((node) => node.id === ancestorId);
}

/**
 * 座標系を作る最も近い祖先の frame。group とブーリアンは座標系を作らない (§3.2、§8.3.1) ので飛ばす。
 * null ならページ座標。
 */
export function getCoordinateFrame(doc: CanvasDocument, id: NodeId): FrameNode | null {
  for (const ancestor of getAncestors(doc, id)) if (ancestor.type === "frame") return ancestor;
  return null;
}

/** 子孫の ID を深さ優先・重なり順 (背面から) で返す。自分は含まない。 */
export function getDescendantIds(doc: CanvasDocument, id: NodeId): NodeId[] {
  const result: NodeId[] = [];
  const seen = new Set<NodeId>([id]); // 壊れた文書 (子が祖先を指す) でも止まるように
  const visit = (nodeId: NodeId) => {
    const node = getNode(doc, nodeId);
    if (!node || !isContainer(node)) return;
    for (const child of node.children) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      visit(child);
    }
  };
  visit(id);
  return result;
}

/** `walkPage` の訪問関数が "skip" を返すと、そのノードの子へは進まない。 */
export type WalkResult = void | "skip";

/**
 * ページのノードを深さ優先で、背面から前面の順にたどる (§3.6 の検索用テキストと同じ順)。
 * `depth` はページ直下が 1。同じノードは 1 回しか訪れない (壊れた文書の循環でも止まる)。
 */
export function walkPage(
  doc: CanvasDocument,
  pageId: PageId,
  visit: (node: CanvasNode, depth: number, parent: ParentRef) => WalkResult,
): void {
  const page = getPage(doc, pageId);
  if (!page) return;
  const seen = new Set<NodeId>();
  const go = (ids: readonly NodeId[], parent: ParentRef, depth: number) => {
    for (const id of ids) {
      const node = getNode(doc, id);
      if (!node || seen.has(id)) continue;
      seen.add(id);
      if (visit(node, depth, parent) === "skip") continue;
      if (isContainer(node)) go(node.children, { kind: "node", id }, depth + 1);
    }
  };
  go(page.children, { kind: "page", id: page.id }, 1);
}

/** ページのノードの ID を `walkPage` の順で返す。 */
export function listPageNodeIds(doc: CanvasDocument, pageId: PageId): NodeId[] {
  const result: NodeId[] = [];
  walkPage(doc, pageId, (node) => {
    result.push(node.id);
  });
  return result;
}

/**
 * 文書全体での重なり順の比較用の鍵 (ページの順 → 木の深さ優先の順)。
 * 小さいほど背面。木に入っていないノードは Infinity。
 */
function orderKeys(doc: CanvasDocument): Map<NodeId, number> {
  const keys = new Map<NodeId, number>();
  let n = 0;
  for (const page of doc.pages)
    walkPage(doc, page.id, (node) => {
      keys.set(node.id, n++);
    });
  return keys;
}

/** ID を重なり順 (背面が先) に並べ替える。存在しない ID と重複は除く。 */
export function sortByZOrder(doc: CanvasDocument, ids: readonly NodeId[]): NodeId[] {
  const keys = orderKeys(doc);
  return [...new Set(ids)]
    .filter((id) => keys.has(id))
    .sort((a, b) => (keys.get(a) ?? 0) - (keys.get(b) ?? 0));
}

/**
 * 選択から、祖先も選ばれているノードを除き、重なり順 (背面が先) に並べる。
 * 移動・削除・コピーなど、選択をまとめて扱う操作の入口で使う。
 */
export function topLevelIds(doc: CanvasDocument, ids: readonly NodeId[]): NodeId[] {
  const set = new Set(ids.filter((id) => getNode(doc, id) !== undefined));
  return sortByZOrder(
    doc,
    [...set].filter((id) => !getAncestors(doc, id).some((ancestor) => set.has(ancestor.id))),
  );
}
