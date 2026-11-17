import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import {
  cubicFlatness,
  cubicSegment,
  derivativeAt,
  distance,
  distanceToLineSegment,
  flattenSegment,
  flattenSegmentParams,
  isDegenerate,
  isStraight,
  lineSegment,
  nearestPoint,
  pointAt,
  quadraticToCubic,
  reverseSegment,
  secondDerivativeAt,
  segmentBounds,
  segmentExtrema,
  segmentLength,
  solveQuadratic,
  splitSegment,
  subSegment,
  tangentAt,
  tAtLength,
  toCubic,
  transformSegment,
  type CubicSegment,
} from "./bezier";
import { rotate } from "./matrix";

const K = 0.5522847498;
/** 半径 r の円の右下 1/4 (時計回り: (r, 0) → (0, r))。 */
function quarter(r: number): CubicSegment {
  return cubicSegment({ x: r, y: 0 }, { x: r, y: K * r }, { x: K * r, y: r }, { x: 0, y: r });
}
const S = cubicSegment({ x: 0, y: 0 }, { x: 30, y: 100 }, { x: 70, y: -100 }, { x: 100, y: 0 });

function close(p: Point, q: Point, eps = 1e-9) {
  expect(distance(p, q)).toBeLessThanOrEqual(eps);
}

describe("values and derivatives", () => {
  it("evaluates endpoints exactly and known midpoints", () => {
    expect(pointAt(S, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(S, 1)).toEqual({ x: 100, y: 0 });
    // B(0.5) = (P0 + 3P1 + 3P2 + P3) / 8
    close(pointAt(S, 0.5), { x: (0 + 90 + 210 + 100) / 8, y: 0 });
    close(pointAt(lineSegment({ x: 0, y: 0 }, { x: 10, y: 20 }), 0.25), { x: 2.5, y: 5 });
  });

  it("matches finite differences", () => {
    const h = 1e-6;
    for (const t of [0.1, 0.37, 0.8]) {
      const d = derivativeAt(S, t);
      const p1 = pointAt(S, t + h);
      const p0 = pointAt(S, t - h);
      expect(d.x).toBeCloseTo((p1.x - p0.x) / (2 * h), 3);
      expect(d.y).toBeCloseTo((p1.y - p0.y) / (2 * h), 3);
      const dd = secondDerivativeAt(S, t);
      const d1 = derivativeAt(S, t + h);
      const d0 = derivativeAt(S, t - h);
      expect(dd.x).toBeCloseTo((d1.x - d0.x) / (2 * h), 2);
      expect(dd.y).toBeCloseTo((d1.y - d0.y) / (2 * h), 2);
    }
  });

  it("finds the tangent where the handle collapses onto the end point", () => {
    // c1 = from: 始点の微分は 0 だが、曲線は c2 へ向かって進む
    const seg = cubicSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 });
    close(tangentAt(seg, 0)!, { x: Math.SQRT1_2, y: Math.SQRT1_2 });
    // c2 = to: 終点では c1 から来る向き
    const end = cubicSegment({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 20, y: 0 });
    close(tangentAt(end, 1)!, { x: Math.SQRT1_2, y: -Math.SQRT1_2 });
    // 両方のハンドルが潰れた曲線は弦の向き
    const flat = cubicSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 });
    close(tangentAt(flat, 0)!, { x: 1, y: 0 });
    close(tangentAt(flat, 1)!, { x: 1, y: 0 });
    const point = cubicSegment({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 });
    expect(tangentAt(point, 0.5)).toBeNull();
  });

  it("converts quadratics and lines to cubics exactly", () => {
    const q = quadraticToCubic({ x: 0, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 0 });
    for (const t of [0, 0.2, 0.5, 0.9, 1]) {
      const mt = 1 - t;
      close(pointAt(q, t), { x: 2 * mt * t * 50 + t * t * 100, y: 2 * mt * t * 100 });
    }
    const l = lineSegment({ x: 1, y: 2 }, { x: 7, y: -4 });
    const c = toCubic(l);
    for (const t of [0, 0.3, 1]) close(pointAt(c, t), pointAt(l, t));
  });
});

