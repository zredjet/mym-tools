import { describe, expect, it } from "vitest";

import { makeNode, makeResult } from "./testNodes";
import {
  buildVisibleRows,
  nodeKey,
  nodePath,
  otherKey,
  resolveVisibleSelection,
  shareOf,
  sortedChildren,
} from "./tree";

// root (100 / 120)
//   big/ (70 / 60)
//     movie.mp4 (60 / 50)
//     ほか 2 項目 (10 / 10)
//   small.bin (20 / 40)
//   empty/ (0 / 0)
//   ほか 3 項目 (10 / 20)
const nodes = [
  makeNode({
    id: 0,
    name: "/data",
    logical: 100,
    allocated: 120,
    other_count: 3,
    other_logical: 10,
    other_allocated: 20,
  }),
  makeNode({
    id: 1,
    parent_id: 0,
    name: "big",
    logical: 70,
    allocated: 60,
    other_count: 2,
    other_logical: 10,
    other_allocated: 10,
  }),
  makeNode({ id: 2, parent_id: 0, name: "small.bin", kind: "file", logical: 20, allocated: 40 }),
  makeNode({ id: 3, parent_id: 0, name: "empty" }),
  makeNode({ id: 4, parent_id: 1, name: "movie.mp4", kind: "file", logical: 60, allocated: 50 }),
];

describe("sortedChildren", () => {
  it("orders children by the chosen size, folders first on ties", () => {
    expect(sortedChildren(nodes, "logical")[0]).toEqual([1, 2, 3]);
    expect(sortedChildren(nodes, "allocated")[0]).toEqual([1, 2, 3]);
    const tie = [
      makeNode({ id: 0, name: "/r", logical: 2 }),
      makeNode({ id: 1, parent_id: 0, name: "b.txt", kind: "file", logical: 1 }),
      makeNode({ id: 2, parent_id: 0, name: "a", logical: 1 }),
      makeNode({ id: 3, parent_id: 0, name: "a.txt", kind: "file", logical: 1 }),
    ];
    expect(sortedChildren(tie, "logical")[0]).toEqual([2, 3, 1]);
  });

  it("re-sorts when the allocated size ranks differently", () => {
    const swapped = [
      makeNode({ id: 0, name: "/r", logical: 30, allocated: 30 }),
      makeNode({ id: 1, parent_id: 0, name: "a", kind: "file", logical: 20, allocated: 5 }),
      makeNode({ id: 2, parent_id: 0, name: "b", kind: "file", logical: 10, allocated: 25 }),
    ];
    expect(sortedChildren(swapped, "logical")[0]).toEqual([1, 2]);
    expect(sortedChildren(swapped, "allocated")[0]).toEqual([2, 1]);
  });
});

describe("buildVisibleRows", () => {
  const children = sortedChildren(nodes, "logical");

  it("shows only the root until it is expanded", () => {
    const rows = buildVisibleRows(nodes, children, new Set(), "logical");
    expect(rows.map((row) => row.key)).toEqual([nodeKey(0)]);
    expect(rows[0]).toMatchObject({ type: "node", expandable: true, parentSize: 100 });
  });

  it("lists expanded children with a summary row last", () => {
    const rows = buildVisibleRows(nodes, children, new Set([0, 1]), "logical");
    expect(rows.map((row) => row.key)).toEqual([
      nodeKey(0),
      nodeKey(1),
      nodeKey(4),
      otherKey(1),
      nodeKey(2),
      nodeKey(3),
      otherKey(0),
    ]);
    const big = rows[1]!;
    expect(big).toMatchObject({ depth: 1, parentSize: 100, positionInSet: 1, setSize: 4 });
    expect(rows[3]).toMatchObject({ type: "other", depth: 2, parentSize: 70, positionInSet: 2 });
    expect(rows[5]).toMatchObject({ type: "node", expandable: false });
    expect(rows[6]).toMatchObject({ type: "other", positionInSet: 4, setSize: 4 });
  });

  it("uses the allocated size for the parent share", () => {
    const rows = buildVisibleRows(nodes, children, new Set([0]), "allocated");
    expect(rows[1]).toMatchObject({ parentSize: 120 });
  });

  it("returns nothing for an empty result", () => {
    expect(buildVisibleRows([], [], new Set([0]), "logical")).toEqual([]);
  });
});

describe("resolveVisibleSelection", () => {
  const children = sortedChildren(nodes, "logical");
  const indexes = (expanded: number[]) =>
    new Map(
      buildVisibleRows(nodes, children, new Set(expanded), "logical").map((row, index) => [
        row.key,
        index,
      ]),
    );

  it("keeps a visible selection and moves a hidden one to the nearest visible ancestor", () => {
    expect(resolveVisibleSelection(nodeKey(4), indexes([0, 1]), nodes)).toBe(nodeKey(4));
    expect(resolveVisibleSelection(nodeKey(4), indexes([0]), nodes)).toBe(nodeKey(1));
    expect(resolveVisibleSelection(otherKey(1), indexes([0]), nodes)).toBe(nodeKey(1));
    expect(resolveVisibleSelection(nodeKey(4), indexes([]), nodes)).toBe(nodeKey(0));
    expect(resolveVisibleSelection(null, indexes([0]), nodes)).toBeNull();
  });
});

describe("nodePath", () => {
  it("joins names to the root with the platform separator", () => {
    const result = makeResult(nodes);
    expect(nodePath(result, 0)).toEqual({ path: "/data", exact: true });
    expect(nodePath(result, 4)).toEqual({ path: "/data/big/movie.mp4", exact: true });
    expect(nodePath({ ...result, root_path: "/" }, 1).path).toBe("/big");
    expect(nodePath({ ...result, root_path: "C:\\", separator: "\\" }, 4).path).toBe(
      "C:\\big\\movie.mp4",
    );
    expect(nodePath({ ...result, root_path: "C:\\Users", separator: "\\" }, 2).path).toBe(
      "C:\\Users\\small.bin",
    );
  });

  it("marks paths that contain a replaced name", () => {
    const lossy = nodes.map((node) => (node.id === 1 ? { ...node, lossy_name: true } : node));
    expect(nodePath(makeResult(lossy), 4)).toEqual({ path: "/data/big/movie.mp4", exact: false });
    expect(nodePath(makeResult(lossy), 2).exact).toBe(true);
  });
});

describe("shareOf", () => {
  it("is a percentage of the parent, 0 for an empty parent", () => {
    expect(shareOf(25, 100)).toBe(25);
    expect(shareOf(5, 0)).toBe(0);
    expect(shareOf(150, 100)).toBe(100);
  });
});
