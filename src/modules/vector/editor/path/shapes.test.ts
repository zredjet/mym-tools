import { describe, expect, it } from "vitest";
import { distance, pointAt } from "../geometry/bezier";
import { pathBounds, signedArea } from "./measure";
import { subpathToSegments } from "./segments";
import { ELLIPSE_KAPPA, ellipseSubpaths, lineSubpaths, rectSubpaths } from "./shapes";

describe("rectSubpaths", () => {
  it("starts at the top-left and goes clockwise without radius", () => {
    const [r] = rectSubpaths(100, 50, 0);
    expect(r!.closed).toBe(true);
    expect(r!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ]);
    expect(r!.points.every((p) => p.in === null && p.out === null && p.mirror === "none")).toBe(
      true,
    );
  });

  it("starts at (rx, 0) with rounded corners like the SVG 2 rect path", () => {
    const [r] = rectSubpaths(100, 50, 10);
    expect(r!.points).toHaveLength(8);
    expect(r!.points[0]).toMatchObject({ x: 10, y: 0, out: null, mirror: "none" });
    expect(r!.points[0]!.in).toEqual({ x: -ELLIPSE_KAPPA * 10, y: 0 });
    expect(r!.points[1]).toMatchObject({ x: 90, y: 0, in: null });
    expect(signedArea(r!)).toBeGreaterThan(0);
    expect(pathBounds([r!])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
  });

  it("clamps the radius per axis (rx = min(r, w/2), ry = min(r, h/2))", () => {
    const [r] = rectSubpaths(100, 50, 30);
    // ry = 25 なので縦の辺は長さ 0: 点をまとめて 6 個
    expect(r!.points).toHaveLength(6);
    expect(r!.points.map((p) => [p.x, p.y])).toEqual([
      [30, 0],
      [70, 0],
      [100, 25],
      [70, 50],
      [30, 50],
      [0, 25],
    ]);
    // まとめた点は両方のハンドルを持つ
    expect(r!.points[2]!.in).toEqual({ x: 0, y: -ELLIPSE_KAPPA * 25 });
    expect(r!.points[2]!.out).toEqual({ x: 0, y: ELLIPSE_KAPPA * 25 });
    expect(r!.points[2]!.mirror).toBe("angle-length");

    const [pill] = rectSubpaths(100, 50, 1000);
    // rx = 50, ry = 25: 楕円と同じ形 (始点は上の中央)
    expect(pill!.points.map((p) => [p.x, p.y])).toEqual([
      [50, 0],
      [100, 25],
      [50, 50],
      [0, 25],
    ]);
    const [ellipse] = ellipseSubpaths(100, 50);
    expect(signedArea(pill!)).toBeCloseTo(signedArea(ellipse!), 9);
  });

  it("draws nothing for zero-size rectangles, like SVG", () => {
    expect(rectSubpaths(0, 50, 0)).toEqual([]);
    expect(rectSubpaths(50, 0, 5)).toEqual([]);
    expect(rectSubpaths(0, 0, 5)).toEqual([]);
    expect(rectSubpaths(-5, 10, 0)).toEqual([]);
    expect(rectSubpaths(Number.NaN, 10, 0)).toEqual([]);
    // 負の角丸は 0
    expect(rectSubpaths(10, 10, -1)[0]!.points).toHaveLength(4);
  });

  it("matches a circle for the rounded corner", () => {
    const [r] = rectSubpaths(100, 100, 20);
    const corner = subpathToSegments(r!)[1]!; // (80, 0) → (100, 20)
    for (const t of [0.25, 0.5, 0.75]) {
      const d = distance(pointAt(corner, t), { x: 80, y: 20 });
      expect(Math.abs(d - 20)).toBeLessThan(20 * 3e-4);
    }
  });
});

describe("ellipseSubpaths", () => {
  it("starts at (cx + rx, cy) and goes clockwise with four cubic curves", () => {
    const [e] = ellipseSubpaths(100, 50);
    expect(e!.points.map((p) => [p.x, p.y])).toEqual([
      [100, 25],
      [50, 50],
      [0, 25],
      [50, 0],
    ]);
    expect(e!.points.every((p) => p.mirror === "angle-length")).toBe(true);
    expect(e!.points[0]!.out).toEqual({ x: 0, y: ELLIPSE_KAPPA * 25 });
    expect(signedArea(e!)).toBeGreaterThan(0);
    const segs = subpathToSegments(e!);
    expect(segs).toHaveLength(4);
    expect(segs.every((s) => s.kind === "cubic")).toBe(true);
  });

  it("draws nothing for zero-size ellipses, like SVG", () => {
    expect(ellipseSubpaths(0, 10)).toEqual([]);
    expect(ellipseSubpaths(10, 0)).toEqual([]);
    expect(ellipseSubpaths(-1, -1)).toEqual([]);
  });

  it("stays within 0.03% of the true circle", () => {
    const [c] = ellipseSubpaths(200, 200);
    for (const seg of subpathToSegments(c!)) {
      for (let i = 0; i <= 20; i++) {
        const d = distance(pointAt(seg, i / 20), { x: 100, y: 100 });
        expect(Math.abs(d - 100)).toBeLessThan(100 * 3e-4);
      }
    }
  });
});

describe("lineSubpaths", () => {
  it("is an open outline from start to end", () => {
    expect(lineSubpaths({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual([
      {
        closed: false,
        points: [
          { x: 1, y: 2, in: null, out: null, mirror: "none" },
          { x: 3, y: 4, in: null, out: null, mirror: "none" },
        ],
      },
    ]);
  });
});
