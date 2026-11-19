import { describe, expect, it } from "vitest";

import { CANVAS_LIMITS } from "../../model/limits";
import { formatDash, parseDashInput } from "./dash";

describe("parseDashInput (§5.3、§3.5)", () => {
  it("スペースとカンマ (全角を含む) で区切る。空は実線", () => {
    expect(parseDashInput("4 2")).toEqual([4, 2]);
    expect(parseDashInput(" 4,2 , 1 ")).toEqual([4, 2, 1]);
    expect(parseDashInput("４，２　１、3")).toEqual([4, 2, 1, 3]);
    expect(parseDashInput("")).toEqual([]);
    expect(parseDashInput("   ")).toEqual([]);
    expect(parseDashInput("0 4")).toEqual([0, 4]);
    expect(parseDashInput("1.234 0.5")).toEqual([1.23, 0.5]);
  });

  it("規則に合わない入力は null", () => {
    expect(parseDashInput("a")).toBeNull();
    expect(parseDashInput("-1 2")).toBeNull();
    expect(parseDashInput("0 0")).toBeNull();
    expect(parseDashInput(String(CANVAS_LIMITS.maxDashLength + 1))).toBeNull();
    expect(
      parseDashInput(
        Array(CANVAS_LIMITS.maxDashCount + 1)
          .fill("1")
          .join(" "),
      ),
    ).toBeNull();
    expect(parseDashInput(Array(CANVAS_LIMITS.maxDashCount).fill("1").join(" "))).toHaveLength(
      CANVAS_LIMITS.maxDashCount,
    );
  });

  it("表示はスペース区切り", () => {
    expect(formatDash([4, 2.5])).toBe("4 2.5");
    expect(formatDash([])).toBe("");
  });
});
