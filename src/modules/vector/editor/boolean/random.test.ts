/**
 * ブーリアン演算を乱数の形で確かめる。結果の面と期待の面を格子の点で比べる (`testing.ts` の `compareOnGrid`)。
 * 種は決まっているので、同じ形で毎回同じ結果になる。
 */
import { describe, expect, it } from "vitest";
import { rotate, scale } from "../geometry/matrix";
import type { BooleanOp, Subpath } from "../model/types";
import { transformSubpaths } from "../path/transform";
import { type BooleanOperand, booleanOperation } from "./index";
import {
  compareOnGrid,
  ellipse,
  operand,
  point,
  random,
  randomBlob,
  randomPolygon,
  rect,
} from "./testing";

const OPS: BooleanOp[] = ["union", "subtract", "intersect", "exclude"];

interface Tally {
  wrong: string[];
  nulls: string[];
}

/** 4 つの演算で比べる。null は数えるだけ (呼び出し側が許すかを決める)。誤った面は必ず失敗。 */
function check(label: string, operands: BooleanOperand[], tally: Tally, steps = 32): void {
  for (const op of OPS) {
    const result = booleanOperation(op, operands);
    if (!result) {
      tally.nulls.push(`${label} ${op}`);
      continue;
    }
    const report = compareOnGrid(op, operands, result, { steps });
    if (report.mismatches.length > 0 || report.badWinding.length > 0) {
      tally.wrong.push(
        `${label} ${op}: ${report.mismatches.length} mismatches, ${report.badWinding.length} bad windings`,
      );
    }
  }
}

function fillRule(rand: () => number) {
  return rand() < 0.5 ? ("nonzero" as const) : ("evenodd" as const);
}

