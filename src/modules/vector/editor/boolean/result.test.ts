import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyToPoint, nodeMatrix } from "../geometry/matrix";
import { createBoolean, createEllipse, createPath, createRect, solidPaint } from "../model/create";
import { updateNodes } from "../model/transform";
import type { BooleanOp, CanvasDocument, CanvasNode, Subpath } from "../model/types";
import type { BooleanOperand } from "./index";
import { getBooleanEvaluation, getBooleanResult, operandsBounds, shapeOperand } from "./result";

const operation = vi.hoisted(() => ({
  calls: [] as { op: string; operands: readonly BooleanOperand[] }[],
  result: null as Subpath[] | null,
  throws: false,
}));
vi.mock("./index", () => ({
  booleanOperation: (op: string, operands: readonly BooleanOperand[]) => {
    operation.calls.push({ op, operands });
    if (operation.throws) throw new Error("boom");
    return operation.result;
  },
}));

const corner = (x: number, y: number) => ({ x, y, in: null, out: null, mirror: "none" as const });
const SQUARE: Subpath[] = [
  { closed: true, points: [corner(0, 0), corner(4, 0), corner(4, 4), corner(0, 4)] },
];

beforeEach(() => {
  operation.calls = [];
  operation.result = SQUARE;
  operation.throws = false;
});

