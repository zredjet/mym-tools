import { describe, expect, it } from "vitest";
import { flattenSegment } from "../geometry/bezier";
import { rotate } from "../geometry/matrix";
import type { PathPoint, Subpath } from "../model/types";
import {
  boundsToRect,
  containsPoint,
  distanceToPath,
  isClockwise,
  nearestOnPath,
  pathBounds,
  pathBoundsRect,
  signedArea,
  windingNumber,
  windingNumberOfSegments,
} from "./measure";
import { polygonSubpath, starSubpath } from "./polygon";
import { subpathToSegments } from "./segments";
import { ellipseSubpaths, rectSubpaths } from "./shapes";
import { reverseSubpath } from "./transform";

function corner(x: number, y: number): PathPoint {
  return { x, y, in: null, out: null, mirror: "none" };
}
function poly(closed: boolean, ...xy: [number, number][]): Subpath {
  return { closed, points: xy.map(([x, y]) => corner(x, y)) };
}

describe("pathBounds", () => {
  it("bounds the curve, not the handles", () => {
    expect(pathBounds(ellipseSubpaths(100, 50))).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
    const bump: Subpath = {
      closed: false,
      points: [
        { x: 0, y: 0, in: null, out: { x: 0, y: -40 }, mirror: "none" },
        { x: 100, y: 0, in: { x: 0, y: -40 }, out: null, mirror: "none" },
      ],
    };
    const b = pathBounds([bump])!;
    expect(b.minY).toBeCloseTo(-30, 12); // ハンドルの先 (-40) ではなく曲線の頂点
    expect(b.maxY).toBe(0);
  });

  it("bounds the transformed shape exactly (a rotated circle does not grow)", () => {
    const circle = ellipseSubpaths(100, 100);
    const b = pathBounds(circle, rotate(45, 50, 50))!;
    // 回した円の範囲は半径 50 のまま (近似の円の誤差 0.03% 以内)。4 隅を囲むと 70.7 になる
    for (const v of [b.minX, b.minY]) expect(Math.abs(v - 0)).toBeLessThan(0.03);
    for (const v of [b.maxX, b.maxY]) expect(Math.abs(v - 100)).toBeLessThan(0.03);
  });

  it("includes single points and returns null without points", () => {
    expect(pathBounds([poly(false, [5, 7])])).toEqual({ minX: 5, minY: 7, maxX: 5, maxY: 7 });
    expect(pathBounds([])).toBeNull();
    expect(pathBounds([{ closed: false, points: [] }])).toBeNull();
    expect(pathBoundsRect([poly(true, [1, 2], [4, 2], [4, 8])])).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 6,
    });
    expect(boundsToRect({ minX: -1, minY: -2, maxX: 1, maxY: 2 })).toEqual({
      x: -1,
      y: -2,
      width: 2,
      height: 4,
    });
  });
});

describe("area and orientation", () => {
  it("is positive for clockwise outlines (y down)", () => {
    const [rect] = rectSubpaths(100, 50, 0);
    expect(signedArea(rect!)).toBe(5000);
    expect(isClockwise(rect!)).toBe(true);
    expect(signedArea(reverseSubpath(rect!))).toBe(-5000);
    expect(isClockwise(reverseSubpath(rect!))).toBe(false);
  });

  it("measures curved areas", () => {
    const [ellipse] = ellipseSubpaths(100, 50);
    // κ の近似の円は真の円より外へ膨らむので、面積は πab より相対 2.8e-4 ほど大きい
    // (折れ線にした面積とは 1e-8 以内で一致することを、作るときに確かめた)
    const area = signedArea(ellipse!);
    expect(area / (Math.PI * 50 * 25) - 1).toBeGreaterThan(0);
    expect(area / (Math.PI * 50 * 25) - 1).toBeLessThan(3e-4);
    const [rounded] = rectSubpaths(100, 50, 10);
    const expected = 100 * 50 - (4 - Math.PI) * 10 * 10;
    expect(Math.abs(signedArea(rounded!) / expected - 1)).toBeLessThan(1e-4);
    // 3 次ベジェの面積の式は、細かい折れ線の面積と一致する
    const tri = {
      closed: true,
      points: [
        { x: 0, y: 0, in: null, out: { x: 40, y: -30 }, mirror: "none" as const },
        { x: 100, y: 0, in: { x: 10, y: -60 }, out: null, mirror: "none" as const },
        { x: 50, y: 80, in: null, out: null, mirror: "none" as const },
      ],
    };
    const pts = subpathToSegments(tri).flatMap((seg) => flattenSegment(seg, 1e-6).slice(1));
    let poly = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      poly += (p.x * q.y - q.x * p.y) / 2;
    }
    expect(signedArea(tri)).toBeCloseTo(poly, 3);
  });

  it("closes open outlines and gives 0 for degenerate ones", () => {
    expect(signedArea(poly(false, [0, 0], [10, 0], [10, 10]))).toBe(50);
    expect(signedArea(poly(false, [0, 0], [10, 0]))).toBe(0);
    expect(isClockwise(poly(true, [0, 0]))).toBe(false);
  });
});

