import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import {
  cubicSegment,
  distance,
  flattenSegment,
  lineSegment,
  pointAt,
  reverseSegment,
  subSegment,
  transformSegment,
  type CubicSegment,
  type Segment,
} from "./bezier";
import { intersectSegments, selfIntersection } from "./intersect";
import { multiply, rotate, translate } from "./matrix";

const K = 0.5522847498;
const S = cubicSegment({ x: 0, y: 0 }, { x: 30, y: 100 }, { x: 70, y: -100 }, { x: 100, y: 0 });

/** 中心 (cx, cy)、半径 r の円の 1/4 (`index` 0: 右→下、1: 下→左、2: 左→上、3: 上→右)。 */
function arc(cx: number, cy: number, r: number, index: number): CubicSegment {
  const base = cubicSegment({ x: r, y: 0 }, { x: r, y: K * r }, { x: K * r, y: r }, { x: 0, y: r });
  return transformSegment(base, multiply(translate(cx, cy), rotate(90 * index))) as CubicSegment;
}

function circle(cx: number, cy: number, r: number): CubicSegment[] {
  return [0, 1, 2, 3].map((i) => arc(cx, cy, r, i));
}

/** 折れ線同士の交点 (確かめ用)。 */
function bruteForce(a: Segment, b: Segment): Point[] {
  const pa = flattenSegment(a, 1e-4);
  const pb = flattenSegment(b, 1e-4);
  const out: Point[] = [];
  for (let i = 1; i < pa.length; i++) {
    for (let j = 1; j < pb.length; j++) {
      const p = pa[i - 1]!;
      const r = { x: pa[i]!.x - p.x, y: pa[i]!.y - p.y };
      const q = pb[j - 1]!;
      const s = { x: pb[j]!.x - q.x, y: pb[j]!.y - q.y };
      const den = r.x * s.y - r.y * s.x;
      if (den === 0) continue;
      const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / den;
      const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / den;
      if (t >= 0 && t < 1 && u >= 0 && u < 1) out.push({ x: p.x + r.x * t, y: p.y + r.y * t });
    }
  }
  return out;
}

function expectOnBoth(a: Segment, b: Segment, t1: number, t2: number, eps = 1e-7) {
  expect(distance(pointAt(a, t1), pointAt(b, t2))).toBeLessThanOrEqual(eps);
}

