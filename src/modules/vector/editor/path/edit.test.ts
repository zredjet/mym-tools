import { describe, expect, it } from "vitest";
import { distance, nearestPoint, pointAt } from "../geometry/bezier";
import type { PathPoint, Subpath } from "../model/types";
import { insertPointAt } from "./edit";
import { subpathToSegments } from "./segments";
import { ellipseSubpaths, rectSubpaths } from "./shapes";

function corner(x: number, y: number): PathPoint {
  return { x, y, in: null, out: null, mirror: "none" };
}

/** 輪郭の形が同じ (a の曲線の点がすべて b の輪郭の上にある)。 */
function expectSameShape(a: Subpath, b: Subpath) {
  const bs = subpathToSegments(b);
  for (const seg of subpathToSegments(a)) {
    for (let i = 0; i <= 10; i++) {
      const p = pointAt(seg, i / 10);
      const d = Math.min(...bs.map((s) => nearestPoint(s, p).distance));
      expect(d).toBeLessThan(1e-9);
    }
  }
}

describe("insertPointAt", () => {
  it("adds a corner point on a line without touching other points", () => {
    const [rect] = rectSubpaths(100, 50, 0);
    const out = insertPointAt(rect!, 0, 0.25);
    expect(out.points).toHaveLength(5);
    expect(out.points[1]).toEqual(corner(25, 0));
    expect(out.points[0]).toBe(rect!.points[0]);
    expect(out.points[2]).toBe(rect!.points[1]);
    expect(out.points[4]).toBe(rect!.points[3]);
    expect(out.closed).toBe(true);
  });

  it("splits a curve without changing its shape and edits only the two neighbours", () => {
    const [ellipse] = ellipseSubpaths(100, 50);
    const out = insertPointAt(ellipse!, 1, 0.3);
    expect(out.points).toHaveLength(5);
    expectSameShape(ellipse!, out);
    expectSameShape(out, ellipse!);
    // 辺 1 は点 1 → 点 2。足した点は 2 番目に入る
    expect(out.points[0]).toBe(ellipse!.points[0]);
    expect(out.points[4]).toBe(ellipse!.points[3]);
    const added = out.points[2]!;
    expect(added.mirror).toBe("angle");
    expect(added.in).not.toBeNull();
    expect(added.out).not.toBeNull();
    // 前後の点はハンドルの長さが変わるので angle-length から angle へ
    expect(out.points[1]!.mirror).toBe("angle");
    expect(out.points[3]!.mirror).toBe("angle");
    // 変えなかった側のハンドルはそのまま
    expect(out.points[1]!.in).toEqual(ellipse!.points[1]!.in);
    expect(out.points[3]!.out).toEqual(ellipse!.points[2]!.out);
  });

  it("splits the closing edge and appends the point at the end", () => {
    const [ellipse] = ellipseSubpaths(100, 50);
    const out = insertPointAt(ellipse!, 3, 0.5);
    expect(out.points).toHaveLength(5);
    expect(out.points[4]!.x).toBeCloseTo(50 + 50 * Math.SQRT1_2, 1);
    expectSameShape(ellipse!, out);
    expect(out.points[1]).toBe(ellipse!.points[1]);
  });

  it("keeps null handles null (the control point stays on the point)", () => {
    const sub: Subpath = {
      closed: false,
      points: [corner(0, 0), { x: 100, y: 0, in: { x: 0, y: -50 }, out: null, mirror: "none" }],
    };
    const out = insertPointAt(sub, 0, 0.5);
    expect(out.points[0]!.out).toBeNull();
    expect(out.points[0]).toBe(sub.points[0]);
    expect(out.points[2]!.in).not.toBeNull();
    expectSameShape(sub, out);
    const seg = subpathToSegments(sub)[0]!;
    expect(distance(out.points[1]!, pointAt(seg, 0.5))).toBeLessThan(1e-12);
  });

  it("ignores t at the ends and rejects missing segments", () => {
    const [rect] = rectSubpaths(10, 10, 0);
    expect(insertPointAt(rect!, 0, 0)).toBe(rect);
    expect(insertPointAt(rect!, 0, 1)).toBe(rect);
    expect(insertPointAt(rect!, 0, Number.NaN)).toBe(rect);
    expect(() => insertPointAt(rect!, 4, 0.5)).toThrow(RangeError);
    expect(() => insertPointAt({ ...rect!, closed: false }, 3, 0.5)).toThrow(RangeError);
    expect(() => insertPointAt({ closed: false, points: [corner(0, 0)] }, 0, 0.5)).toThrow(
      RangeError,
    );
  });
});
