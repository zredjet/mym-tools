import { describe, expect, it } from "vitest";
import type { Point, Subpath } from "../model/types";
import { subpathToSegments } from "../path/segments";
import { ellipseSubpaths } from "../path/shapes";
import { transformSubpaths } from "../path/transform";
import {
  cubicSegment,
  distance,
  flattenSegment,
  lineSegment,
  nearestPoint,
  pointAt,
  reverseSegment,
  subSegment,
  tangentAt,
  transformSegment,
  type CubicSegment,
  type Segment,
} from "./bezier";
import { intersectSegments, selfIntersection } from "./intersect";
import { multiply, rotate, scale, translate } from "./matrix";

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
      complete: true,
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
      complete: true,
    });
    expect(intersectSegments(a, reverseSegment(a))).toEqual({
      intersections: [],
      overlaps: [{ t1: [0, 1], t2: [1, 0] }],
      complete: true,
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

// ---------------------------------------------------------------------------
// 寄り添う曲線 (レビューの例 1〜3) と打ち切り
// ---------------------------------------------------------------------------

/** a に沿って b からの符号つきの距離が変わる所 (確かめ用。b の端の外は数えない)。 */
function bruteCrossings(a: Segment, b: Segment, n = 4000): number[] {
  const out: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = pointAt(a, t);
    const np = nearestPoint(b, p);
    if (np.t <= 1e-9 || np.t >= 1 - 1e-9) {
      prev = null;
      continue;
    }
    const tb = tangentAt(b, np.t)!;
    const s = tb.x * (p.y - np.point.y) - tb.y * (p.x - np.point.x);
    if (prev !== null && s !== 0 && Math.sign(s) !== Math.sign(prev)) out.push(t);
    prev = s;
  }
  return out;
}

function segmentsOf(subpaths: Subpath[]): Segment[] {
  return subpaths.flatMap((s) => subpathToSegments(s));
}

/** 総当たりの横切りがすべて見つかり、打ち切っていないこと。 */
function expectAllCrossings(A: Segment[], B: Segment[]) {
  let found = 0;
  A.forEach((a) =>
    B.forEach((b) => {
      const r = intersectSegments(a, b);
      expect(r.complete).toBe(true);
      for (const t of bruteCrossings(a, b)) {
        expect(r.intersections.some((x) => Math.abs(x.t1 - t) < 1e-3)).toBe(true);
        found++;
      }
    }),
  );
  return found;
}

describe("curves running close together", () => {
  it("finds both crossings of two nearly equal circles, symmetrically (example 1)", () => {
    const A = segmentsOf(ellipseSubpaths(100, 100));
    const B = segmentsOf(transformSubpaths(ellipseSubpaths(100.1, 100.1), translate(0.05, -0.05)));
    const top = intersectSegments(A[1]!, B[1]!);
    const bottom = intersectSegments(A[2]!, B[2]!);
    expect(top.intersections).toHaveLength(1);
    expect(bottom.intersections).toHaveLength(1);
    // 横の直線 y = 50 で映した位置
    expect(top.intersections[0]!.point.x).toBeCloseTo(bottom.intersections[0]!.point.x, 6);
    expect(top.intersections[0]!.point.y + bottom.intersections[0]!.point.y).toBeCloseTo(100, 6);
    expect(top.intersections[0]!.point.x).toBeCloseTo(25.0696, 3);
    expect(top.intersections[0]!.point.y).toBeCloseTo(93.3511, 3);
    expect(expectAllCrossings(A, B)).toBeGreaterThanOrEqual(2);
  });

  it("finds a shallow crossing near the end (example 2)", () => {
    const a = cubicSegment({ x: 0, y: 0 }, { x: 30, y: 60 }, { x: 70, y: 60 }, { x: 100, y: 0 });
    const b = cubicSegment(
      { x: 0, y: 9.7e-4 },
      { x: 30, y: 60 + 6.37e-4 },
      { x: 70, y: 60 + 3.03e-4 },
      { x: 100, y: -3e-5 },
    );
    const r = intersectSegments(a, b);
    expect(r.complete).toBe(true);
    expect(r.intersections).toHaveLength(1);
    expect(r.intersections[0]!.t1).toBeCloseTo(0.97, 3);
    expectOnBoth(a, b, r.intersections[0]!.t1, r.intersections[0]!.t2);
  });

  it("finds a crossing anywhere along a linearly drifting copy", () => {
    const shapes = [
      cubicSegment({ x: 0, y: 0 }, { x: 30, y: 60 }, { x: 70, y: 60 }, { x: 100, y: 0 }),
      cubicSegment({ x: 0, y: 0 }, { x: 50, y: 300 }, { x: 50, y: -300 }, { x: 100, y: 0 }),
      cubicSegment({ x: 0, y: 0 }, { x: 300, y: 600 }, { x: 700, y: 600 }, { x: 1000, y: 0 }),
    ];
    for (const a of shapes) {
      for (const eps of [1e-2, 1e-3, 1e-5]) {
        for (const tc of [0.03, 0.5, 0.97]) {
          // b(t) = a(t) + (0, eps (tc - t)): Bernstein は 1 次式をそのまま表すので、制御点に足せばよい
          const f = (t: number) => eps * (tc - t);
          const b = cubicSegment(
            { x: a.from.x, y: a.from.y + f(0) },
            { x: a.c1.x, y: a.c1.y + f(1 / 3) },
            { x: a.c2.x, y: a.c2.y + f(2 / 3) },
            { x: a.to.x, y: a.to.y + f(1) },
          );
          const r = intersectSegments(a, b);
          expect(r.complete).toBe(true);
          expect(r.intersections.some((x) => Math.abs(x.t1 - tc) < 1e-3)).toBe(true);
        }
      }
    }
  });

  it("finds all 16 crossings of a circle and its slightly rotated copy (example 3)", () => {
    const circle = ellipseSubpaths(100, 100);
    for (const deg of [1, 3, 10]) {
      const A = segmentsOf(circle);
      const B = segmentsOf(transformSubpaths(circle, rotate(deg, 50, 50)));
      expect(expectAllCrossings(A, B)).toBe(16);
    }
  });

  it("reports nothing for parallel or concentric curves that do not touch, quickly", () => {
    const circle = ellipseSubpaths(100, 100);
    const A = segmentsOf(circle);
    for (const gap of [1, 0.1, 0.001]) {
      const inner = segmentsOf(
        transformSubpaths(circle, scale((100 - 2 * gap) / 100, (100 - 2 * gap) / 100, 50, 50)),
      );
      for (const a of A) {
        for (const b of inner) {
          const r = intersectSegments(a, b);
          expect(r.complete).toBe(true);
          expect(r.intersections).toEqual([]);
        }
      }
    }
    const a = cubicSegment({ x: 0, y: 0 }, { x: 30, y: 60 }, { x: 70, y: 60 }, { x: 100, y: 0 });
    for (const d of [1, 0.1, 1e-3, 1e-5]) {
      const r = intersectSegments(a, transformSegment(a, translate(0, d)), { maxPairs: 100 });
      expect(r.complete).toBe(true);
    }
  });

  it("marks the result incomplete when the pair limit is reached", () => {
    const a = cubicSegment({ x: 0, y: 0 }, { x: 33, y: 200 }, { x: 66, y: -200 }, { x: 100, y: 0 });
    const b = cubicSegment(
      { x: 0, y: 10 },
      { x: 33, y: -190 },
      { x: 66, y: 210 },
      { x: 100, y: -10 },
    );
    expect(intersectSegments(a, b).complete).toBe(true);
    const cut = intersectSegments(a, b, { maxPairs: 2 });
    expect(cut.complete).toBe(false);
    // 線分の組は打ち切らない
    const lines = intersectSegments(
      lineSegment({ x: 0, y: 0 }, { x: 1, y: 1 }),
      lineSegment({ x: 0, y: 1 }, { x: 1, y: 0 }),
      { maxPairs: 0 },
    );
    expect(lines.complete).toBe(true);
  });
});

describe("result arrays", () => {
  it("returns fresh arrays on every call", () => {
    const a = lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 });
    const r1 = intersectSegments(a, lineSegment({ x: 0, y: 1 }, { x: 10, y: 1 }));
    r1.overlaps.push({ t1: [0, 1], t2: [0, 1] });
    r1.intersections.push({ t1: 0, t2: 0, point: { x: 0, y: 0 }, tangent: false });
    const r2 = intersectSegments(a, lineSegment({ x: 0, y: 2 }, { x: 10, y: 2 }));
    expect(r2).toEqual({ intersections: [], overlaps: [], complete: true });
    const far = intersectSegments(a, lineSegment({ x: 50, y: 50 }, { x: 60, y: 60 }));
    expect(far.overlaps).not.toBe(r2.overlaps);
  });
});

