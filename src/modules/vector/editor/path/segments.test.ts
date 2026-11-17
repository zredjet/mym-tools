import { describe, expect, it } from "vitest";
import { cubicSegment, lineSegment, pointAt } from "../geometry/bezier";
import type { PathPoint, Subpath } from "../model/types";
import { inferMirror, segmentsToSubpath, subpathsToSegments, subpathToSegments } from "./segments";
import { ellipseSubpaths } from "./shapes";

function corner(x: number, y: number): PathPoint {
  return { x, y, in: null, out: null, mirror: "none" };
}
const square: Subpath = {
  closed: true,
  points: [corner(0, 0), corner(10, 0), corner(10, 10), corner(0, 10)],
};

describe("subpathToSegments", () => {
  it("makes lines between points and a closing edge for closed subpaths", () => {
    const segs = subpathToSegments(square);
    expect(segs).toHaveLength(4);
    expect(segs.every((s) => s.kind === "line")).toBe(true);
    expect(segs[3]).toEqual(lineSegment({ x: 0, y: 10 }, { x: 0, y: 0 }));
    const open = subpathToSegments({ ...square, closed: false });
    expect(open).toHaveLength(3);
    const implicit = subpathToSegments({ ...square, closed: false }, { implicitClose: true });
    expect(implicit).toHaveLength(4);
    // 終点が始点と同じ開いた輪郭には閉じる辺を足さない
    const loop = { closed: false, points: [...square.points, corner(0, 0)] };
    expect(subpathToSegments(loop, { implicitClose: true })).toHaveLength(4);
  });

  it("uses the point itself for a missing handle (same rule as d)", () => {
    const sub: Subpath = {
      closed: false,
      points: [corner(0, 0), { x: 10, y: 0, in: { x: 0, y: -5 }, out: null, mirror: "none" }],
    };
    expect(subpathToSegments(sub)).toEqual([
      cubicSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: -5 }, { x: 10, y: 0 }),
    ]);
  });

  it("returns nothing for single-point subpaths", () => {
    expect(subpathToSegments({ closed: true, points: [corner(1, 1)] })).toEqual([]);
    expect(subpathsToSegments([square, { closed: false, points: [corner(1, 1)] }])[1]).toEqual([]);
  });
});

describe("segmentsToSubpath", () => {
  it("round-trips an ellipse", () => {
    const [ellipse] = ellipseSubpaths(100, 50);
    const back = segmentsToSubpath(subpathToSegments(ellipse!), true);
    expect(back.closed).toBe(true);
    expect(back.points).toHaveLength(4);
    back.points.forEach((p, i) => {
      const q = ellipse!.points[i]!;
      expect(p.x).toBe(q.x);
      expect(p.y).toBe(q.y);
      expect(p.mirror).toBe("angle-length");
      expect(p.in!.x).toBeCloseTo(q.in!.x, 12);
      expect(p.in!.y).toBeCloseTo(q.in!.y, 12);
      expect(p.out!.x).toBeCloseTo(q.out!.x, 12);
      expect(p.out!.y).toBeCloseTo(q.out!.y, 12);
    });
  });

  it("round-trips open and closed polylines", () => {
    expect(segmentsToSubpath(subpathToSegments(square), true)).toEqual(square);
    const open = { ...square, closed: false };
    expect(segmentsToSubpath(subpathToSegments(open), false)).toEqual(open);
  });

  it("keeps a gap before the closing edge as an extra point", () => {
    const segs = [
      lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }),
      lineSegment({ x: 10, y: 0 }, { x: 10, y: 10 }),
    ];
    const sub = segmentsToSubpath(segs, true);
    expect(sub.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it("merges a closing segment that returns to the start within rounding", () => {
    const segs = [
      lineSegment({ x: 0.1, y: 0.2 }, { x: 10, y: 0 }),
      cubicSegment({ x: 10, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 10 }, { x: 0.1 + 1e-15, y: 0.2 }),
    ];
    const sub = segmentsToSubpath(segs, true);
    expect(sub.points).toHaveLength(2);
    expect(sub.points[0]!.in!.x).toBeCloseTo(4.9, 12);
    expect(sub.points[0]!.in!.y).toBeCloseTo(9.8, 12);
    expect(sub.points[0]!.x).toBe(0.1);
  });

  it("uses the same tolerance as the intersections for the closing point", () => {
    // 5e-8 px のずれは交点の許容値 (1e-7) の中: 閉じる辺にまとめる
    const segs = [
      lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }),
      lineSegment({ x: 10, y: 0 }, { x: 10, y: 10 }),
      lineSegment({ x: 10, y: 10 }, { x: 0, y: 5e-8 }),
    ];
    expect(segmentsToSubpath(segs, true).points).toHaveLength(3);
    // 許容値を渡せる
    expect(segmentsToSubpath(segs, true, { tolerance: 1e-9 }).points).toHaveLength(4);
    const far = [...segs.slice(0, 2), lineSegment({ x: 10, y: 10 }, { x: 0, y: 1e-6 })];
    expect(segmentsToSubpath(far, true).points).toHaveLength(4);
  });

  it("splits a single closed loop into two points", () => {
    const loop = cubicSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 0 });
    const sub = segmentsToSubpath([loop], true);
    expect(sub.points).toHaveLength(2);
    const segs = subpathToSegments(sub);
    expect(segs).toHaveLength(2);
    const mid = pointAt(loop, 0.5);
    expect(segs[0]!.to.x).toBeCloseTo(mid.x, 12);
    expect(segs[0]!.to.y).toBeCloseTo(mid.y, 12);
  });

  it("drops zero-length handles", () => {
    const segs = [cubicSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 })];
    const sub = segmentsToSubpath(segs, false);
    expect(sub.points[0]!.out).toBeNull();
    expect(sub.points[1]!.in).toEqual({ x: -5, y: 5 });
  });

  it("rejects an empty list", () => {
    expect(() => segmentsToSubpath([], false)).toThrow(RangeError);
  });
});

describe("inferMirror", () => {
  it("classifies handle pairs", () => {
    expect(inferMirror(null, { x: 1, y: 0 })).toBe("none");
    expect(inferMirror({ x: -2, y: 0 }, { x: 2, y: 0 })).toBe("angle-length");
    expect(inferMirror({ x: -1, y: -1 }, { x: 3, y: 3 })).toBe("angle");
    expect(inferMirror({ x: 1, y: 0 }, { x: 2, y: 0 })).toBe("none");
    expect(inferMirror({ x: -1, y: 0.1 }, { x: 1, y: 0 })).toBe("none");
    expect(inferMirror({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe("none");
  });
});
