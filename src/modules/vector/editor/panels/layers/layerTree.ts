/**
 * レイヤーパネルの木 (純関数)。表示する行の並びと、ドラッグで落とした先の計算。
 * 重なり順は `children` の配列の順 (先頭が最背面) なので、パネルでは逆順に並べて前面を上にする。
 */
import { moveNodes } from "../../model/structure";
import {
  getIndexInParent,
  getNode,
  getPage,
  getParent,
  isAncestorOf,
  isContainer,
  type ParentRef,
} from "../../model/tree";
import type { CanvasDocument, NodeId, PageId } from "../../model/types";
import { geometryWithinLimits } from "../limits";

export interface LayerRow {
  id: NodeId;
  /** ページ直下を 0 とする字下げの段 */
  depth: number;
  /** frame か group */
  container: boolean;
  hasChildren: boolean;
  /** 開いていて子の行が続く */
  expanded: boolean;
}

/**
 * 表示中のページの行を、前面のノードを上にして並べる。閉じた frame / group の子は出さない。
 * 子のない frame は開閉の対象にしない。
 */
export function buildLayerRows(
  doc: CanvasDocument,
  pageId: PageId,
  collapsed: ReadonlySet<NodeId>,
): LayerRow[] {
  const page = getPage(doc, pageId);
  if (!page) return [];
  const rows: LayerRow[] = [];
  const seen = new Set<NodeId>();
  const visit = (ids: readonly NodeId[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i] as NodeId;
      const node = getNode(doc, id);
      if (!node || seen.has(id)) continue;
      seen.add(id);
      const container = isContainer(node);
      const hasChildren = container && node.children.length > 0;
      const expanded = hasChildren && !collapsed.has(id);
      rows.push({ id, depth, container, hasChildren, expanded });
      if (expanded && container) visit(node.children, depth + 1);
    }
  };
  visit(page.children, 0);
  return rows;
}

/** 行の並びを比べるための文字列。ノードの位置や色が変わっても変わらない。 */
export function layerRowsKey(rows: readonly LayerRow[]): string {
  return rows
    .map(
      (row) =>
        `${row.id}:${row.depth}:${row.container ? 1 : 0}${row.hasChildren ? 1 : 0}${row.expanded ? 1 : 0}`,
    )
    .join(",");
}

/** ID の文字列から行を作り直す (`layerRowsKey` の逆)。 */
export function parseLayerRowsKey(key: string): LayerRow[] {
  if (key === "") return [];
  return key.split(",").map((part) => {
    const [id = "", depth = "0", flags = "000"] = part.split(":");
    return {
      id,
      depth: Number(depth),
      container: flags[0] === "1",
      hasChildren: flags[1] === "1",
      expanded: flags[2] === "1",
    };
  });
}

/**
 * 行の並びの文字列を、文書と閉じた行の組ごとに 1 回だけ求める。
 * store の購読はどの変更でも selector を呼ぶ (パンやホバーでも) ので、同じ文書なら求め直さない。
 */
const keyCache = new WeakMap<
  CanvasDocument,
  { pageId: PageId; collapsed: ReadonlySet<NodeId>; key: string }
>();

export function cachedLayerRowsKey(
  doc: CanvasDocument,
  pageId: PageId,
  collapsed: ReadonlySet<NodeId>,
): string {
  const hit = keyCache.get(doc);
  if (hit && hit.pageId === pageId && hit.collapsed === collapsed) return hit.key;
  const key = layerRowsKey(buildLayerRows(doc, pageId, collapsed));
  keyCache.set(doc, { pageId, collapsed, key });
  return key;
}

/**
 * 行の上での落とす位置。`before` は行の上 (そのノードの前面)、`after` は行の下 (背面)、
 * `inside` は frame / group の中 (最前面)。
 */
export type DropZone = "before" | "after" | "inside";

