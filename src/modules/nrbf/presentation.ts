import type { NrbfNode } from "@/ipc/nrbf";

/**
 * List/Dictionaryのシリアライズ内部構造が既知shapeと厳密一致するときだけ、
 * コンテナ用配列と管理フィールドを隠した論理ツリーを返す。元nodeは変更しないため
 * Raw切替で再解析せず完全な構造へ戻せる。
 */
export function createPresentationNodes(nodes: readonly NrbfNode[], rawMode: boolean): NrbfNode[] {
  if (rawMode) return [...nodes];
  const children = new Map<number, NrbfNode[]>();
  for (const node of nodes) {
    if (node.parentId == null) continue;
    const current = children.get(node.parentId) ?? [];
    current.push(node);
    children.set(node.parentId, current);
  }
  const excluded = new Set<number>();
  const replacements = new Map<number, NrbfNode>();

  const excludeSubtree = (rootId: number) => {
    const pending = [rootId];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (excluded.has(id)) continue;
      excluded.add(id);
      for (const child of children.get(id) ?? []) pending.push(child.id);
    }
  };

  for (const container of nodes) {
    if (container.kind !== "object" || container.typeName == null) continue;
    const fields = children.get(container.id) ?? [];
    if (container.typeName.startsWith("System.Collections.Generic.List`1")) {
      const byName = new Map(fields.map((field) => [field.rawName, field]));
      if (fields.length !== 3 || !["_items", "_size", "_version"].every((name) => byName.has(name)))
        continue;
      const items = byName.get("_items")!;
      const sizeField = byName.get("_size")!;
      const versionField = byName.get("_version")!;
      const size = parseNonNegativeInteger(sizeField);
      if (
        items.kind !== "array" ||
        size == null ||
        parseNonNegativeInteger(versionField) == null ||
        items.shape == null ||
        items.shape.length !== 1 ||
        size > items.shape[0]!
      )
        continue;
      const elements = children.get(items.id) ?? [];
      const indexes = elements.map((element) => parseArrayIndex(element.rawName));
      if (
        elements.length !== items.shape[0] ||
        indexes.some((index) => index == null) ||
        new Set(indexes).size !== elements.length ||
        indexes.some((index) => index! >= items.shape![0]!)
      )
        continue;
      excluded.add(items.id);
      excludeSubtree(sizeField.id);
      excludeSubtree(versionField.id);
      for (const element of elements) {
        const index = parseArrayIndex(element.rawName);
        if (index == null || index >= size) excludeSubtree(element.id);
        else replacements.set(element.id, { ...element, parentId: container.id });
      }
    } else if (container.typeName.startsWith("System.Collections.Generic.Dictionary`2")) {
      const expected = ["Version", "Comparer", "HashSize", "KeyValuePairs"];
      const byName = new Map(fields.map((field) => [field.rawName, field]));
      if (fields.length !== expected.length || !expected.every((name) => byName.has(name)))
        continue;
      const pairs = byName.get("KeyValuePairs")!;
      if (pairs.kind !== "array" || pairs.shape?.length !== 1) continue;
      const pairNodes = children.get(pairs.id) ?? [];
      if (
        pairNodes.length !== pairs.shape[0] ||
        pairNodes.some((pair) => {
          const pairFields = children.get(pair.id) ?? [];
          return (
            pair.kind !== "object" ||
            pairFields.length !== 2 ||
            !["key", "value"].every((name) => pairFields.some((field) => field.rawName === name))
          );
        })
      )
        continue;
      excluded.add(pairs.id);
      for (const metadata of expected.slice(0, 3)) excludeSubtree(byName.get(metadata)!.id);
      for (const pair of pairNodes) replacements.set(pair.id, { ...pair, parentId: container.id });
    }
  }

  return nodes
    .filter((node) => !excluded.has(node.id))
    .map((node) => replacements.get(node.id) ?? node);
}

function parseArrayIndex(rawName: string): number | null {
  const match = /^\[(\d+)]$/.exec(rawName);
  return match == null ? null : Number(match[1]);
}

function parseNonNegativeInteger(node: NrbfNode): number | null {
  if (node.kind !== "scalar" || node.formattedValue == null || !/^\d+$/.test(node.formattedValue))
    return null;
  const value = Number(node.formattedValue);
  return Number.isSafeInteger(value) ? value : null;
}
