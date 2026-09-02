import type { NrbfNode } from "@/ipc/nrbf";

export interface TreeRow {
  node: NrbfNode;
  depth: number;
}

export interface SearchResult {
  includedIds: Set<number>;
  matchIds: Set<number>;
  totalMatches: number;
  truncated: boolean;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export function searchNodes(
  nodes: readonly NrbfNode[],
  query: string,
  includeNames: boolean,
  includeValues: boolean,
  limit = 1000,
): SearchResult | null {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (normalizedQuery === "") return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const allMatches: NrbfNode[] = [];
  for (const node of nodes) {
    const nameMatch =
      includeNames &&
      [node.displayName, node.rawName].some((value) =>
        normalizeSearchText(value).includes(normalizedQuery),
      );
    const valueMatch =
      includeValues &&
      node.kind === "scalar" &&
      node.formattedValue != null &&
      normalizeSearchText(node.formattedValue).includes(normalizedQuery);
    if (nameMatch || valueMatch) allMatches.push(node);
  }

  const limitedMatches = allMatches.slice(0, limit);
  const matchIds = new Set(limitedMatches.map((node) => node.id));
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
    totalMatches: allMatches.length,
    truncated: allMatches.length > limit,
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
    if (visible) rows.push({ node, depth });
  }
  return rows;
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