describe("line × line", () => {
  it("crosses", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 10, y: 10 });
    const b = lineSegment({ x: 0, y: 10 }, { x: 10, y: 0 });
    const r = intersectSegments(a, b);
    expect(r.overlaps).toEqual([]);
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]).toMatchObject({ t1: 0.5, t2: 0.5, point: { x: 5, y: 5 } });
    expect(r.intersections[0]!.tangent).toBe(false);
  });

  it("misses when apart, including parallel lines", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(
      intersectSegments(a, lineSegment({ x: 0, y: 1 }, { x: 10, y: 1 })).intersections,
    ).toEqual([]);
    expect(
      intersectSegments(a, lineSegment({ x: 11, y: -1 }, { x: 11, y: 1 })).intersections,
    ).toEqual([]);
    expect(
      intersectSegments(a, lineSegment({ x: 0, y: 1e-6 }, { x: 10, y: 1e-6 })).overlaps,
    ).toEqual([]);
  });

  it("uses exact parameters for T-junctions and shared vertices", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
    const t = intersectSegments(a, lineSegment({ x: 3, y: 0 }, { x: 3, y: 5 }));
    expect(t.intersections).toEqual([{ t1: 0.3, t2: 0, point: { x: 3, y: 0 }, tangent: false }]);
    const v = intersectSegments(a, lineSegment({ x: 10, y: 0 }, { x: 20, y: 7 }));
    expect(v.intersections).toEqual([{ t1: 1, t2: 0, point: { x: 10, y: 0 }, tangent: false }]);
    // 1e-12 だけずれた頂点も同じ点とみなし、端点の値をそのまま使う
    const w = intersectSegments(a, lineSegment({ x: 10 + 1e-12, y: 0 }, { x: 20, y: 7 }));
    expect(w.intersections[0]).toMatchObject({ t1: 1, t2: 0, point: { x: 10, y: 0 } });
  });

  it("crosses nearly parallel lines at the right place", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 1000, y: 0 });
    const b = lineSegment({ x: 0, y: -0.001 }, { x: 1000, y: 0.001 });
    const r = intersectSegments(a, b);
    expect(r.overlaps).toEqual([]);
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]!.point.x).toBeCloseTo(500, 6);
    expect(r.intersections[0]!.tangent).toBe(true);
  });

  it("reports collinear overlaps with matching parameter ranges", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
    const same = intersectSegments(a, lineSegment({ x: 4, y: 0 }, { x: 15, y: 0 }));
    expect(same.intersections).toEqual([]);
    expect(same.overlaps).toEqual([{ t1: [0.4, 1], t2: [0, 6 / 11] }]);

    const opposite = intersectSegments(a, lineSegment({ x: 8, y: 0 }, { x: 2, y: 0 }));
    expect(opposite.overlaps).toEqual([{ t1: [0.2, 0.8], t2: [1, 0] }]);

    const identical = intersectSegments(a, reverseSegment(a));
    expect(identical.overlaps).toEqual([{ t1: [0, 1], t2: [1, 0] }]);
  });

  it("reports collinear segments that only touch at one point as an intersection", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
    const r = intersectSegments(a, lineSegment({ x: 10, y: 0 }, { x: 20, y: 0 }));
    expect(r.overlaps).toEqual([]);
    expect(r.intersections).toEqual([{ t1: 1, t2: 0, point: { x: 10, y: 0 }, tangent: true }]);
    expect(intersectSegments(a, lineSegment({ x: 11, y: 0 }, { x: 20, y: 0 }))).toEqual({
      intersections: [],
      overlaps: [],
    });
  });

  it("treats zero-length segments as points", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
    const r = intersectSegments(a, lineSegment({ x: 5, y: 0 }, { x: 5, y: 0 }));
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]).toMatchObject({ t1: 0.5, t2: 0 });
    expect(intersectSegments(a, lineSegment({ x: 5, y: 1 }, { x: 5, y: 1 })).intersections).toEqual(
      [],
    );
  });
});

describe("line × curve", () => {
  it("finds the three crossings of an S curve", () => {
    const line = lineSegment({ x: -10, y: 0 }, { x: 110, y: 0 });
    const r = intersectSegments(line, S);
    expect(r.intersections.map((x) => x.t2)).toEqual([0, expect.closeTo(0.5, 12), 1]);
    for (const x of r.intersections) expectOnBoth(line, S, x.t1, x.t2);
    // 逆の順でも同じ交点
    const back = intersectSegments(S, line);
    expect(back.intersections.map((x) => x.t1)).toEqual([0, expect.closeTo(0.5, 12), 1]);
  });

  it("returns a single tangent point where a line touches a curve", () => {
    const top = arc(0, 0, 100, 2); // 左 → 上。上端 (0, -100) で水平
    const line = lineSegment({ x: -50, y: -100 }, { x: 50, y: -100 });
    const r = intersectSegments(line, top);
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]).toMatchObject({ t2: 1, point: { x: 0, y: -100 }, tangent: true });
    // 少しだけ外れた線は交わらない
    const off = lineSegment({ x: -50, y: -100.001 }, { x: 50, y: -100.001 });
    expect(intersectSegments(off, top).intersections).toEqual([]);
  });

  it("finds a tangent touch in the middle of a curve", () => {
    const arch = cubicSegment(
      { x: 0, y: 0 },
      { x: 0, y: -40 },
      { x: 100, y: -40 },
      { x: 100, y: 0 },
    );
    const line = lineSegment({ x: 0, y: -30 }, { x: 100, y: -30 });
    const r = intersectSegments(line, arch);
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]!.t2).toBeCloseTo(0.5, 9);
    expect(r.intersections[0]!.tangent).toBe(true);
  });

  it("crosses a circle at the expected points", () => {
    const line = lineSegment({ x: -200, y: 30 }, { x: 200, y: 30 });
    const hits = circle(0, 0, 100).flatMap((seg) =>
      intersectSegments(line, seg).intersections.map((x) => x.point),
    );
    expect(hits).toHaveLength(2);
    for (const p of hits) {
      expect(Math.abs(p.x)).toBeCloseTo(Math.sqrt(100 * 100 - 30 * 30), 1);
      expect(p.y).toBeCloseTo(30, 9);
    }
  });

  it("treats a straight cubic as a line, including overlaps", () => {
    const straight = cubicSegment({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 10, y: 0 });
    const line = lineSegment({ x: 5, y: 0 }, { x: 20, y: 0 });
    const r = intersectSegments(straight, line);
    expect(r.intersections).toEqual([]);
    expect(r.overlaps).toHaveLength(1);
    const o = r.overlaps[0]!;
    expect(o.t1[1]).toBe(1);
    expectOnBoth(straight, line, o.t1[0], o.t2[0]);
    expect(o.t2).toEqual([0, 1 / 3]);
  });
});

