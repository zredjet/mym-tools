import { describe, expect, it } from "vitest";
import { pathBounds, signedArea } from "./measure";
import {
  clampSides,
  clampStarRatio,
  polygonSubpath,
  POLYGON_MAX_SIDES,
  starSubpath,
  STAR_MIN_RATIO,
} from "./polygon";

const box = { x: 10, y: 20, width: 100, height: 80 };

describe("polygonSubpath", () => {
  it("puts the first vertex at the top center and fills the rectangle", () => {
    const tri = polygonSubpath(3, box);
    expect(tri.closed).toBe(true);
    expect(tri.points).toHaveLength(3);
    expect(tri.points[0]!.x).toBeCloseTo(60, 12);
    expect(tri.points[0]!.y).toBe(20);
    // 底の 2 頂点は矩形の下の角
    expect(tri.points[1]).toMatchObject({ x: 110, y: 100 });
    expect(tri.points[2]).toMatchObject({ x: 10, y: 100 });
    expect(pathBounds([tri])).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 100 });
    expect(tri.points.every((p) => p.in === null && p.out === null && p.mirror === "none")).toBe(
      true,
    );
    expect(signedArea(tri)).toBeGreaterThan(0); // 時計回り
  });

  it("makes a diamond for 4 sides and a symmetric hexagon", () => {
    const sq = polygonSubpath(4, { x: 0, y: 0, width: 100, height: 100 });
    expect(sq.points.map((p) => [p.x, p.y])).toEqual([
      [50, 0],
      [100, 50],
      [50, 100],
      [0, 50],
    ]);
    const hex = polygonSubpath(6, { x: 0, y: 0, width: 100, height: 100 });
    expect(hex.points).toHaveLength(6);
    expect(pathBounds([hex])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(hex.points[3]!.x).toBeCloseTo(50, 12);
    expect(hex.points[3]!.y).toBe(100);
  });

  it("clamps the number of sides", () => {
    expect(polygonSubpath(2, box).points).toHaveLength(3);
    expect(polygonSubpath(1000, box).points).toHaveLength(POLYGON_MAX_SIDES);
    expect(polygonSubpath(5.9, box).points).toHaveLength(5);
    expect(clampSides(Number.NaN)).toBe(3);
  });

  it("collapses a zero-height rectangle onto a line", () => {
    const flat = polygonSubpath(5, { x: 0, y: 7, width: 50, height: 0 });
    expect(flat.points.every((p) => p.y === 7)).toBe(true);
  });
});

describe("starSubpath", () => {
  it("alternates outer and inner vertices and fills the rectangle", () => {
    const star = starSubpath(5, 0.382, box);
    expect(star.points).toHaveLength(10);
    expect(star.points[0]!.x).toBeCloseTo(60, 12);
    expect(star.points[0]!.y).toBe(20);
    expect(pathBounds([star])).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 100 });
    expect(signedArea(star)).toBeGreaterThan(0);
    // 内側の頂点は中心に近い (正規化した距離で比べる)
    const cx = 60;
    const outer = star.points[0]!;
    const inner = star.points[1]!;
    expect(Math.abs(inner.x - cx)).toBeLessThan(Math.abs(star.points[2]!.x - cx));
    expect(inner.y).toBeGreaterThan(outer.y);
  });

  it("becomes a regular 2n-gon with ratio 1 and clamps the ratio", () => {
    const s = starSubpath(4, 1, { x: 0, y: 0, width: 100, height: 100 });
    expect(s.points).toHaveLength(8);
    expect(clampStarRatio(0)).toBe(STAR_MIN_RATIO);
    expect(clampStarRatio(5)).toBe(1);
    expect(clampStarRatio(Number.NaN)).toBe(0.382);
    const thin = starSubpath(5, 0, box);
    expect(thin.points).toHaveLength(10);
  });
});