describe("bounds", () => {
  it("does not include handles", () => {
    const b = segmentBounds(quarter(100));
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const s = segmentBounds(S);
    // S の極値: y の最大と最小は ±28.87 付近 (制御点の ±100 より内側)
    expect(s.minX).toBe(0);
    expect(s.maxX).toBe(100);
    expect(s.maxY).toBeGreaterThan(28);
    expect(s.maxY).toBeLessThan(30);
    expect(s.minY).toBeCloseTo(-s.maxY, 10);
  });

  it("finds extrema of a full arch", () => {
    const arch = cubicSegment(
      { x: 0, y: 0 },
      { x: 0, y: -40 },
      { x: 100, y: -40 },
      { x: 100, y: 0 },
    );
    const { x, y } = segmentExtrema(arch);
    expect(x).toEqual([]);
    expect(y).toHaveLength(1);
    expect(y[0]).toBeCloseTo(0.5, 12);
    expect(segmentBounds(arch).minY).toBeCloseTo(-30, 12);
  });

  it("handles degenerate segments", () => {
    const p = { x: 3, y: 4 };
    expect(segmentBounds(cubicSegment(p, p, p, p))).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 });
    expect(segmentExtrema(lineSegment(p, p))).toEqual({ x: [], y: [] });
  });

  it("follows the transformed shape (a rotated circle does not grow)", () => {
    const r = 50;
    const turned = transformSegment(quarter(r), rotate(45));
    const b = segmentBounds(turned);
    // 45° から 135° の円弧: x は ±r/√2、y は r/√2 から r (制御点の範囲ではない)
    expect(b.maxX).toBeCloseTo(r * Math.SQRT1_2, 9);
    expect(b.minX).toBeCloseTo(-r * Math.SQRT1_2, 9);
    expect(b.minY).toBeCloseTo(r * Math.SQRT1_2, 9);
    expect(Math.abs(b.maxY - r)).toBeLessThan(r * 3e-4);
  });
});

describe("split and sub-segments", () => {
  it("splits so that both halves match the original", () => {
    const [a, b] = splitSegment(S, 0.3);
    expect(a.from).toEqual(S.from);
    expect(b.to).toEqual(S.to);
    expect(a.to).toEqual(b.from);
    for (const s of [0, 0.25, 0.5, 1]) {
      close(pointAt(a, s), pointAt(S, 0.3 * s));
      close(pointAt(b, s), pointAt(S, 0.3 + 0.7 * s));
    }
  });

  it("cuts a sub-range, including reversed ranges", () => {
    const sub = subSegment(S, 0.2, 0.7);
    for (const s of [0, 0.4, 1]) close(pointAt(sub, s), pointAt(S, 0.2 + 0.5 * s));
    const rev = subSegment(S, 0.7, 0.2);
    for (const s of [0, 0.4, 1]) close(pointAt(rev, s), pointAt(S, 0.7 - 0.5 * s));
    const whole = subSegment(S, 0, 1);
    expect(whole).toEqual(S);
    const line = subSegment(lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }), 0.5, 1);
    expect(line).toEqual({ kind: "line", from: { x: 5, y: 0 }, to: { x: 10, y: 0 } });
  });

  it("does not accumulate error over repeated splitting", () => {
    let part: CubicSegment = S;
    const t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 30; i++) {
      const [left] = splitSegment(part, 0.5) as [CubicSegment, CubicSegment];
      part = left;
      t1 = (t0 + t1) / 2;
    }
    close(part.to, pointAt(S, t1), 1e-9);
    expect(part.from).toEqual(S.from);
  });

  it("reverses", () => {
    const r = reverseSegment(S);
    for (const t of [0, 0.3, 1]) close(pointAt(r, t), pointAt(S, 1 - t));
  });
});

describe("nearest point", () => {
  it("projects onto lines and clamps to the ends", () => {
    const l = lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(nearestPoint(l, { x: 3, y: 4 })).toEqual({ t: 0.3, point: { x: 3, y: 0 }, distance: 4 });
    expect(nearestPoint(l, { x: -5, y: 0 }).t).toBe(0);
    expect(nearestPoint(l, { x: 15, y: 0 }).t).toBe(1);
    const zero = lineSegment({ x: 1, y: 1 }, { x: 1, y: 1 });
    expect(nearestPoint(zero, { x: 4, y: 5 }).distance).toBe(5);
  });

  it("finds the closest point on a circle arc from its center direction", () => {
    const q = quarter(100);
    const n = nearestPoint(q, { x: 200, y: 200 });
    // 円の 45° の点 (近似の円なので半径の誤差は 0.03% 以内)
    expect(n.point.x).toBeCloseTo(n.point.y, 6);
    expect(Math.hypot(n.point.x, n.point.y)).toBeCloseTo(100, 1);
    expect(n.t).toBeCloseTo(0.5, 6);
    // 曲線上の点なら距離 0
    const on = pointAt(S, 0.4321);
    const m = nearestPoint(S, on);
    expect(m.distance).toBeLessThan(1e-9);
    expect(m.t).toBeCloseTo(0.4321, 9);
  });

  it("agrees with brute force sampling", () => {
    const probes = [
      { x: 50, y: 50 },
      { x: -20, y: 10 },
      { x: 120, y: -5 },
      { x: 50, y: 0 },
      { x: 33, y: 40 },
    ];
    for (const p of probes) {
      const n = nearestPoint(S, p);
      let best = Infinity;
      for (let i = 0; i <= 20000; i++) best = Math.min(best, distance(pointAt(S, i / 20000), p));
      expect(n.distance).toBeLessThanOrEqual(best + 1e-9);
      expect(n.distance).toBeGreaterThan(best - 1e-3);
    }
  });
});

