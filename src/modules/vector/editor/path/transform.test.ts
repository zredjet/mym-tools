import { describe, expect, it } from "vitest";
import { distance, pointAt } from "../geometry/bezier";
import { flipHorizontal, multiply, rotate, scale, translate } from "../geometry/matrix";
import type { Subpath } from "../model/types";
import { pathBounds, signedArea } from "./measure";
import { subpathToSegments } from "./segments";
import { ellipseSubpaths, rectSubpaths } from "./shapes";
import {
  orientSubpath,
  reverseSubpath,
  reverseSubpaths,
  transformSubpaths,
  translateSubpaths,
} from "./transform";

const curvy: Subpath = {
  closed: false,
  points: [
    { x: 0, y: 0, in: null, out: { x: 10, y: 20 }, mirror: "none" },
    { x: 50, y: 10, in: { x: -10, y: -5 }, out: { x: 20, y: 10 }, mirror: "angle-length" },
    { x: 100, y: 0, in: { x: 0, y: 30 }, out: null, mirror: "none" },
  ],
};

describe("transformSubpaths", () => {
  it("maps the curve exactly (same as transforming its points)", () => {
    const m = multiply(translate(30, -20), multiply(rotate(37), scale(1.5, 0.5)));
    const moved = transformSubpaths([curvy], m);
    const a = subpathToSegments(curvy);
    const b = subpathToSegments(moved[0]!);
    for (let i = 0; i < a.length; i++) {
      for (const t of [0, 0.3, 0.7, 1]) {
        const p = pointAt(a[i]!, t);
        const q = pointAt(b[i]!, t);
        const expected = { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
        expect(distance(q, expected)).toBeLessThan(1e-9);
      }
    }
    expect(moved[0]!.points[1]!.mirror).toBe("angle-length");
  });

  it("translates points only", () => {
    const moved = translateSubpaths([curvy], 5, -5);
    expect(moved[0]!.points[1]).toEqual({ ...curvy.points[1]!, x: 55, y: 5 });
    expect(moved[0]!.closed).toBe(false);
  });

  it("round-trips through a matrix and its inverse", () => {
    const there = transformSubpaths(ellipseSubpaths(80, 40), rotate(30, 40, 20));
    const back = transformSubpaths(there, rotate(-30, 40, 20));
    const b = pathBounds(back)!;
    expect(b.minX).toBeCloseTo(0, 9);
    expect(b.maxX).toBeCloseTo(80, 9);
    expect(b.maxY).toBeCloseTo(40, 9);
  });

  it("reverses the orientation for reflections", () => {
    const [rect] = rectSubpaths(10, 10, 0);
    expect(signedArea(rect!)).toBeGreaterThan(0);
    expect(signedArea(transformSubpaths([rect!], flipHorizontal(5))[0]!)).toBeLessThan(0);
  });
});

describe("reverse", () => {
  it("keeps the start of closed outlines and swaps handles", () => {
    const [ellipse] = ellipseSubpaths(100, 50);
    const r = reverseSubpath(ellipse!);
    expect(r.points[0]!.x).toBe(ellipse!.points[0]!.x);
    expect(r.points[1]).toEqual({
      ...ellipse!.points[3]!,
      in: ellipse!.points[3]!.out,
      out: ellipse!.points[3]!.in,
    });
    expect(signedArea(r)).toBeCloseTo(-signedArea(ellipse!), 9);
    // 同じ形: 逆の線分を逆の順に並べたもの
    const a = subpathToSegments(ellipse!);
    const b = subpathToSegments(r);
    for (let i = 0; i < a.length; i++) {
      const s = a[i]!;
      const t = b[a.length - 1 - i]!;
      for (const u of [0, 0.4, 1])
        expect(distance(pointAt(s, u), pointAt(t, 1 - u))).toBeLessThan(1e-12);
    }
  });

  it("reverses open outlines end to end and is an involution", () => {
    const r = reverseSubpath(curvy);
    expect(r.points[0]).toEqual({ ...curvy.points[2]!, in: null, out: { x: 0, y: 30 } });
    expect(reverseSubpath(r)).toEqual(curvy);
    expect(reverseSubpaths([curvy, curvy])).toHaveLength(2);
  });

  it("orients outlines", () => {
    const [rect] = rectSubpaths(10, 10, 0);
    expect(orientSubpath(rect!, true)).toBe(rect);
    expect(signedArea(orientSubpath(rect!, false))).toBeLessThan(0);
    const flat: Subpath = { closed: false, points: [rect!.points[0]!, rect!.points[1]!] };
    expect(orientSubpath(flat, false)).toBe(flat);
  });
});