describe("winding and containment", () => {
  const [rect] = rectSubpaths(100, 100, 0);

  it("counts +1 inside clockwise outlines", () => {
    expect(windingNumber([rect!], { x: 50, y: 50 })).toBe(1);
    expect(windingNumber([reverseSubpath(rect!)], { x: 50, y: 50 })).toBe(-1);
    expect(windingNumber([rect!], { x: 150, y: 50 })).toBe(0);
    expect(windingNumber([rect!], { x: -50, y: 50 })).toBe(0);
    expect(windingNumber([rect!], { x: 50, y: -1 })).toBe(0);
  });

  it("does not double count rays through vertices", () => {
    const diamond = poly(true, [0, -10], [10, 0], [0, 10], [-10, 0]);
    expect(windingNumber([diamond], { x: 0, y: 0 })).toBe(1);
    expect(windingNumber([diamond], { x: -20, y: 0 })).toBe(0);
    expect(windingNumber([diamond], { x: 5, y: -10 })).toBe(0);
    // 水平の辺を通る半直線
    const step = poly(true, [0, 0], [10, 0], [10, 5], [20, 5], [20, 10], [0, 10]);
    expect(windingNumber([step], { x: 5, y: 5 })).toBe(1);
    expect(windingNumber([step], { x: 15, y: 2 })).toBe(0);
  });

  it("applies nonzero and evenodd to holes and overlaps", () => {
    const [inner] = rectSubpaths(50, 50, 0);
    const hole = {
      ...inner!,
      points: inner!.points.map((p) => ({ ...p, x: p.x + 25, y: p.y + 25 })),
    };
    const donut = [rect!, reverseSubpath(hole)];
    expect(containsPoint(donut, { x: 50, y: 50 }, "nonzero")).toBe(false);
    expect(containsPoint(donut, { x: 10, y: 10 }, "nonzero")).toBe(true);
    const same = [rect!, hole];
    expect(windingNumber(same, { x: 50, y: 50 })).toBe(2);
    expect(containsPoint(same, { x: 50, y: 50 }, "nonzero")).toBe(true);
    expect(containsPoint(same, { x: 50, y: 50 }, "evenodd")).toBe(false);
    expect(containsPoint(same, { x: 10, y: 10 }, "evenodd")).toBe(true);
  });

  it("handles self-intersecting outlines (pentagram)", () => {
    const pts = [0, 2, 4, 1, 3].map((i) => {
      const a = ((-90 + 72 * i) * Math.PI) / 180;
      return [Math.cos(a) * 100, Math.sin(a) * 100] as [number, number];
    });
    const star = [poly(true, ...pts)];
    expect(Math.abs(windingNumber(star, { x: 0, y: 0 }))).toBe(2);
    expect(containsPoint(star, { x: 0, y: 0 }, "nonzero")).toBe(true);
    expect(containsPoint(star, { x: 0, y: 0 }, "evenodd")).toBe(false);
    expect(containsPoint(star, { x: 0, y: -80 }, "evenodd")).toBe(true);
  });

  it("decides points near curved edges", () => {
    const e = ellipseSubpaths(100, 50); // 中心 (50, 25)、半径 50 × 25
    expect(containsPoint(e, { x: 50 + 50 * 0.999, y: 25 }, "nonzero")).toBe(true);
    expect(containsPoint(e, { x: 50 + 50 * 1.001, y: 25 }, "nonzero")).toBe(false);
    expect(containsPoint(e, { x: 50, y: 25 - 25 * 0.999 }, "nonzero")).toBe(true);
    expect(containsPoint(e, { x: 50, y: 25 - 25 * 1.001 }, "nonzero")).toBe(false);
    const a = (40 * Math.PI) / 180;
    const inside = { x: 50 + 49.9 * Math.cos(a), y: 25 + 24.95 * Math.sin(a) };
    expect(containsPoint(e, inside, "evenodd")).toBe(true);
    // 水平な接線を持つ頂点の高さを通る半直線
    expect(windingNumber(e, { x: 0, y: 0 })).toBe(0);
    expect(windingNumber(e, { x: 50, y: 50 })).toBe(0);
  });

  it("treats open outlines as closed", () => {
    const open = poly(false, [0, 0], [100, 0], [100, 100]);
    expect(containsPoint([open], { x: 90, y: 10 }, "nonzero")).toBe(true);
    expect(containsPoint([open], { x: 10, y: 90 }, "nonzero")).toBe(false);
    // 閉じた線分の並びを受ける版は閉じない
    const segs = subpathToSegments(open);
    expect(windingNumberOfSegments(segs, { x: 90, y: 10 })).toBe(1);
  });

  it("agrees with polygon star shapes", () => {
    const star = starSubpath(5, 0.382, { x: 0, y: 0, width: 100, height: 100 });
    expect(containsPoint([star], { x: 50, y: 55 }, "nonzero")).toBe(true);
    expect(containsPoint([star], { x: 2, y: 2 }, "nonzero")).toBe(false);
    const tri = polygonSubpath(3, { x: 0, y: 0, width: 100, height: 100 });
    expect(containsPoint([tri], { x: 50, y: 90 }, "nonzero")).toBe(true);
    expect(containsPoint([tri], { x: 5, y: 10 }, "nonzero")).toBe(false);
  });
});

