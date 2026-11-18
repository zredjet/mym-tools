/**
 * ブーリアン演算の速さ (§8.9.3: アイコンの大きさ (曲線 200 本ほど) で 1 回 5 ms 以内)。
 *
 * 手元 (Apple Silicon、Node 24) の実測は PR の説明に書く。CI の機械は遅く揺れるので、ここでは目安の 4 倍
 * (20 ms) を中央値の上限にし、桁が変わるような遅れだけを捕まえる。
 */
import { describe, expect, it } from "vitest";
import { rotate } from "../geometry/matrix";
import type { BooleanOp, Subpath } from "../model/types";
import { subpathToSegments } from "../path/segments";
import { transformSubpaths } from "../path/transform";
import { type BooleanOperand, booleanOperation } from "./index";
import { compareOnGrid, ellipse, operand, rect, star } from "./testing";

const OPS: BooleanOp[] = ["union", "subtract", "intersect", "exclude"];
const BUDGET_MS = 20;

function curveCount(operands: readonly BooleanOperand[]): number {
  let n = 0;
  for (const o of operands) {
    for (const s of o.subpaths) n += subpathToSegments(s, { implicitClose: true }).length;
  }
  return n;
}

function medianMs(fn: () => void, runs = 15): number {
  fn();
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)]!;
}

/** 歯車のようなアイコン: 円に角丸の歯 12 本、星、小さい円、角丸の矩形 (曲線 198 本)。 */
function gearIcon(): BooleanOperand[] {
  const ops: BooleanOperand[] = [operand(ellipse(100, 100, 60))];
  for (let i = 0; i < 12; i++) {
    ops.push(operand(transformSubpaths(rect(90, 20, 20, 40, 6), rotate(i * 30, 100, 100))));
  }
  ops.push(operand(star(5, 0.45, 70, 70, 60)));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ops.push(operand(ellipse(100 + 45 * Math.cos(a), 100 + 45 * Math.sin(a), 9)));
  }
  for (let i = 0; i < 6; i++) ops.push(operand(rect(40 + i * 22, 150, 18, 30, 5)));
  return ops;
}

/** 重なりの多い形 (曲線 168 本、交点 180 ほど)。 */
function denseIcon(): BooleanOperand[] {
  const ops: BooleanOperand[] = [];
  for (let i = 0; i < 10; i++) {
    ops.push(operand(ellipse(20 + i * 7, 30 + (i % 3) * 9, 12 + (i % 4) * 2)));
  }
  for (let i = 0; i < 8; i++) ops.push(operand(rect(5 + i * 9, 50 + (i % 2) * 6, 20, 14, 4)));
  for (let i = 0; i < 4; i++) ops.push(operand(star(5, 0.45, 10 + i * 18, 5, 22)));
  for (let i = 0; i < 6; i++) {
    ops.push(
      operand(transformSubpaths(ellipse(40 + i * 5, 75, 9, 5), rotate(i * 25, 40 + i * 5, 75))),
    );
  }
  return ops;
}

/**
 * 入れ子の同心円 50 個 (evenodd の入力 1 個) と縦の帯 (曲線 204 本)。同じ象限の弧どうしは範囲も帯も
 * 重なるので、交わらない組を細かく分けた覆いで除けないと、組 (約 4,900) ごとに交点を求めて 20 ms を超える。
 */
function concentricRings(): BooleanOperand[] {
  const rings: Subpath[] = [];
  for (let i = 0; i < 50; i++) rings.push(...ellipse(100, 100, 5 + 2 * i));
  return [operand(rings, "evenodd"), operand(rect(95, 0, 10, 200))];
}

describe("booleanOperation の速さ", () => {
  for (const [name, make] of [
    ["歯車のアイコン", gearIcon],
    ["重なりの多い形", denseIcon],
    ["入れ子の同心円 50 個と帯", concentricRings],
  ] as const) {
    it(`${name}: 4 つの演算の中央値が ${BUDGET_MS} ms 以内で、結果が正しい`, () => {
      const operands = make();
      expect(curveCount(operands)).toBeGreaterThanOrEqual(160);
      for (const op of OPS) {
        const result = booleanOperation(op, operands);
        expect(result).not.toBeNull();
        const report = compareOnGrid(op, operands, result!, { steps: 40 });
        expect(report.mismatches).toEqual([]);
        const ms = medianMs(() => booleanOperation(op, operands));
        expect(ms, `${name} ${op}: ${ms.toFixed(2)} ms`).toBeLessThan(BUDGET_MS);
      }
    });
  }
});