function docOf(nodes: CanvasNode[], top: string[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children: top, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

/**
 * ```
 * u  boolean (op)
 * ├─ r   rect (10, 20) 40×30、回転 90
 * ├─ e   ellipse (0, 0) 20×10
 * └─ p   path (100, 100)、evenodd
 * ```
 */
function sample(op: BooleanOp = "union"): CanvasDocument {
  return docOf(
    [
      createBoolean(op, ["r", "e", "p"], { id: "u" }),
      createRect({ id: "r", x: 10, y: 20, width: 40, height: 30, rotation: 90 }),
      createEllipse({ id: "e", x: 0, y: 0, width: 20, height: 10 }),
      createPath(SQUARE, { id: "p", x: 100, y: 100, fillRule: "evenodd" }),
    ],
    ["u"],
  );
}

describe("shapeOperand", () => {
  it("矩形は点の形にノードの変換 (回転を含む) を掛けて親の座標系にする", () => {
    const rect = createRect({ id: "r", x: 10, y: 20, width: 40, height: 30, rotation: 90 });
    const operand = shapeOperand(rect);
    const m = nodeMatrix(10, 20, 40, 30, 90);
    expect(operand?.fillRule).toBe("nonzero");
    expect(operand?.subpaths[0]?.points.map((p) => [p.x, p.y])).toEqual(
      [
        [0, 0],
        [40, 0],
        [40, 30],
        [0, 30],
      ].map(([x, y]) => {
        const q = applyToPoint(m, { x: x!, y: y! });
        return [q.x, q.y];
      }),
    );
  });

  it("楕円は 4 本の曲線、パスは自分の点と塗りの規則", () => {
    const ellipse = shapeOperand(createEllipse({ x: 0, y: 0, width: 20, height: 10 }));
    expect(ellipse?.subpaths[0]?.points).toHaveLength(4);
    const path = shapeOperand(createPath(SQUARE, { x: 5, y: 6, fillRule: "evenodd" }));
    expect(path?.fillRule).toBe("evenodd");
    expect(path?.subpaths[0]?.points[2]).toMatchObject({ x: 9, y: 10 });
  });

  it("大きさ 0 の矩形は空の形。ほかの種類は null", () => {
    expect(shapeOperand(createRect({ width: 0 }))?.subpaths).toEqual([]);
    expect(shapeOperand(createBoolean("union", ["x"]))).toBeNull();
  });
});

describe("getBooleanResult", () => {
  it("子の形を重なり順に演算へ渡し、結果と範囲を返す", () => {
    const doc = sample("subtract");
    const result = getBooleanResult(doc, "u");
    expect(result).toEqual({ subpaths: SQUARE, bounds: { x: 0, y: 0, width: 4, height: 4 } });
    expect(operation.calls).toHaveLength(1);
    const call = operation.calls[0]!;
    expect(call.op).toBe("subtract");
    expect(call.operands.map((operand) => operand.fillRule)).toEqual([
      "nonzero",
      "nonzero",
      "evenodd",
    ]);
    expect(call.operands[2]?.subpaths[0]?.points[0]).toMatchObject({ x: 100, y: 100 });
  });

  it("非表示の子は演算に入れない。全部が非表示なら呼ばずに空の結果", () => {
    const doc = updateNodes(sample(), ["e"], { visible: false });
    getBooleanResult(doc, "u");
    expect(operation.calls[0]?.operands).toHaveLength(2);
    const none = updateNodes(sample(), ["r", "e", "p"], { visible: false });
    expect(getBooleanResult(none, "u")).toEqual({ subpaths: [], bounds: null });
    expect(operation.calls).toHaveLength(1);
  });

  it("ノードと子孫のオブジェクトが同じなら、前の結果を使い回す", () => {
    const doc = sample();
    const first = getBooleanEvaluation(doc, "u");
    // 関係のないノードを変えた文書でも、同じオブジェクト
    const other = docOf([...Object.values(doc.nodes), createRect({ id: "z" })], ["u", "z"]);
    expect(getBooleanEvaluation(other, "u")).toBe(first);
    expect(operation.calls).toHaveLength(1);
    // 子を変えれば求め直す
    const moved = updateNodes(doc, ["e"], { x: 1 });
    const second = getBooleanEvaluation(moved, "u");
    expect(second).not.toBe(first);
    expect(operation.calls).toHaveLength(2);
    expect(getBooleanEvaluation(moved, "u")).toBe(second);
  });

  it("入れ子のブーリアンは、子の結果 (nonzero) を形として渡す。孫が変われば外側も求め直す", () => {
    const doc = docOf(
      [
        createBoolean("intersect", ["inner", "r2"], { id: "outer" }),
        createBoolean("union", ["r1"], { id: "inner" }),
        createRect({ id: "r1", width: 10, height: 10 }),
        createRect({ id: "r2", width: 5, height: 5 }),
      ],
      ["outer"],
    );
    const first = getBooleanResult(doc, "outer");
    expect(operation.calls.map((call) => call.op)).toEqual(["union", "intersect"]);
    expect(operation.calls[1]?.operands[0]).toEqual({ subpaths: SQUARE, fillRule: "nonzero" });
    const changed = updateNodes(doc, ["r1"], { width: 20 });
    expect(getBooleanResult(changed, "outer")).not.toBe(first);
    expect(operation.calls.map((call) => call.op)).toEqual([
      "union",
      "intersect",
      "union",
      "intersect",
    ]);
  });

  it("求められなければ null。入れ子の子が求められなければ外側も null で、子の形を並べて持つ", () => {
    operation.result = null;
    const doc = docOf(
      [
        createBoolean("union", ["inner", "r2"], { id: "outer" }),
        createBoolean("subtract", ["r1", "e1"], { id: "inner" }),
        createRect({ id: "r1", width: 10, height: 10 }),
        createEllipse({ id: "e1", width: 4, height: 4 }),
        createRect({ id: "r2", x: 20, width: 5, height: 5 }),
      ],
      ["outer"],
    );
    const evaluation = getBooleanEvaluation(doc, "outer");
    expect(evaluation?.result).toBeNull();
    expect(evaluation?.operands).toHaveLength(3);
    // 外側の演算は呼ばない (子が求められないので)
    expect(operation.calls.map((call) => call.op)).toEqual(["subtract"]);
    expect(operandsBounds(evaluation?.operands ?? [])).toEqual({
      x: 0,
      y: 0,
      width: 25,
      height: 10,
    });
  });

  it("演算が例外を投げたら求められなかったものとする", () => {
    operation.throws = true;
    expect(getBooleanResult(sample(), "u")).toBeNull();
    expect(getBooleanEvaluation(sample(), "u")?.operands).toHaveLength(3);
  });

  it("ブーリアンでない・見つからないノードは null", () => {
    const doc = sample();
    expect(getBooleanResult(doc, "r")).toBeNull();
    expect(getBooleanResult(doc, "nope")).toBeNull();
    expect(getBooleanEvaluation(doc, "r")).toBeNull();
  });

  it("壊れた文書 (ブーリアンが自分の祖先を子に持つ) でも止まる", () => {
    const doc = docOf(
      [
        createBoolean("union", ["b", "r"], { id: "a" }),
        createBoolean("union", ["a"], { id: "b", fill: solidPaint("#000000") }),
        createRect({ id: "r" }),
      ],
      ["a"],
    );
    expect(getBooleanResult(doc, "a")).toEqual(expect.objectContaining({ subpaths: SQUARE }));
  });
});
