import { describe, expect, it } from "vitest";

import type { NrbfNode } from "@/ipc/nrbf";

import { createPresentationNodes } from "./presentation";

function node(
  id: number,
  parentId: number | null,
  rawName: string,
  overrides: Partial<NrbfNode> = {},
): NrbfNode {
  return {
    id,
    parentId,
    displayName: rawName,
    rawName,
    kind: "scalar",
    typeName: null,
    assemblyName: null,
    formattedValue: null,
    recordId: String(id),
    referenceTargetId: null,
    shape: null,
    ...overrides,
  };
}

describe("NRBF friendly collection presentation", () => {
  it("shows only the logical List elements when the internal structure matches strictly", () => {
    const nodes = [
      node(1, null, "$", {
        kind: "object",
        typeName: "System.Collections.Generic.List`1[[System.String]]",
      }),
      node(2, 1, "_items", { kind: "array", shape: [4] }),
      node(3, 2, "[0]", { formattedValue: "a" }),
      node(4, 2, "[1]", { formattedValue: "b" }),
      node(5, 2, "[2]", { kind: "null" }),
      node(6, 2, "[3]", { kind: "null" }),
      node(7, 1, "_size", { formattedValue: "2" }),
      node(8, 1, "_version", { formattedValue: "1" }),
    ];
    const friendly = createPresentationNodes(nodes, false);
    expect(friendly.map((value) => value.id)).toEqual([1, 3, 4]);
    expect(friendly[1]?.parentId).toBe(1);
    expect(createPresentationNodes(nodes, true)).toEqual(nodes);
  });

  it("falls back to raw structure when a List field is missing", () => {
    const nodes = [
      node(1, null, "$", {
        kind: "object",
        typeName: "System.Collections.Generic.List`1[[System.String]]",
      }),
      node(2, 1, "_items", { kind: "array", shape: [1] }),
      node(3, 1, "_size", { formattedValue: "1" }),
    ];
    expect(createPresentationNodes(nodes, false)).toEqual(nodes);
  });

  it("falls back when a List array was omitted or metadata is not scalar", () => {
    const nodes = [
      node(1, null, "$", {
        kind: "object",
        typeName: "System.Collections.Generic.List`1[[System.Byte]]",
      }),
      node(2, 1, "_items", { kind: "array", shape: [2] }),
      node(3, 1, "_size", { formattedValue: "2" }),
      node(4, 1, "_version", { kind: "object", formattedValue: "1" }),
    ];
    expect(createPresentationNodes(nodes, false)).toEqual(nodes);
  });

  it("flattens Dictionary KeyValuePairs only for the exact serialization shape", () => {
    const nodes = [
      node(1, null, "$", {
        kind: "object",
        typeName: "System.Collections.Generic.Dictionary`2[[System.String],[System.Int32]]",
      }),
      node(2, 1, "Version"),
      node(3, 1, "Comparer"),
      node(4, 1, "HashSize"),
      node(5, 1, "KeyValuePairs", { kind: "array", shape: [1] }),
      node(6, 5, "[0]", { kind: "object" }),
      node(7, 6, "key", { formattedValue: "a" }),
      node(8, 6, "value", { formattedValue: "1" }),
    ];
    const friendly = createPresentationNodes(nodes, false);
    expect(friendly.map((value) => value.id)).toEqual([1, 6, 7, 8]);
    expect(friendly[1]?.parentId).toBe(1);
  });

  it("falls back when a Dictionary pair does not have exact key and value fields", () => {
    const nodes = [
      node(1, null, "$", {
        kind: "object",
        typeName: "System.Collections.Generic.Dictionary`2[[System.String],[System.Int32]]",
      }),
      node(2, 1, "Version"),
      node(3, 1, "Comparer"),
      node(4, 1, "HashSize"),
      node(5, 1, "KeyValuePairs", { kind: "array", shape: [1] }),
      node(6, 5, "[0]", { kind: "object" }),
      node(7, 6, "key", { formattedValue: "a" }),
    ];
    expect(createPresentationNodes(nodes, false)).toEqual(nodes);
  });
});
