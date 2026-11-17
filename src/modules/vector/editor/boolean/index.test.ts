import { describe, expect, it } from "vitest";
import { nearestPoint, pointAt } from "../geometry/bezier";
import type { BooleanOp, Subpath } from "../model/types";
import { signedArea } from "../path/measure";
import { subpathToSegments } from "../path/segments";
import { reverseSubpaths, transformSubpaths } from "../path/transform";
import { rotate, scale } from "../geometry/matrix";
import { type BooleanOperand, booleanOperation } from "./index";
import {
  compareOnGrid,
  ellipse,
  operand,
  point,
  polygon,
  rect,
  regularPolygon,
  star,
} from "./testing";

const OPS: BooleanOp[] = ["union", "subtract", "intersect", "exclude"];

function run(op: BooleanOp, operands: BooleanOperand[]): Subpath[] {
  const result = booleanOperation(op, operands);
  expect(result, `${op} returned null`).not.toBeNull();
  return result!;
}

/** 4 つの演算すべてで、格子の点の内外が期待と同じ。 */
function expectAllOps(operands: BooleanOperand[], steps = 48): void {
  for (const op of OPS) {
    const result = run(op, operands);
    const report = compareOnGrid(op, operands, result, { steps });
    expect(report.checked).toBeGreaterThan(steps * steps * 0.5);
    expect(report.mismatches, `${op} mismatches`).toEqual([]);
    expect(report.badWinding, `${op} winding not 0/1`).toEqual([]);
    for (const sub of result) {
      expect(sub.closed).toBe(true);
      expect(sub.points.length).toBeGreaterThanOrEqual(2);
    }
  }
}

describe("booleanOperation の基本", () => {
  it("入力がなければ空", () => {
    for (const op of OPS) expect(booleanOperation(op, [])).toEqual([]);
  });

  it("矩形 1 個の合体は同じ矩形 (時計回り)", () => {
    const r = run("union", [operand(rect(10, 20, 30, 40))]);
    expect(r).toHaveLength(1);
    expect(r[0]!.points).toHaveLength(4);
    expect(signedArea(r[0]!)).toBeCloseTo(1200, 9);
  });

  it("反時計回りの入力も時計回りにそろえる", () => {
    const r = run("union", [operand(reverseSubpaths(rect(0, 0, 10, 10)))]);
    expect(r).toHaveLength(1);
    expect(signedArea(r[0]!)).toBeCloseTo(100, 9);
  });

  it("知らない演算・有限でない座標は null", () => {
    expect(booleanOperation("nope" as BooleanOp, [operand(rect(0, 0, 1, 1))])).toBeNull();
    expect(
      booleanOperation("union", [
        operand(
          polygon([
            [0, 0],
            [Number.NaN, 1],
            [1, 1],
          ]),
        ),
      ]),
    ).toBeNull();
    expect(
      booleanOperation("union", [
        operand([
          {
            closed: true,
            points: [point(0, 0, null as never, { x: Infinity, y: 0 }), point(1, 1)],
          },
        ]),
      ]),
    ).toBeNull();
  });

  it("点のない輪郭・点 1 個の輪郭は面を持たない", () => {
    const empty = operand([
      { closed: true, points: [] },
      { closed: true, points: [point(3, 3)] },
    ]);
    for (const op of OPS) expect(booleanOperation(op, [empty])).toEqual([]);
    expect(run("union", [empty, operand(rect(0, 0, 5, 5))])).toHaveLength(1);
    expect(run("intersect", [empty, operand(rect(0, 0, 5, 5))])).toEqual([]);
    expect(run("subtract", [empty, operand(rect(0, 0, 5, 5))])).toEqual([]);
  });

  it("同じ入力には同じ結果", () => {
    const ops = [operand(ellipse(50, 50, 40)), operand(star(5, 0.4, 30, 30, 80))];
    for (const op of OPS) {
      expect(booleanOperation(op, ops)).toEqual(booleanOperation(op, ops));
    }
  });
});

