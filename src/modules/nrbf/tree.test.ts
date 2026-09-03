import { describe, expect, it } from "vitest";

import type { NrbfNode } from "@/ipc/nrbf";

import { buildVisibleRows, collectAncestorIds, searchNodes } from "./tree";

function node(
  id: number,
  parentId: number | null,
  name: string,
  value: string | null = null,
): NrbfNode {
  return {
    id,
    parentId,
    displayName: name,
    rawName: `<${name}>k__BackingField`,
    kind: value == null ? "object" : "scalar",
    typeName: null,
    assemblyName: null,
    formattedValue: value,
    recordId: String(id),
    referenceTargetId: null,
    shape: null,
  };
}

const nodes = [
  node(1, null, "$"),
  node(2, 1, "Person"),
  node(3, 2, "Name", "Ａｌｉｃｅ"),
  node(4, 2, "Age", "42"),
];

describe("NRBF tree search", () => {
  it("matches NFKC-normalized names and values case-insensitively and keeps ancestors", () => {
    const result = searchNodes(nodes, { name: "", value: "alice" })!;
    expect([...result.matchIds]).toEqual([3]);
    expect(result.orderedMatchIds).toEqual([3]);
    expect([...result.includedIds]).toEqual([3, 2, 1]);
    expect(buildVisibleRows(nodes, new Set(), result).map((row) => row.node.id)).toEqual([1, 2, 3]);
  });

  it("can search raw field names independently of values", () => {
    const result = searchNodes(nodes, { name: "backingfield", value: "" })!;
    expect(result.totalMatches).toBe(4);
  });

  it("combines name and value conditions on the same node", () => {
    expect(searchNodes(nodes, { name: "age", value: "42" })?.orderedMatchIds).toEqual([4]);
    expect(searchNodes(nodes, { name: "name", value: "42" })?.totalMatches).toBe(0);
  });

  it("does not treat array or reference display metadata as a searchable value", () => {
    const metadataNodes = [
      node(1, null, "$"),
      { ...node(2, 1, "Items", "[100]"), kind: "array" as const },
      { ...node(3, 1, "Self", "→ #1"), kind: "reference" as const },
    ];
    expect(searchNodes(metadataNodes, { name: "", value: "100" })?.totalMatches).toBe(0);
    expect(searchNodes(metadataNodes, { name: "", value: "#1" })?.totalMatches).toBe(0);
  });

  it("caps matches at 1000 while retaining every selected ancestor", () => {
    const many = [
      node(1, null, "$"),
      ...Array.from({ length: 1005 }, (_, i) => node(i + 2, 1, `hit-${i}`, "x")),
    ];
    const result = searchNodes(many, { name: "hit", value: "" })!;
    expect(result.totalMatches).toBe(1005);
    expect(result.matchIds.size).toBe(1000);
    expect(result.truncated).toBe(true);
    expect(result.includedIds.has(1)).toBe(true);
  });

  it("expands normal rows only when ancestors are expanded", () => {
    expect(buildVisibleRows(nodes, new Set(), null).map((row) => row.node.id)).toEqual([1]);
    expect(buildVisibleRows(nodes, new Set([1, 2]), null).map((row) => row.node.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(collectAncestorIds(nodes, 3)).toEqual([2, 1]);
  });
});