/**
 * 行の中のポインターの位置 (上端 0、下端 1) から落とす位置を決める。
 * frame / group は上下 1/4 ずつを前後、中央の半分を中とする。ほかは上半分と下半分。
 */
export function dropZoneAt(ratio: number, container: boolean): DropZone {
  if (!container) return ratio < 0.5 ? "before" : "after";
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

export interface LayerDrop {
  /** 入れる先の親 */
  target: ParentRef;
  /** `moveNodes` に渡す位置 (付け替える前の `target.children` の位置)。undefined は最前面 */
  index: number | undefined;
  /** 表示に使う位置。開いた frame / group の下半分は、その中の最前面になる */
  zone: DropZone;
}

/**
 * ドラッグしたノードを、行 `overId` の `zone` に落としたときの親と位置。
 * 落とせないとき (自分自身や子孫の上、中に入れられないノードの中) は null。
 *
 * - `before` (行の上): その行のノードのすぐ前面 → 親の `children` の `index + 1`
 * - `after` (行の下): すぐ背面 → `index`。ただし開いていて子のある frame / group の下は、
 *   すぐ下の行がその最前面の子なので、中の最前面に入れる
 * - `inside`: frame / group の中の最前面
 */
export function resolveLayerDrop(
  doc: CanvasDocument,
  draggedIds: readonly NodeId[],
  overId: NodeId,
  zone: DropZone,
  overExpanded: boolean,
): LayerDrop | null {
  const over = getNode(doc, overId);
  if (!over) return null;
  if (draggedIds.includes(overId)) return null;
  if (draggedIds.some((id) => isAncestorOf(doc, id, overId))) return null;
  const intoContainer =
    zone === "inside" ||
    (zone === "after" && overExpanded && isContainer(over) && over.children.length > 0);
  if (intoContainer) {
    if (!isContainer(over)) return null;
    return { target: { kind: "node", id: overId }, index: undefined, zone: "inside" };
  }
  const parent = getParent(doc, overId);
  if (!parent) return null;
  const index = getIndexInParent(doc, overId);
  return { target: parent, index: zone === "before" ? index + 1 : index, zone };
}

/**
 * 落とした結果の文書。見た目の位置は `moveNodes` が保つ。
 * 座標系が変わると親の座標系での値が §3.5 の範囲を超えることがあり、そのときは落とさない
 * (元の文書を返す。超えた文書は保存の検証で拒否されるため)。
 */
export function applyLayerDrop(
  doc: CanvasDocument,
  draggedIds: readonly NodeId[],
  drop: LayerDrop,
): CanvasDocument {
  const next = moveNodes(doc, draggedIds, drop.target, drop.index);
  return next !== doc && !geometryWithinLimits(next, draggedIds) ? doc : next;
}

/** Shift を押しながらのクリック: 行の並びで `anchorId` から `id` までの ID。 */
export function rangeBetween(rows: readonly LayerRow[], anchorId: NodeId, id: NodeId): NodeId[] {
  const from = rows.findIndex((row) => row.id === anchorId);
  const to = rows.findIndex((row) => row.id === id);
  if (from < 0 || to < 0) return [id];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return rows.slice(start, end + 1).map((row) => row.id);
}

/** 選んだノードが見えるように開く行 (閉じた祖先)。開く必要がなければ同じ集合を返す。 */
export function expandForSelection(
  doc: CanvasDocument,
  selection: readonly NodeId[],
  collapsed: ReadonlySet<NodeId>,
): ReadonlySet<NodeId> {
  if (collapsed.size === 0) return collapsed;
  let next: Set<NodeId> | null = null;
  for (const id of selection) {
    let parent = getParent(doc, id);
    while (parent?.kind === "node") {
      if (collapsed.has(parent.id)) {
        next ??= new Set(collapsed);
        next.delete(parent.id);
      }
      parent = getParent(doc, parent.id);
    }
  }
  return next ?? collapsed;
}