describe("booleanOperation の形", () => {
  it("重なる矩形", () => {
    expectAllOps([operand(rect(0, 0, 100, 100)), operand(rect(50, 40, 100, 100))]);
    const u = run("union", [operand(rect(0, 0, 100, 100)), operand(rect(50, 40, 100, 100))]);
    expect(u).toHaveLength(1);
    expect(u[0]!.points).toHaveLength(8);
    expect(signedArea(u[0]!)).toBeCloseTo(20000 - 50 * 60, 6);
  });

  it("重なる円", () => {
    expectAllOps([operand(ellipse(50, 50, 40)), operand(ellipse(90, 60, 35))]);
  });

  it("角丸の矩形と円", () => {
    expectAllOps([operand(rect(0, 0, 120, 80, 20)), operand(ellipse(110, 70, 30))]);
  });

  it("星と円", () => {
    expectAllOps([operand(star(5, 0.4, 0, 0, 100)), operand(ellipse(50, 55, 30))]);
  });

  it("穴のある形 (evenodd と、反時計回りの穴の nonzero)", () => {
    const ringEvenOdd = operand([...rect(0, 0, 100, 100), ...rect(25, 25, 50, 50)], "evenodd");
    const ringNonzero = operand([...rect(0, 0, 100, 100), ...reverseSubpaths(ellipse(50, 50, 25))]);
    expectAllOps([ringEvenOdd, operand(rect(40, -10, 20, 120))]);
    expectAllOps([ringNonzero, operand(ellipse(80, 50, 30))]);
    const s = run("subtract", [operand(rect(0, 0, 100, 100)), operand(rect(25, 25, 50, 50))]);
    expect(s).toHaveLength(2);
    const areas = s.map(signedArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(-2500, 6);
    expect(areas[1]).toBeCloseTo(10000, 6);
  });

  it("外から接する円・中から接する円", () => {
    expectAllOps([operand(ellipse(50, 50, 30)), operand(ellipse(110, 50, 30))]);
    expectAllOps([operand(ellipse(50, 50, 40)), operand(ellipse(70, 50, 20))]);
  });

  it("辺を共有する矩形 (全部と一部)", () => {
    expectAllOps([operand(rect(0, 0, 50, 50)), operand(rect(50, 0, 50, 50))]);
    expectAllOps([operand(rect(0, 0, 50, 50)), operand(rect(50, 20, 50, 50))]);
    expectAllOps([operand(rect(0, 0, 100, 50)), operand(rect(20, 50, 30, 30))]);
    const u = run("union", [operand(rect(0, 0, 50, 50)), operand(rect(50, 0, 50, 50))]);
    expect(u).toHaveLength(1);
    expect(signedArea(u[0]!)).toBeCloseTo(5000, 6);
  });

  it("頂点を共有する形", () => {
    expectAllOps([operand(rect(0, 0, 50, 50)), operand(rect(50, 50, 50, 50))]);
    const u = run("union", [operand(rect(0, 0, 50, 50)), operand(rect(50, 50, 50, 50))]);
    // 頂点で触れる 2 つの面は、別々の時計回りの輪郭
    expect(u).toHaveLength(2);
    for (const sub of u) expect(signedArea(sub)).toBeCloseTo(2500, 6);
  });

  it("同じ形どうし", () => {
    expectAllOps([operand(ellipse(50, 50, 40)), operand(ellipse(50, 50, 40))]);
    expectAllOps([operand(rect(0, 0, 60, 40, 10)), operand(rect(0, 0, 60, 40, 10))]);
    expect(run("exclude", [operand(rect(0, 0, 10, 10)), operand(rect(0, 0, 10, 10))])).toEqual([]);
    expect(run("subtract", [operand(rect(0, 0, 10, 10)), operand(rect(0, 0, 10, 10))])).toEqual([]);
  });

  it("片方が他方を含む", () => {
    expectAllOps([operand(ellipse(50, 50, 45)), operand(rect(30, 30, 40, 40))]);
    expectAllOps([operand(rect(30, 30, 40, 40)), operand(ellipse(50, 50, 45))]);
  });

  it("自己交差 (nonzero と evenodd で違う)", () => {
    const pentagram = polygon([
      [50, 0],
      [79, 90],
      [2, 35],
      [98, 35],
      [21, 90],
    ]);
    expectAllOps([operand(pentagram, "nonzero"), operand(ellipse(50, 50, 20))]);
    expectAllOps([operand(pentagram, "evenodd"), operand(ellipse(50, 50, 20))]);
    const nz = run("union", [operand(pentagram, "nonzero")]);
    const eo = run("union", [operand(pentagram, "evenodd")]);
    const area = (subs: Subpath[]) => subs.reduce((s, sub) => s + signedArea(sub), 0);
    expect(area(nz)).toBeGreaterThan(area(eo));
  });

  it("8 の字", () => {
    const eight = polygon([
      [0, 0],
      [100, 100],
      [100, 0],
      [0, 100],
    ]);
    expectAllOps([operand(eight), operand(rect(40, 20, 20, 60))]);
  });

  it("同じ点を通る 3 つの輪郭", () => {
    expectAllOps([
      operand(rect(0, 0, 50, 50)),
      operand(rect(50, 50, 50, 50)),
      operand(
        polygon([
          [50, 50],
          [100, 0],
          [100, 30],
        ]),
      ),
    ]);
  });

  it("入れ子の穴", () => {
    const nested = operand(
      [
        ...rect(0, 0, 100, 100),
        ...rect(10, 10, 80, 80),
        ...rect(20, 20, 60, 60),
        ...rect(30, 30, 40, 40),
      ],
      "evenodd",
    );
    expectAllOps([nested, operand(rect(45, -5, 10, 110))]);
  });

  it("面積 0 の輪郭 (線、行って戻る線)", () => {
    const line = operand(
      polygon(
        [
          [0, 50],
          [100, 50],
        ],
        false,
      ),
    );
    const back = operand(
      polygon([
        [0, 0],
        [50, 50],
        [100, 100],
        [50, 50],
      ]),
    );
    expectAllOps([line, operand(rect(20, 20, 60, 60))]);
    expectAllOps([back, operand(rect(20, 20, 60, 60))]);
    expect(run("union", [line])).toEqual([]);
  });

  it("閉じていない輪郭は閉じた形として扱う", () => {
    const open = operand(
      polygon(
        [
          [0, 0],
          [100, 0],
          [100, 100],
        ],
        false,
      ),
    );
    expectAllOps([open, operand(ellipse(60, 40, 30))]);
  });

  it("3 個以上の入力", () => {
    expectAllOps([
      operand(ellipse(40, 40, 30)),
      operand(ellipse(70, 40, 30)),
      operand(ellipse(55, 70, 30)),
      operand(rect(10, 50, 90, 10)),
    ]);
  });

  it("多角形と回した多角形", () => {
    const hex = regularPolygon(6, 0, 0, 100);
    expectAllOps([operand(hex), operand(transformSubpaths(hex, rotate(17, 50, 50)))]);
  });

  it("極端に小さい座標と大きい座標", () => {
    for (const k of [1e-3, 1e4]) {
      const m = scale(k, k);
      expectAllOps(
        [
          operand(transformSubpaths(ellipse(50, 50, 40), m)),
          operand(transformSubpaths(rect(40, 30, 70, 50, 10), m)),
        ],
        32,
      );
    }
    // 原点から遠い (座標の上限の近く)
    const far = (s: Subpath[]) =>
      transformSubpaths(s, { a: 1, b: 0, c: 0, d: 1, e: 900000, f: -900000 });
    expectAllOps([operand(far(ellipse(50, 50, 40))), operand(far(rect(40, 30, 70, 50, 10)))], 32);
  });
});

describe("booleanOperation の結果の形", () => {
  /** 結果の曲線の点が、どれかの入力の曲線の上にある (折れ線に近似していない)。 */
  function expectOnInputs(result: Subpath[], operands: BooleanOperand[], eps = 1e-9): void {
    const inputs = operands.flatMap((o) =>
      o.subpaths.flatMap((sub) => subpathToSegments(sub, { implicitClose: true })),
    );
    for (const sub of result) {
      for (const seg of subpathToSegments(sub)) {
        for (const t of [0.1, 0.5, 0.9]) {
          const p = pointAt(seg, t);
          const d = Math.min(...inputs.map((s) => nearestPoint(s, p).distance));
          expect(d).toBeLessThanOrEqual(eps);
        }
      }
    }
  }

  it("結果の曲線は入力の曲線の一部で、点の数は分けた所だけ増える", () => {
    const operands = [operand(ellipse(50, 50, 40)), operand(ellipse(90, 60, 35))];
    for (const op of OPS) {
      const result = run(op, operands);
      expectOnInputs(result, operands);
      const points = result.reduce((n, sub) => n + sub.points.length, 0);
      // 入力の曲線 8 本と交点 2 つ: 分けても 12 本以下
      expect(points).toBeLessThanOrEqual(12);
    }
  });

  it("交点で分けたあと残った続きの部分は 1 本に戻す", () => {
    // 矩形の上の辺の真ん中に小さな矩形が重なる。合体では上の辺が分かれるが、型抜きの外側の辺は 1 本のまま
    const big = operand(rect(0, 0, 100, 100));
    const hole = operand(rect(40, 40, 20, 20));
    const s = run("subtract", [big, hole]);
    expect(s.map((sub) => sub.points.length).sort()).toEqual([4, 4]);
    const u = run("union", [operand(rect(0, 0, 100, 100)), operand(rect(-10, 40, 120, 20))]);
    expect(u).toHaveLength(1);
    expect(u[0]!.points).toHaveLength(12);
  });

  it("外から接する円の合体は、接点で分かれた 2 つの時計回りの輪郭", () => {
    const u = run("union", [operand(ellipse(50, 50, 30)), operand(ellipse(110, 50, 30))]);
    expect(u).toHaveLength(2);
    for (const sub of u) expect(signedArea(sub)).toBeGreaterThan(0);
  });

  it("中から接する円の型抜きは、外側が時計回り、穴が反時計回り", () => {
    const s = run("subtract", [operand(ellipse(50, 50, 40)), operand(ellipse(70, 50, 20))]);
    expect(s).toHaveLength(2);
    const areas = s.map(signedArea).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
    expect(areas[0]! + areas[1]!).toBeCloseTo(Math.PI * (1600 - 400), -1);
  });

  it("入れ子の穴は、深さで向きが交互になる", () => {
    const nested = operand(
      [...rect(0, 0, 100, 100), ...rect(10, 10, 80, 80), ...rect(20, 20, 60, 60)],
      "evenodd",
    );
    const r = run("union", [nested]);
    expect(r.map(signedArea).sort((a, b) => a - b)).toEqual([-6400, 3600, 10000]);
  });
});
