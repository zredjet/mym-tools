/**
 * 求められなかったとき (交点を探し尽くせなかった、計算の中の例外) は null を返し、例外を投げない。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { booleanOperation } from "./index";
import { ellipse, operand, rect } from "./testing";

const mode = vi.hoisted(() => ({ value: "normal" as "normal" | "incomplete" | "throw" }));

vi.mock("../geometry/intersect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../geometry/intersect")>();
  return {
    ...actual,
    intersectSegments: (...args: Parameters<typeof actual.intersectSegments>) => {
      if (mode.value === "throw") throw new Error("boom");
      const r = actual.intersectSegments(...args);
      return mode.value === "incomplete" ? { ...r, complete: false } : r;
    },
  };
});

afterEach(() => {
  mode.value = "normal";
});

describe("booleanOperation が求められないとき", () => {
  const operands = [operand(ellipse(50, 50, 40)), operand(rect(40, 40, 60, 60))];

  it("交点を探し尽くせなかったら null", () => {
    expect(booleanOperation("union", operands)).not.toBeNull();
    mode.value = "incomplete";
    for (const op of ["union", "subtract", "intersect", "exclude"] as const) {
      expect(booleanOperation(op, operands)).toBeNull();
    }
  });

  it("計算の中の例外は null にする (投げない)", () => {
    mode.value = "throw";
    expect(() => booleanOperation("union", operands)).not.toThrow();
    expect(booleanOperation("union", operands)).toBeNull();
  });

  it("交わる組がなければ、交点を求めずに済む (打ち切りの影響を受けない)", () => {
    mode.value = "incomplete";
    // 離れた 2 つの形: 範囲の重なる組がない
    const apart = [operand(rect(0, 0, 10, 10)), operand(rect(50, 50, 10, 10))];
    expect(booleanOperation("union", apart)).toHaveLength(2);
  });
});