describe("length", () => {
  it("measures lines and known curves", () => {
    expect(segmentLength(lineSegment({ x: 0, y: 0 }, { x: 3, y: 4 }))).toBe(5);
    expect(segmentLength(lineSegment({ x: 0, y: 0 }, { x: 3, y: 4 }), 0.2, 0.6)).toBeCloseTo(2, 12);
    // 1/4 円 (κ の近似) の長さは πr/2 にごく近い
    expect(segmentLength(quarter(100))).toBeCloseTo((Math.PI * 100) / 2, 1);
    // 直線上に並んだ制御点 (速さが一定でない) でも長さは弦と同じ
    const straight = cubicSegment({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 10, y: 0 });
    expect(segmentLength(straight)).toBeCloseTo(10, 9);
    const p = { x: 2, y: 2 };
    expect(segmentLength(cubicSegment(p, p, p, p))).toBe(0);
  });

  it("adds up over sub-ranges and is symmetric", () => {
    const whole = segmentLength(S);
    expect(segmentLength(S, 0, 0.4) + segmentLength(S, 0.4, 1)).toBeCloseTo(whole, 9);
    expect(segmentLength(S, 0.7, 0.2)).toBeCloseTo(segmentLength(S, 0.2, 0.7), 12);
    // 折れ線の長さとも合う
    const pts = flattenSegment(S, 1e-6);
    let poly = 0;
    for (let i = 1; i < pts.length; i++) poly += distance(pts[i - 1]!, pts[i]!);
    expect(poly).toBeCloseTo(whole, 3);
  });

  it("inverts length to t", () => {
    const total = segmentLength(S);
    for (const frac of [0, 0.1, 0.5, 0.93, 1]) {
      const t = tAtLength(S, total * frac);
      expect(segmentLength(S, 0, t)).toBeCloseTo(total * frac, 6);
    }
    expect(tAtLength(S, -1)).toBe(0);
    expect(tAtLength(S, total * 2)).toBe(1);
    expect(tAtLength(lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }), 2.5)).toBe(0.25);
  });
});

describe("flatten", () => {
  it("keeps every polyline vertex within the tolerance of the curve and vice versa", () => {
    for (const tol of [1, 0.1, 0.001]) {
      const ts = flattenSegmentParams(S, tol);
      expect(ts[0]).toBe(0);
      expect(ts[ts.length - 1]).toBe(1);
      const pts = ts.map((t) => pointAt(S, t));
      for (let i = 1; i < ts.length; i++) {
        // 区間の途中の曲線の点は弦から tol 以内
        for (const s of [0.25, 0.5, 0.75]) {
          const t = ts[i - 1]! + (ts[i]! - ts[i - 1]!) * s;
          expect(distanceToLineSegment(pointAt(S, t), pts[i - 1]!, pts[i]!)).toBeLessThanOrEqual(
            tol + 1e-12,
          );
        }
      }
    }
    expect(flattenSegment(S, 0.001).length).toBeGreaterThan(flattenSegment(S, 1).length);
  });

  it("returns the end points for lines and straight cubics", () => {
    expect(flattenSegment(lineSegment({ x: 0, y: 0 }, { x: 1, y: 1 }), 0.1)).toHaveLength(2);
    const straight = cubicSegment({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 10, y: 0 });
    expect(flattenSegment(straight, 0.1)).toHaveLength(2);
    expect(isStraight(straight, 1e-9)).toBe(true);
    expect(cubicFlatness(straight)).toBe(0);
  });

  it("survives a zero or negative tolerance", () => {
    const pts = flattenSegment(quarter(10), 0);
    expect(pts.length).toBeGreaterThan(2);
    expect(pts.length).toBeLessThanOrEqual(2 ** 24 + 1);
  });

  it("detects degenerate segments", () => {
    const p = { x: 1, y: 1 };
    expect(isDegenerate(cubicSegment(p, p, { x: 1, y: 1.0000001 }, p), 1e-6)).toBe(true);
    expect(isDegenerate(S, 1e-6)).toBe(false);
  });
});

describe("solveQuadratic", () => {
  it("solves regular, linear, double-root and cancellation-prone cases", () => {
    expect(solveQuadratic(1, -3, 2).sort()).toEqual([1, 2]);
    expect(solveQuadratic(0, 2, -4)).toEqual([2]);
    expect(solveQuadratic(1, -2, 1)).toEqual([1]);
    expect(solveQuadratic(1, 0, 1)).toEqual([]);
    expect(solveQuadratic(0, 0, 1)).toEqual([]);
    const roots = solveQuadratic(1, -1e8, 1).sort((a, b) => a - b);
    expect(roots[0]).toBeCloseTo(1e-8, 20);
    expect(roots[1]).toBeCloseTo(1e8, 0);
  });
});