describe("nearest point and distance", () => {
  const [rect] = rectSubpaths(100, 50, 0);

  it("finds the closest edge and its index", () => {
    const top = nearestOnPath([rect!], { x: 30, y: -10 })!;
    expect(top).toMatchObject({ subpathIndex: 0, segmentIndex: 0, distance: 10 });
    expect(top.point).toEqual({ x: 30, y: 0 });
    // 閉じる辺は n - 1
    const left = nearestOnPath([rect!], { x: -5, y: 20 })!;
    expect(left.segmentIndex).toBe(3);
    expect(left.distance).toBe(5);
    expect(distanceToPath([rect!], { x: 50, y: 30 })).toBe(20);
  });

  it("does not use the implicit closing edge of open outlines", () => {
    const open = poly(false, [0, 0], [100, 0], [100, 100]);
    // 閉じる辺 (対角線) からは 0 だが、描かれる輪郭からは遠い
    expect(distanceToPath([open], { x: 50, y: 50 })).toBe(50);
  });

  it("measures distance to curves", () => {
    const circle = ellipseSubpaths(100, 100);
    expect(Math.abs(distanceToPath(circle, { x: 50, y: 50 }) - 50)).toBeLessThan(0.02);
    const n = nearestOnPath(circle, { x: 200, y: 50 })!;
    expect(n.point.x).toBe(100);
    expect(n.distance).toBe(100);
  });

  it("returns Infinity or null when nothing is drawn", () => {
    expect(distanceToPath([poly(false, [1, 1])], { x: 0, y: 0 })).toBe(Infinity);
    expect(nearestOnPath([], { x: 0, y: 0 })).toBeNull();
  });
});