describe("self intersection at the ends", () => {
  it("snaps to exactly 0 or 1 when the loop point is an end point", () => {
    const loop = cubicSegment(
      { x: 0, y: 0 },
      { x: 150, y: 100 },
      { x: -50, y: 100 },
      { x: 100, y: 0 },
    );
    const x = selfIntersection(loop)!;
    const fromLoop = subSegment(loop, x.t1, 1);
    const a = selfIntersection(fromLoop)!;
    expect(a.t1).toBe(0);
    expect(a.point).toEqual(fromLoop.from);
    const toLoop = subSegment(loop, 0, x.t2);
    const b = selfIntersection(toLoop)!;
    expect(b.t2).toBe(1);
    expect(distance(b.point, toLoop.to)).toBeLessThan(1e-7);
    // 輪だけを切り出すと、始点と終点が同じ点
    const only = subSegment(loop, x.t1, x.t2);
    const c = selfIntersection(only)!;
    expect([c.t1, c.t2]).toEqual([0, 1]);
    expect(c.point).toEqual(only.from);
  });
});

// ---------------------------------------------------------------------------
// 端点を共有する曲線と、3 回交わる曲線 (2 回目のレビュー)
// ---------------------------------------------------------------------------

/** 冪の係数 [c0, c1, c2, c3] の 3 次式を Bernstein 係数に。 */
function toBernstein(c: readonly number[]): [number, number, number, number] {
  return [
    c[0]!,
    c[0]! + c[1]! / 3,
    c[0]! + (2 * c[1]!) / 3 + c[2]! / 3,
    c[0]! + c[1]! + c[2]! + c[3]!,
  ];
}

