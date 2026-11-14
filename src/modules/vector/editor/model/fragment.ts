/**
 * 文書の一部を切り出した断片。エディタ内のコピー・貼り付けに使う (§2.3)。
 * 断片は元の文書から独立していて (子孫と参照するアセットを含む)、別の文書にも貼り付けられる。
 */
import { findSameAsset } from "./assets";
import { DocDraft } from "./draft";
import { getSelectionBounds, nodeOrigin, parentOrigin, type Rect } from "./geometry";
import { createId, hasOwn } from "./ids";
import { CANVAS_LIMITS } from "./limits";
import {
  cloneSubtreeInto,
  parentDepth,
  parentExists,
  subtreeHeight,
  type DocChange,
} from "./structure";
import { translateInDraft } from "./transform";
import { getDescendantIds, topLevelIds, type ParentRef } from "./tree";
import type { Asset, AssetId, CanvasDocument, CanvasNode, NodeId, Point } from "./types";

export interface Fragment {
  /** 根のノード (背面が先)。根の座標はページ座標に直してある */
  roots: NodeId[];
  /** 根と子孫 */
  nodes: Record<NodeId, CanvasNode>;
  /** 根と子孫が参照するアセット */
  assets: Record<AssetId, Asset>;
}

/** 断片を、根をページ直下に並べた 1 ページの文書として扱う (model の関数をそのまま使うため)。 */
function fragmentDocument(fragment: Fragment): CanvasDocument {
  return {
    pages: [{ id: "fragment", name: "", children: fragment.roots, guides: [] }],
    nodes: fragment.nodes,
    assets: fragment.assets,
  };
}

/** 選んだノードを子孫とアセットごと切り出す。祖先も選ばれているノードは祖先に含める。 */
export function extractFragment(doc: CanvasDocument, ids: readonly NodeId[]): Fragment | null {
  const roots = topLevelIds(doc, ids);
  if (roots.length === 0) return null;
  const nodes: Record<NodeId, CanvasNode> = {};
  const assets: Record<AssetId, Asset> = {};
  for (const root of roots)
    for (const id of [root, ...getDescendantIds(doc, root)]) {
      const node = doc.nodes[id];
      if (!node) continue;
      nodes[id] = node;
      if ((node.type === "image" || node.type === "svg") && hasOwn(doc.assets, node.assetId))
        assets[node.assetId] = doc.assets[node.assetId] as Asset;
    }
  const draft = new DocDraft(fragmentDocument({ roots, nodes, assets }));
  for (const root of roots) {
    const origin = nodeOrigin(doc, root);
    translateInDraft(draft, root, origin.x, origin.y);
  }
  const placed = draft.finish();
  return { roots, nodes: placed.nodes, assets };
}

/** 断片の外接矩形 (ページ座標)。 */
export function fragmentBounds(fragment: Fragment): Rect | null {
  return getSelectionBounds(fragmentDocument(fragment), fragment.roots);
}

/** 断片のノードの数。 */
export function fragmentSize(fragment: Fragment): number {
  return Object.keys(fragment.nodes).length;
}

export interface InsertFragmentOptions {
  /** 親の `children` の位置 (省略すると最前面) */
  index?: number;
  /** ページ座標でずらす量 */
  offset?: Point;
}

/**
 * 断片を親の子として入れる。すべてのノードに新しい ID を振り、同じ中身のアセットは
 * 文書のものを使う。見た目の位置は断片のページ座標 + `offset` になる。
 * 上限を超えるなら何もしない (`ids` が空)。
 */
export function insertFragment(
  doc: CanvasDocument,
  fragment: Fragment,
  parent: ParentRef,
  options: InsertFragmentOptions = {},
): DocChange {
  const roots = fragment.roots.filter((id) => hasOwn(fragment.nodes, id));
  if (roots.length === 0 || !parentExists(doc, parent)) return { doc, ids: [] };
  if (Object.keys(doc.nodes).length + fragmentSize(fragment) > CANVAS_LIMITS.maxNodes)
    return { doc, ids: [] };
  const depth = parentDepth(doc, parent);
  if (roots.some((id) => depth + subtreeHeight(fragment.nodes, id) > CANVAS_LIMITS.maxDepth))
    return { doc, ids: [] };

  const draft = new DocDraft(doc);
  const assetMap = new Map<AssetId, AssetId>();
  const assets: Record<AssetId, Asset> = { ...doc.assets };
  for (const [id, asset] of Object.entries(fragment.assets)) {
    const same = findSameAsset(assets, asset);
    if (same !== null) {
      assetMap.set(id, same);
      continue;
    }
    const newId = hasOwn(assets, id) ? createId(assets) : id;
    assets[newId] = asset;
    draft.setAsset(newId, asset);
    assetMap.set(id, newId);
  }

  const origin = parentOrigin(doc, parent);
  const offset = options.offset ?? { x: 0, y: 0 };
  const taken = new Set<string>();
  const ids: NodeId[] = [];
  let at = options.index ?? draft.children(parent).length;
  for (const root of roots) {
    const id = cloneSubtreeInto(draft, fragment.nodes, root, taken, assetMap);
    translateInDraft(draft, id, offset.x - origin.x, offset.y - origin.y);
    draft.attach(id, parent, at++);
    ids.push(id);
  }
  return { doc: draft.finish(), ids };
}
