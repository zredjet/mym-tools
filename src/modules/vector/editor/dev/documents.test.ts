import { describe, expect, it } from "vitest";
import { getBooleanEvaluation } from "../boolean/result";
import { checkSavable } from "../model/payload";
import { HARNESS_DOCUMENTS, stage2Document } from "./documents";

describe("開発用の画面の文書", () => {
  for (const [name, make] of Object.entries(HARNESS_DOCUMENTS))
    it(`${name} は payload v3 の検証を通る`, () => {
      expect(checkSavable(make())).toBeNull();
    });

  it("stage2 は第 2 段階のノードと線の値を含む", () => {
    const nodes = Object.values(stage2Document().nodes);
    const types = new Set(nodes.map((node) => node.type));
    for (const type of ["frame", "rect", "ellipse", "text", "line", "path", "boolean"])
      expect(types).toContain(type);
    expect(
      nodes.some((node) => "rotation" in node && node.rotation !== 0 && node.type === "frame"),
    ).toBe(true);
    const strokes = nodes.flatMap((node) => ("stroke" in node && node.stroke ? [node.stroke] : []));
    expect(new Set(strokes.map((stroke) => stroke.cap))).toEqual(
      new Set(["butt", "round", "square"]),
    );
    expect(new Set(strokes.map((stroke) => stroke.join))).toEqual(
      new Set(["miter", "round", "bevel"]),
    );
    expect(strokes.some((stroke) => stroke.dash.length > 0)).toBe(true);
    const doc = stage2Document();
    expect(nodes.filter((node) => node.type === "boolean").map((node) => node.op)).toEqual(
      expect.arrayContaining(["union", "subtract", "intersect", "exclude"]),
    );
    expect(getBooleanEvaluation(doc, "nested")?.operands.length).toBeGreaterThan(0);
  });
});