/** a は x が t に比例する山。b = a + (0, h(t)) (h は冪の係数 `c`)。2 本の差はちょうど h(t)。 */
function bumpPair(c: readonly number[], bend: number, scaleBy = 1) {
  const by = toBernstein(c);
  const xs = [0, 100 / 3, 200 / 3, 100];
  const ay = [0, bend, bend, 0];
  const make = (dy: readonly number[]) =>
    cubicSegment(
      { x: xs[0]! * scaleBy, y: (ay[0]! + dy[0]!) * scaleBy },
      { x: xs[1]! * scaleBy, y: (ay[1]! + dy[1]!) * scaleBy },
      { x: xs[2]! * scaleBy, y: (ay[2]! + dy[2]!) * scaleBy },
      { x: xs[3]! * scaleBy, y: (ay[3]! + dy[3]!) * scaleBy },
    );
  return { a: make([0, 0, 0, 0]), b: make(by) };
}

/** 冪の係数の 3 次式の [0, 1] の符号の変わる所 (細かい標本と挟み撃ち)。 */
function polyRoots(c: readonly number[]): number[] {
  const f = (t: number) => c[0]! + t * (c[1]! + t * (c[2]! + t * c[3]!));
  const out: number[] = [];
  const n = 20000;
  let prev = f(0);
  for (let i = 1; i <= n; i++) {
    const v = f(i / n);
    if (v === 0) out.push(i / n);
    else if (prev * v < 0) {
      let lo = (i - 1) / n;
      let hi = i / n;
      for (let k = 0; k < 60; k++) {
        const m = (lo + hi) / 2;
        if (f(m) * prev < 0) hi = m;
        else lo = m;
      }
      out.push((lo + hi) / 2);
    }
    prev = v;
  }
  return out;
}

