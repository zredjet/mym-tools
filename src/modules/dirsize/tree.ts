import type { DirSizeNode, DirSizeScanResult } from "@/ipc/dirsize";

/** 並べ替えと割合の基準。`logical` は「サイズ」、`allocated` は「ディスク上」 */
export type SortKey = "logical" | "allocated";

interface RowBase {
  key: string;
  depth: number;
  /** 親フォルダの大きさ (選んだ基準)。ルートは自身の大きさ */
  parentSize: number;
  positionInSet: number;
  setSize: number;
}

export type TreeRow =
  | (RowBase & { type: "node"; node: DirSizeNode; expandable: boolean })
  /** 結果に含めなかった直下の項目をまとめた「ほか n 項目」 */
  | (RowBase & { type: "other"; parent: DirSizeNode });

export function nodeKey(id: number): string {
  return `n${id}`;
}

export function otherKey(parentId: number): string {
  return `o${parentId}`;
}

export function sizeOf(node: DirSizeNode, sortKey: SortKey): number {
  return sortKey === "logical" ? node.logical : node.allocated;
}

export function otherSizeOf(node: DirSizeNode, sortKey: SortKey): number {
  return sortKey === "logical" ? node.other_logical : node.other_allocated;
}

/** 親に占める割合 (0〜100) */
export function shareOf(size: number, parentSize: number): number {
  return parentSize <= 0 ? 0 : Math.min(100, (size / parentSize) * 100);
}

/** 子の id を、選んだ基準の大きい順に並べる。同じならフォルダを先に、名前順 */
export function sortedChildren(nodes: readonly DirSizeNode[], sortKey: SortKey): number[][] {
  const children: number[][] = nodes.map(() => []);
  for (const node of nodes) {
    if (node.parent_id != null) children[node.parent_id]?.push(node.id);
  }
  const collator = new Intl.Collator("ja", { numeric: true });
  for (const list of children) {
    list.sort((a, b) => {
      const left = nodes[a]!;
      const right = nodes[b]!;
      return (
        sizeOf(right, sortKey) - sizeOf(left, sortKey) ||
        kindOrder(left) - kindOrder(right) ||
        collator.compare(left.name, right.name)
      );
    });
  }
  return children;
}

type Pending =
  | { type: "node"; id: number; depth: number; parentSize: number; position: number; size: number }
  | {
      type: "other";
      id: number;
      depth: number;
      parentSize: number;
      position: number;
      size: number;
    };

/** 展開しているフォルダの子を、深さ優先で表示順の行にする。展開したフォルダの末尾に「ほか」行を置く */
export function buildVisibleRows(
  nodes: readonly DirSizeNode[],
  children: readonly (readonly number[])[],
  expanded: ReadonlySet<number>,
  sortKey: SortKey,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const root = nodes[0];
  if (root == null) return rows;
  const stack: Pending[] = [
    {
      type: "node",
      id: root.id,
      depth: 0,
      parentSize: sizeOf(root, sortKey),
      position: 1,
      size: 1,
    },
  ];
  while (stack.length > 0) {
    const pending = stack.pop()!;
    const node = nodes[pending.id]!;
    const base = {
      depth: pending.depth,
      parentSize: pending.parentSize,
      positionInSet: pending.position,
      setSize: pending.size,
    };
    if (pending.type === "other") {
      rows.push({ ...base, type: "other", key: otherKey(node.id), parent: node });
      continue;
    }
    const kids = children[node.id] ?? [];
    const expandable = node.kind === "dir" && (kids.length > 0 || node.other_count > 0);
    rows.push({ ...base, type: "node", key: nodeKey(node.id), node, expandable });
    if (!expandable || !expanded.has(node.id)) continue;
    const parentSize = sizeOf(node, sortKey);
    const setSize = kids.length + (node.other_count > 0 ? 1 : 0);
    const depth = pending.depth + 1;
    // 後に積んだものから取り出すので、「ほか」行を先に、子は逆順に積む
    if (node.other_count > 0) {
      stack.push({
        type: "other",
        id: node.id,
        depth,
        parentSize,
        position: setSize,
        size: setSize,
      });
    }
    for (let index = kids.length - 1; index >= 0; index--) {
      stack.push({
        type: "node",
        id: kids[index]!,
        depth,
        parentSize,
        position: index + 1,
        size: setSize,
      });
    }
  }
  return rows;
}

/** 選択していた行が畳まれて見えなくなったら、見えている一番近い祖先を選ぶ */
export function resolveVisibleSelection(
  selectedKey: string | null,
  rowIndexes: ReadonlyMap<string, number>,
  nodes: readonly DirSizeNode[],
): string | null {
  if (selectedKey == null || rowIndexes.has(selectedKey)) return selectedKey;
  const id = Number(selectedKey.slice(1));
  let current: number | null = selectedKey.startsWith("o") ? id : (nodes[id]?.parent_id ?? null);
  while (current != null) {
    const key = nodeKey(current);
    if (rowIndexes.has(key)) return key;
    current = nodes[current]?.parent_id ?? null;
  }
  return null;
}

/** ノードのパスをルートのパスと名前から組み立てる。名前に置換文字があれば `exact` は false */
export function nodePath(
  result: Pick<DirSizeScanResult, "nodes" | "root_path" | "separator">,
  id: number,
): { path: string; exact: boolean } {
  const names: string[] = [];
  let exact = true;
  let current = result.nodes[id];
  while (current != null && current.parent_id != null) {
    names.push(current.name);
    if (current.lossy_name) exact = false;
    current = result.nodes[current.parent_id];
  }
  if (names.length === 0) return { path: result.root_path, exact };
  names.reverse();
  const root = result.root_path;
  const base = root.endsWith("/") || root.endsWith("\\") ? root : root + result.separator;
  return { path: base + names.join(result.separator), exact };
}

function kindOrder(node: DirSizeNode): number {
  return node.kind === "dir" ? 0 : 1;
}