describe("curve × curve", () => {
  it("matches brute force for crossing curves", () => {
    const pairs: [CubicSegment, CubicSegment][] = [
      [S, transformSegment(S, rotate(90, 50, 0)) as CubicSegment],
      [arc(0, 0, 100, 0), arc(60, 0, 100, 1)],
      [S, cubicSegment({ x: 0, y: 30 }, { x: 40, y: -80 }, { x: 60, y: 80 }, { x: 100, y: -30 })],
    ];
    for (const [a, b] of pairs) {
      const r = intersectSegments(a, b);
      const expected = bruteForce(a, b);
      expect(r.overlaps).toEqual([]);
      expect(r.intersections).toHaveLength(expected.length);
      for (const x of r.intersections) {
        expectOnBoth(a, b, x.t1, x.t2);
        expect(Math.min(...expected.map((p) => distance(p, x.point)))).toBeLessThan(1e-3);
      }
    }
  });

  it("finds all crossings of two wavy curves", () => {
    const a = cubicSegment({ x: 0, y: 0 }, { x: 33, y: 200 }, { x: 66, y: -200 }, { x: 100, y: 0 });
    const b = cubicSegment(
      { x: 0, y: 10 },
      { x: 33, y: -190 },
      { x: 66, y: 210 },
      { x: 100, y: -10 },
    );
    const r = intersectSegments(a, b);
    expect(r.intersections).toHaveLength(bruteForce(a, b).length);
    expect(r.intersections.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < r.intersections.length; i++) {
      expect(r.intersections[i]!.t1).toBeGreaterThan(r.intersections[i - 1]!.t1);
    }
  });

  it("returns exact end parameters at shared vertices", () => {
    const a = arc(0, 0, 100, 0);
    const b = arc(0, 0, 100, 1);
    const r = intersectSegments(a, b);
    expect(r.overlaps).toEqual([]);
    expect(r.intersections).toEqual([{ t1: 1, t2: 0, point: { x: 0, y: 100 }, tangent: true }]);
  });

  it("touches two circles at one tangent point", () => {
    // 半径 50 の円が (0, 0) と (100, 0) にあり、(50, 0) で外から接する
    const left = arc(0, 0, 50, 0); // (50, 0) から下へ
    const right = arc(100, 0, 50, 1); // (100, 50) から左へ、(50, 0) で終わる
    const r = intersectSegments(left, right);
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]).toMatchObject({ t1: 0, t2: 1, point: { x: 50, y: 0 } });
    expect(r.intersections[0]!.tangent).toBe(true);
  });

  it("touches curves tangentially away from their ends", () => {
    const up = cubicSegment({ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 70, y: 40 }, { x: 100, y: 0 });
    const down = cubicSegment(
      { x: 0, y: 60 },
      { x: 30, y: 20 },
      { x: 70, y: 20 },
      { x: 100, y: 60 },
    );
    // up の頂点は y = 30、down の底は y = 30。どちらも t = 0.5 で水平
    const r = intersectSegments(up, down);
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]!.t1).toBeCloseTo(0.5, 2);
    expect(r.intersections[0]!.t2).toBeCloseTo(0.5, 2);
    expect(r.intersections[0]!.tangent).toBe(true);
    expect(r.intersections[0]!.point.y).toBeCloseTo(30, 6);
  });

  it("detects identical and reversed curves as overlaps", () => {
    const a = arc(0, 0, 100, 0);
    expect(intersectSegments(a, a)).toEqual({
      intersections: [],
      overlaps: [{ t1: [0, 1], t2: [0, 1] }],
    });
    expect(intersectSegments(a, reverseSegment(a))).toEqual({
      intersections: [],
      overlaps: [{ t1: [0, 1], t2: [1, 0] }],
    });
  });

  it("detects partial overlaps of the same curve", () => {
    const left = subSegment(S, 0, 0.7);
    const right = subSegment(S, 0.3, 1);
    const r = intersectSegments(left, right);
    expect(r.intersections).toEqual([]);
    expect(r.overlaps).toHaveLength(1);
    const o = r.overlaps[0]!;
    expect(o.t1[0]).toBeCloseTo(0.3 / 0.7, 9);
    expect(o.t1[1]).toBe(1);
    expect(o.t2[0]).toBe(0);
    expect(o.t2[1]).toBeCloseTo(0.4 / 0.7, 9);
    // 片方がもう片方の中に入っている (逆向き)
    const inner = reverseSegment(subSegment(S, 0.2, 0.6));
    const c = intersectSegments(S, inner);
    expect(c.overlaps).toHaveLength(1);
    expect(c.overlaps[0]!.t1[0]).toBeCloseTo(0.2, 9);
    expect(c.overlaps[0]!.t1[1]).toBeCloseTo(0.6, 9);
    expect(c.overlaps[0]!.t2).toEqual([1, 0]);
  });

  it("does not mistake curves that only share both end points for an overlap", () => {
    const a = cubicSegment({ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 70, y: 40 }, { x: 100, y: 0 });
    const b = cubicSegment({ x: 0, y: 0 }, { x: 30, y: -40 }, { x: 70, y: -40 }, { x: 100, y: 0 });
    const r = intersectSegments(a, b);
    expect(r.overlaps).toEqual([]);
    expect(r.intersections.map((x) => [x.t1, x.t2])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("does not report anything for curves just apart", () => {
    const a = arc(0, 0, 100, 0);
    const b = transformSegment(a, translate(0, 1e-3));
    const r = intersectSegments(a, b);
    expect(r.overlaps).toEqual([]);
    // 平行に 0.001 ずらした円弧は 1 回交わる (円弧が平行移動の向きに傾いているため) か交わらない
    expect(r.intersections.length).toBeLessThanOrEqual(1);
  });

  it("handles large coordinates", () => {
    const big = transformSegment(S, translate(900000, 900000));
    const big2 = transformSegment(
      transformSegment(S, rotate(90, 50, 0)),
      translate(900000, 900000),
    );
    const r = intersectSegments(big, big2);
    const expected = bruteForce(big, big2);
    expect(r.intersections).toHaveLength(expected.length);
  });
});

describe("self intersection", () => {
  it("finds the loop of a looping cubic", () => {
    const loop = cubicSegment(
      { x: 0, y: 0 },
      { x: 150, y: 100 },
      { x: -50, y: 100 },
      { x: 100, y: 0 },
    );
    const x = selfIntersection(loop);
    expect(x).not.toBeNull();
    expect(x!.t1).toBeLessThan(x!.t2);
    expect(distance(pointAt(loop, x!.t1), pointAt(loop, x!.t2))).toBeLessThan(1e-9);
    expect(x!.point.x).toBeCloseTo(50, 9); // 左右対称
  });

  it("returns null for curves without a loop", () => {
    expect(selfIntersection(S)).toBeNull();
    expect(selfIntersection(arc(0, 0, 10, 0))).toBeNull();
    expect(selfIntersection(lineSegment({ x: 0, y: 0 }, { x: 1, y: 1 }))).toBeNull();
    // 尖点 (輪が潰れたもの)
    const cusp = cubicSegment(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    );
    expect(selfIntersection(cusp)).toBeNull();
    // 輪が [0, 1] の外にある
    const outside = cubicSegment(
      { x: 0, y: 0 },
      { x: 40, y: 30 },
      { x: 60, y: 30 },
      { x: 100, y: 0 },
    );
    expect(selfIntersection(outside)).toBeNull();
  });
});
