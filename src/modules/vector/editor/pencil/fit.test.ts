import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import {
  bezierPoint,
  dedupePoints,
  findCorners,
  fitCurve,
  isSmoothJoin,
  type CubicCurve,
} from "./fit";

/** 点から曲線の列までの距離 (曲線を細かく刻んだ折れ線までの距離で近似。刻みは十分細かい)。 */
function distanceToCurves(p: Point, curves: readonly CubicCurve[]): number {
  let best = Infinity;
  for (const c of curves) {
    let prev = c[0];
    for (let i = 1; i <= 400; i++) {
      const q = bezierPoint(c, i / 400);
      best = Math.min(best, segmentDistance(p, prev, q));
      prev = q;
    }
  }
  return best;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 決まった種の乱数 (テストを毎回同じにする)。 */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function circle(n: number, r = 100, cx = 0, cy = 0, turns = 1): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * turns * i) / (n - 1);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

function expectContinuous(curves: readonly CubicCurve[]) {
  for (let i = 1; i < curves.length; i++)
    expect(curves[i]![0]).toEqual((curves[i - 1] as CubicCurve)[3]);
}

describe("fitCurve", () => {
  it("点が 1 個 (同じ点が続くだけを含む) なら空", () => {
    expect(fitCurve([], 2)).toEqual([]);
    expect(fitCurve([{ x: 1, y: 1 }], 2)).toEqual([]);
    expect(
      fitCurve(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        2,
      ),
    ).toEqual([]);
  });

  it("点が 2 個なら 1 本 (制御点は弦の 1/3 と 2/3)", () => {
    const curves = fitCurve(
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ],
      2,
    );
    expect(curves).toEqual([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 },
      ],
    ]);
  });

  it("直線に並んだ点は 1 本になる", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 2, y: i }));
    const curves = fitCurve(pts, 0.5);
    expect(curves).toHaveLength(1);
    for (const p of pts) expect(distanceToCurves(p, curves)).toBeLessThanOrEqual(0.5);
  });

  it("円は少ない本数で、どの点も誤差以内になる。始点と終点は入力のまま", () => {
    const pts = circle(200);
    const curves = fitCurve(pts, 0.5);
    expect(curves.length).toBeGreaterThanOrEqual(2);
    expect(curves.length).toBeLessThanOrEqual(8);
    expectContinuous(curves);
    expect(curves[0]![0]).toEqual(pts[0]);
    expect(curves[curves.length - 1]![3]).toEqual(pts[pts.length - 1]);
    for (const p of pts) expect(distanceToCurves(p, curves)).toBeLessThanOrEqual(0.5);
  });

  it("分けた点の前後のハンドルは向きがそろう (G1)", () => {
    const curves = fitCurve(circle(300, 100, 0, 0, 1.5), 0.2);
    expect(curves.length).toBeGreaterThan(1);
    for (let i = 1; i < curves.length; i++) {
      const at = curves[i]![0];
      const a = curves[i - 1]![2];
      const b = curves[i]![1];
      const u = { x: at.x - a.x, y: at.y - a.y };
      const v = { x: b.x - at.x, y: b.y - at.y };
      const cross = (u.x * v.y - u.y * v.x) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
      expect(Math.abs(cross)).toBeLessThan(1e-9);
      expect(u.x * v.x + u.y * v.y).toBeGreaterThan(0);
    }
  });

  it("手ぶれのあるなぞりでも、どの点も誤差以内", () => {
    const rnd = random(7);
    const pts = Array.from({ length: 400 }, (_, i) => ({
      x: i * 0.8 + (rnd() - 0.5) * 1.5,
      y: 40 * Math.sin(i / 25) + (rnd() - 0.5) * 1.5,
    }));
    for (const error of [0.5, 2, 6]) {
      const curves = fitCurve(pts, error);
      expectContinuous(curves);
      for (const p of pts) expect(distanceToCurves(p, curves)).toBeLessThanOrEqual(error + 1e-9);
    }
  });

  it("誤差を広げると本数は増えない", () => {
    const rnd = random(3);
    const pts = Array.from({ length: 300 }, (_, i) => ({
      x: 50 * Math.cos(i / 20) + rnd(),
      y: 50 * Math.sin(i / 13) + rnd(),
    }));
    const counts = [0.25, 1, 4, 16].map((e) => fitCurve(pts, e).length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
  });

  it("尖った角 (折り返し) でも崩れない", () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 20; i++) pts.push({ x: i * 5, y: 0 });
    for (let i = 19; i >= 0; i--) pts.push({ x: i * 5, y: 0.001 * i });
    const curves = fitCurve(pts, 1);
    for (const c of curves) for (const p of c) expect(Number.isFinite(p.x + p.y)).toBe(true);
    for (const p of pts) expect(distanceToCurves(p, curves)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("点が多く誤差が小さくても呼び出しが深くならない", () => {
    const rnd = random(11);
    const pts = Array.from({ length: 30000 }, (_, i) => ({ x: i, y: (rnd() - 0.5) * 50 }));
    const curves = fitCurve(pts, 0.01);
    expect(curves.length).toBeGreaterThan(1000);
    expectContinuous(curves);
  });

  it("同じ入力には同じ結果", () => {
    const pts = circle(120, 60, 10, 10, 0.75);
    expect(fitCurve(pts, 1)).toEqual(fitCurve(pts, 1));
  });

  it("数でない点と、続けて同じ点は落とす", () => {
    expect(
      dedupePoints([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: Number.NaN, y: 1 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});

/** 折れ線を 1 単位ごとに刻んだ点 (角を含む)。 */
function densePolyline(corners: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!;
    const b = corners[i]!;
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let k = 0; k < n; k++)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  out.push(corners[corners.length - 1]!);
  return out;
}

/** 折れ線の各辺を、間隔 `step` ほどの等間隔で取った点 (速いなぞり。角の点は入る)。 */
function sparsePolyline(corners: readonly Point[], step: number): Point[] {
  const out: Point[] = [corners[0]!];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1]!;
    const b = corners[i]!;
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= n; k++)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** 点の列を結んだ折れ線を、1 単位ごとに刻んだ点 (予定の線として描いた形)。 */
function denseThrough(points: readonly Point[]): Point[] {
  return densePolyline(points);
}

describe("角", () => {
  const V = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 200, y: 0 },
  ];
  const W = [
    { x: 0, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 10 },
    { x: 150, y: 100 },
    { x: 200, y: 0 },
  ];

  it("速いなぞり (間隔 25) の V と W: 角で分け、なぞった折れ線のどこからも誤差以内", () => {
    for (const shape of [V, W]) {
      const pts = sparsePolyline(shape, 25);
      const curves = fitCurve(pts, 2);
      // 角の数だけつなぎ目が角になる
      const corners = curves.slice(1).filter((c, i) => !isSmoothJoin(curves[i]!, c));
      expect(corners).toHaveLength(shape.length - 2);
      for (const p of denseThrough(pts))
        expect(distanceToCurves(p, curves)).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it("角の点がなぞりの点にない (角を挟んで点が飛ぶ) ときも、なぞった折れ線から誤差以内", () => {
    for (const shape of [V, W]) {
      // 角の点を落とし、間隔 25 で取る
      const pts = densePolyline(shape).filter((_, i, all) => i % 25 === 0 || i === all.length - 1);
      const curves = fitCurve(pts, 2);
      let worst = 0;
      for (const p of denseThrough(pts)) worst = Math.max(worst, distanceToCurves(p, curves));
      expect(worst).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it("折り返すなぞりで行き過ぎない", () => {
    const pts = sparsePolyline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 4 },
      ],
      10,
    );
    const curves = fitCurve(pts, 2);
    let maxX = -Infinity;
    for (const c of curves)
      for (let i = 0; i <= 100; i++) maxX = Math.max(maxX, bezierPoint(c, i / 100).x);
    expect(maxX).toBeLessThanOrEqual(100 + 1e-6);
  });

  it("滑らかな曲線と手ぶれは角にしない", () => {
    expect(findCorners(circle(200), 6)).toEqual([]);
    const rnd = random(5);
    const wobble = Array.from({ length: 400 }, (_, i) => ({
      x: i * 0.8 + (rnd() - 0.5) * 1.5,
      y: 40 * Math.sin(i / 25) + (rnd() - 0.5) * 1.5,
    }));
    expect(findCorners(wobble, 6)).toEqual([]);
    const curves = fitCurve(wobble, 2);
    for (let i = 1; i < curves.length; i++)
      expect(isSmoothJoin(curves[i - 1]!, curves[i]!)).toBe(true);
  });

  it("点の間の中点でも誤差を確かめる (間隔の広い点の間で曲線が離れない)", () => {
    // 間隔 30 で取った円: 点の上だけ合わせると、点の間で円から離れうる
    const pts = circle(16, 100);
    const curves = fitCurve(pts, 1);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      expect(
        distanceToCurves({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, curves),
      ).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
