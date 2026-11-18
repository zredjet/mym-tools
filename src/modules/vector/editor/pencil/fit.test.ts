import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import { bezierPoint, dedupePoints, fitCurve, type CubicCurve } from "./fit";

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
