import type { NrbfNode } from "@/ipc/nrbf";

export interface TreeRow {
  node: NrbfNode;
  depth: number;
  positionInSet: number;
  setSize: number;
}

export interface SearchResult {
  includedIds: Set<number>;
  matchIds: Set<number>;
  orderedMatchIds: number[];
  totalMatches: number;
  truncated: boolean;
}

export interface NrbfSearchQuery {
  name: string;
  value: string;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export function searchNodes(
  nodes: readonly NrbfNode[],
  query: NrbfSearchQuery,
  limit = 1000,
): SearchResult | null {
  const normalizedName = normalizeSearchText(query.name.trim());
  const normalizedValue = normalizeSearchText(query.value.trim());
  if (normalizedName === "" && normalizedValue === "") return null;
  const byId = new Map<number, NrbfNode>();
  const limitedMatches: NrbfNode[] = [];
  let totalMatches = 0;
  for (const node of nodes) {
    byId.set(node.id, node);
    const nameMatch =
      normalizedName === "" ||
      [node.displayName, node.rawName].some((value) =>
        normalizeSearchText(value).includes(normalizedName),
      );
    const valueMatch =
      normalizedValue === "" ||
      (node.kind === "scalar" &&
        node.formattedValue != null &&
        normalizeSearchText(node.formattedValue).includes(normalizedValue));
    if (nameMatch && valueMatch) {
      totalMatches += 1;
      if (limitedMatches.length < limit) limitedMatches.push(node);
    }
  }

  const orderedMatchIds = limitedMatches.map((node) => node.id);
  const matchIds = new Set(orderedMatchIds);
  const includedIds = new Set<number>(matchIds);
  for (const match of limitedMatches) {
    let parentId = match.parentId;
    const seen = new Set<number>();
    while (parentId != null && !seen.has(parentId)) {
      seen.add(parentId);
      includedIds.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  return {
    includedIds,
    matchIds,
    orderedMatchIds,
    totalMatches,
    truncated: totalMatches > limit,
  };
}

export function buildVisibleRows(
  nodes: readonly NrbfNode[],
  expandedIds: ReadonlySet<number>,
  search: SearchResult | null,
): TreeRow[] {
  const depths = new Map<number, number>();
  const branchVisible = new Map<number, boolean>();
  const rows: TreeRow[] = [];
  const siblingCounts = new Map<number | null, number>();
  for (const node of nodes) {
    const parentDepth = node.parentId == null ? -1 : (depths.get(node.parentId) ?? -1);
    const depth = parentDepth + 1;
    depths.set(node.id, depth);
    const visible =
      search != null
        ? search.includedIds.has(node.id)
        : node.parentId == null ||
          ((branchVisible.get(node.parentId) ?? false) && expandedIds.has(node.parentId));
    branchVisible.set(node.id, visible);
    if (visible) {
      const positionInSet = (siblingCounts.get(node.parentId) ?? 0) + 1;
      siblingCounts.set(node.parentId, positionInSet);
      rows.push({ node, depth, positionInSet, setSize: 0 });
    }
  }
  for (const row of rows) row.setSize = siblingCounts.get(row.node.parentId)!;
  return rows;
}

/** 表示切替や折りたたみで選択が隠れたら、表示中の最寄りの祖先へ戻す。 */
export function resolveVisibleSelection(
  selectedId: number | null,
  rowIndexes: ReadonlyMap<number, number>,
  presentationById: ReadonlyMap<number, NrbfNode>,
  allById: ReadonlyMap<number, NrbfNode>,
): number | null {
  const seen = new Set<number>();
  let id = selectedId;
  while (id != null && !seen.has(id)) {
    if (rowIndexes.has(id)) return id;
    seen.add(id);
    id = (presentationById.get(id) ?? allById.get(id))?.parentId ?? null;
  }
  return null;
}

export function collectAncestorIds(nodes: readonly NrbfNode[], nodeId: number): number[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: number[] = [];
  let parentId = byId.get(nodeId)?.parentId ?? null;
  const seen = new Set<number>();
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    result.push(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return result;
}

export function hasChildren(nodes: readonly NrbfNode[], nodeId: number): boolean {
  return nodes.some((node) => node.parentId === nodeId);
}