describe("curves sharing an end point", () => {
  it("finds the crossing right next to a shared start or end (d13)", () => {
    const a = cubicSegment({ x: 0, y: 0 }, { x: 33, y: 2 }, { x: 67, y: 2 }, { x: 100, y: 0 });
    const b = cubicSegment(
      { x: 0, y: 0 },
      { x: 17.04, y: 2.1687 },
      { x: 68.149, y: -12.6286 },
      { x: 100, y: 2.275 },
    );
    const points = (r: ReturnType<typeof intersectSegments>) =>
      r.intersections.map((x) => [
        Math.round(x.point.x * 1000) / 1000,
        Math.round(x.point.y * 1e4) / 1e4,
      ]);
    const expected = [
      [0, 0],
      [3.797, 0.2211],
      [95.148, 0.2793],
    ];
    const shared = intersectSegments(a, b);
    expect(shared.complete).toBe(true);
    expect(points(shared)).toEqual(expected);
    expect(points(intersectSegments(b, a))).toEqual(expected);
    const reversed = points(intersectSegments(reverseSegment(a), reverseSegment(b)));
    expect(reversed).toEqual([...expected].reverse());
  });

  it("finds a second crossing near a shared end for both shared ends (d3)", () => {
    for (const scaleBy of [1, 10]) {
      for (const r of [0.02, 0.04, 0.06, 0.1]) {
        for (const k of [10, 50]) {
          // h = k t (t − r)(t − 1): 両端を共有し、t = r でもう一度交わる
          const { a, b } = bumpPair([0, k * r, -k * (1 + r), k], 10, scaleBy);
          const res = intersectSegments(a, b);
          expect(res.complete).toBe(true);
          expect(res.intersections.map((x) => x.t1)).toEqual([0, expect.closeTo(r, 6), 1]);
        }
      }
    }
  });

  it("finds crossings in the first 1/16 of curves leaving a shared start (d4, random)", () => {
    const a = cubicSegment({ x: 0, y: 0 }, { x: 33, y: 2 }, { x: 67, y: 2 }, { x: 100, y: 0 });
    const yAt = (c: CubicSegment, x: number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 50; i++) {
        const m = (lo + hi) / 2;
        if (pointAt(c, m).x < x) lo = m;
        else hi = m;
      }
      return pointAt(c, (lo + hi) / 2).y;
    };
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let checked = 0;
    for (let k = 0; k < 600; k++) {
      const ang = ((rnd() * 40 - 20) * Math.PI) / 180;
      const l1 = 1 + rnd() * 20;
      const b = cubicSegment(
        { x: 0, y: 0 },
        { x: l1 * Math.cos(ang), y: l1 * Math.sin(ang) },
        { x: 40 + rnd() * 40, y: (rnd() - 0.5) * 30 },
        { x: 100, y: (rnd() - 0.5) * 20 },
      );
      // 最初の 6.25 px の中で横切る所 (総当たり)
      const xs: number[] = [];
      let prev = Number.NaN;
      for (let i = 1; i <= 500; i++) {
        const x = (6.25 * i) / 500;
        const d = yAt(b, x) - yAt(a, x);
        if (i > 1 && d !== 0 && Math.sign(d) !== Math.sign(prev)) xs.push(x);
        prev = d;
      }
      if (xs.length === 0) continue;
      checked++;
      const r = intersectSegments(a, b);
      expect(r.complete).toBe(true);
      for (const x of xs) {
        expect(r.intersections.some((q) => Math.abs(q.point.x - x) < 0.05)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("three crossings close together", () => {
  it("finds all three when an inner sample of h is exactly 0", () => {
    // h(t) = 100 (t − 0.5)³ − 0.03 (t − 0.5): t = 0.5 が標本にちょうど乗る
    const m = 0.5;
    const alpha = 100;
    const beta = 0.03;
    const c = [-alpha * m ** 3 + beta * m, 3 * alpha * m * m - beta, -3 * alpha * m, alpha];
    const { a, b } = bumpPair(c, 5);
    const r = intersectSegments(a, b);
    const roots = polyRoots(c);
    expect(roots).toHaveLength(3);
    expect(r.intersections.map((x) => x.t1)).toEqual(roots.map((t) => expect.closeTo(t, 6)));
  });

  it("finds all three crossings of a cubic wiggle (random, d2)", () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let trials = 0;
    for (let k = 0; k < 600; k++) {
      const alpha = 10 ** (rnd() * 4);
      const w = 0.003 + rnd() * 0.06;
      const m = 0.1 + rnd() * 0.8;
      const bend = rnd() * 15;
      const beta = 3 * alpha * w * w; // 極値は m ± w
      const amp = 2 * alpha * w ** 3; // 極値での |h|
      const gamma = (rnd() - 0.5) * 1.6 * amp;
      const c = [
        -alpha * m ** 3 + beta * m + gamma,
        3 * alpha * m * m - beta,
        -3 * alpha * m,
        alpha,
      ];
      const roots = polyRoots(c);
      // 極値が許容値の近くまで 0 に寄るものは、接する点 1 つになってよいので除く
      const extremes = [m - w, m + w].map((t) =>
        Math.abs(c[0]! + t * (c[1]! + t * (c[2]! + t * c[3]!))),
      );
      if (roots.length < 3 || Math.min(...extremes) < 1e-6) continue;
      trials++;
      const { a, b } = bumpPair(c, bend);
      const r = intersectSegments(a, b);
      expect(r.complete).toBe(true);
      for (const t of roots) {
        expect(r.intersections.some((x) => Math.abs(x.t1 - t) < 1e-4)).toBe(true);
      }
    }
    expect(trials).toBeGreaterThan(100);
  });
});
