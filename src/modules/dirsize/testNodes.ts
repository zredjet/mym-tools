import type { DirSizeNode, DirSizeScanResult } from "@/ipc/dirsize";

/** テスト用のノード。指定しない値は 0 / false */
export function makeNode(
  overrides: Partial<DirSizeNode> & Pick<DirSizeNode, "id" | "name">,
): DirSizeNode {
  return {
    parent_id: null,
    kind: "dir",
    logical: 0,
    allocated: 0,
    file_count: 0,
    dir_count: 0,
    other_count: 0,
    other_logical: 0,
    other_allocated: 0,
    unreadable: false,
    lossy_name: false,
    ...overrides,
  };
}

/** テスト用の走査結果。`nodes` 以外は空の値 */
export function makeResult(
  nodes: DirSizeNode[],
  overrides: Partial<DirSizeScanResult> = {},
): DirSizeScanResult {
  return {
    root_path: nodes[0]?.name ?? "/root",
    separator: "/",
    nodes,
    total_files: nodes[0]?.file_count ?? 0,
    total_dirs: nodes[0]?.dir_count ?? 0,
    unreadable: { count: 0, paths: [] },
    skipped: { links: 0, other_volumes: 0, hard_links: 0, entries: 0 },
    volume: null,
    limit_reached: false,
    top_limit: 10_000,
    duration_ms: 5,
    ...overrides,
  };
}
