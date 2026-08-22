import { describe, expect, it } from "vitest";

import { evaluateContrast } from "./contrast";

describe("WCAG contrast", () => {
  it("returns 21:1 for black on white", () => {
    const result = evaluateContrast("#000", "#fff");
    expect(result.ratio).toBeCloseTo(21, 5);
    expect(result.normalAAA).toBe(true);
    expect(Object.keys(result.simulations)).toEqual(["protanopia", "deuteranopia", "tritanopia"]);
  });

  it("rejects transparent colors", () => {
    expect(() => evaluateContrast("rgb(0 0 0 / 50%)", "white")).toThrow(/不透明/);
  });
});