// CI の機械では 1 件が既定の 5 秒を超えることがある。
describe("booleanOperation (乱数の形)", { timeout: 30_000 }, () => {
  it("乱れた多角形と曲線の形 (自己交差を含む)", () => {
    const tally: Tally = { wrong: [], nulls: [] };
    for (let seed = 1; seed <= 60; seed++) {
      const rand = random(seed);
      const n = 2 + Math.floor(rand() * 2);
      const operands: BooleanOperand[] = [];
      for (let i = 0; i < n; i++) {
        const cx = 30 + rand() * 40;
        const cy = 30 + rand() * 40;
        const r = 20 + rand() * 30;
        const sub =
          rand() < 0.4
            ? randomPolygon(rand, cx, cy, r, 3 + Math.floor(rand() * 6))
            : randomBlob(rand, cx, cy, r, 3 + Math.floor(rand() * 5));
        operands.push(operand([sub], fillRule(rand)));
      }
      check(`seed ${seed}`, operands, tally);
    }
    expect(tally.wrong).toEqual([]);
    expect(tally.nulls).toEqual([]);
  });

  it("格子に乗った形 (重なった辺、共有の頂点、一直線に並ぶ辺)", () => {
    const tally: Tally = { wrong: [], nulls: [] };
    const gridPolygon = (rand: () => number, n: number): Subpath => ({
      closed: true,
      points: Array.from({ length: n }, () =>
        point(Math.floor(rand() * 6) * 10, Math.floor(rand() * 6) * 10),
      ),
    });
    for (let seed = 1; seed <= 80; seed++) {
      const rand = random(seed * 7919);
      const n = 2 + Math.floor(rand() * 2);
      const operands: BooleanOperand[] = [];
      for (let i = 0; i < n; i++) {
        const subpaths =
          rand() < 0.5
            ? rect(
                Math.floor(rand() * 5) * 10,
                Math.floor(rand() * 5) * 10,
                (1 + Math.floor(rand() * 4)) * 10,
                (1 + Math.floor(rand() * 4)) * 10,
              )
            : [gridPolygon(rand, 3 + Math.floor(rand() * 5))];
        operands.push(operand(subpaths, fillRule(rand)));
      }
      check(`seed ${seed}`, operands, tally);
    }
    expect(tally.wrong).toEqual([]);
    expect(tally.nulls).toEqual([]);
  });

  it("接する円 (外から・中から)", () => {
    const tally: Tally = { wrong: [], nulls: [] };
    for (let seed = 1; seed <= 24; seed++) {
      const rand = random(seed * 104729);
      const r1 = 10 + rand() * 40;
      const r2 = 10 + rand() * 40;
      const a = rand() * Math.PI * 2;
      const inner = seed % 3 === 0;
      const d = inner ? Math.abs(r1 - r2) : r1 + r2;
      check(
        `seed ${seed}${inner ? " inner" : ""}`,
        [
          operand(ellipse(50, 50, r1)),
          operand(ellipse(50 + d * Math.cos(a), 50 + d * Math.sin(a), r2)),
        ],
        tally,
      );
    }
    expect(tally.wrong).toEqual([]);
    expect(tally.nulls).toEqual([]);
  });

  it("ほぼ同じ形どうし (ずらす・回す・拡大する): 誤った面は返さない", () => {
    const tally: Tally = { wrong: [], nulls: [] };
    for (let seed = 1; seed <= 30; seed++) {
      const rand = random(seed * 15485863);
      const base =
        rand() < 0.5 ? ellipse(50, 50, 30 + rand() * 10) : [randomBlob(rand, 50, 50, 40, 5)];
      const kind = seed % 3;
      const other =
        kind === 0
          ? transformSubpaths(base, {
              a: 1,
              b: 0,
              c: 0,
              d: 1,
              e: (rand() - 0.5) * 1e-5,
              f: (rand() - 0.5) * 1e-5,
            })
          : kind === 1
            ? transformSubpaths(base, rotate((rand() - 0.5) * 2, 50, 50))
            : transformSubpaths(
                base,
                scale(1 + (rand() - 0.5) * 1e-3, 1 + (rand() - 0.5) * 1e-3, 50, 50),
              );
      check(`seed ${seed} kind ${kind}`, [operand(base), operand(other)], tally);
    }
    expect(tally.wrong).toEqual([]);
    // 許容値 (約 1e-7 px) の近くで寄り添う形は求められないことがある。ここでは 1 割まで
    expect(tally.nulls.length).toBeLessThanOrEqual(12);
  });

  it("結果をもう一度入力にする (入れ子のブーリアン)", () => {
    const tally: Tally = { wrong: [], nulls: [] };
    for (let seed = 1; seed <= 24; seed++) {
      const rand = random(seed * 31337);
      const a = operand([randomBlob(rand, 50, 50, 40, 5)], "evenodd");
      const b = operand([randomBlob(rand, 60, 45, 35, 4)]);
      const c = operand([randomBlob(rand, 45, 60, 30, 6)]);
      const inner = booleanOperation(OPS[seed % 4]!, [a, b]);
      expect(inner).not.toBeNull();
      check(`seed ${seed}`, [operand(inner!), c], tally);
    }
    expect(tally.wrong).toEqual([]);
    expect(tally.nulls).toEqual([]);
  });

  it("1 点を通る扇形", () => {
    const tally: Tally = { wrong: [], nulls: [] };
    for (let n = 2; n <= 8; n++) {
      const operands: BooleanOperand[] = [];
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = a0 + (Math.PI / n) * 1.5;
        operands.push(
          operand([
            {
              closed: true,
              points: [
                point(50, 50),
                point(50 + 40 * Math.cos(a0), 50 + 40 * Math.sin(a0)),
                point(50 + 40 * Math.cos(a1), 50 + 40 * Math.sin(a1)),
              ],
            },
          ]),
        );
      }
      check(`n ${n}`, operands, tally);
    }
    expect(tally.wrong).toEqual([]);
    expect(tally.nulls).toEqual([]);
  });
});
