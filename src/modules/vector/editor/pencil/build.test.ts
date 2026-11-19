import { describe, expect, it } from "vitest";
import type { Point, Subpath } from "../model/types";
import { curvesToSubpath, MAX_WIDEN, pencilSubpath } from "./build";
import { bezierPoint, type CubicCurve } from "./fit";

const OPTIONS = { tolerance: 2, closeDistance: 8, maxPoints: 10000 };

function arc(n: number, r: number, from: number, to: number, cx = 200, cy = 200): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / (n - 1);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

const decimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

describe("pencilSubpath", () => {
  it("点が 1 個なら作らない", () => {
    expect(pencilSubpath([], OPTIONS)).toBeNull();
    expect(pencilSubpath([{ x: 3, y: 4 }], OPTIONS)).toBeNull();
    expect(
      pencilSubpath(
        [
          { x: 3, y: 4 },
          { x: 3, y: 4 },
        ],
        OPTIONS,
      ),
    ).toBeNull();
  });

  it("開いたなぞりは開いた輪郭。端は角 (`none`)、中は滑らか (`angle`)", () => {
    const result = pencilSubpath(arc(100, 100, 0, Math.PI * 1.5), OPTIONS);
    const sub = result!.subpath;
    expect(sub.closed).toBe(false);
    expect(sub.points.length).toBeGreaterThanOrEqual(3);
    const first = sub.points[0]!;
    const last = sub.points[sub.points.length - 1]!;
    expect(first).toMatchObject({ x: 300, y: 200, in: null, mirror: "none" });
    expect(first.out).not.toBeNull();
    expect(last.out).toBeNull();
    expect(last.mirror).toBe("none");
    for (const p of sub.points.slice(1, -1)) {
      expect(p.mirror).toBe("angle");
      expect(p.in).not.toBeNull();
      expect(p.out).not.toBeNull();
    }
  });

  it("点とハンドルの先は小数第 2 位に丸める", () => {
    const pts = arc(80, 77.777, 0.1, 2.3, 13.3333, 17.7777);
    const sub = pencilSubpath(pts, OPTIONS)!.subpath;
    for (const p of sub.points) {
      expect(decimals(p.x) && decimals(p.y)).toBe(true);
      for (const h of [p.in, p.out]) if (h) expect(decimals(p.x + h.x)).toBe(true);
    }
  });

  it("終点が始点から閉じる距離以内なら閉じる。重なる最後の点を落とし、始点は角", () => {
    const pts = arc(120, 100, 0, Math.PI * 2 - 0.05);
    const end = pts[pts.length - 1]!;
    expect(Math.hypot(end.x - 300, end.y - 200)).toBeLessThan(8);
    const sub = pencilSubpath(pts, OPTIONS)!.subpath;
    expect(sub.closed).toBe(true);
    expect(sub.points.length).toBeGreaterThanOrEqual(2);
    const first = sub.points[0]!;
    expect(first).toMatchObject({ x: 300, y: 200, mirror: "none" });
    expect(first.in).not.toBeNull();
    expect(first.out).not.toBeNull();
    const last = sub.points[sub.points.length - 1]!;
    expect(last.x === first.x && last.y === first.y).toBe(false);
  });

  it("閉じる距離より遠ければ開いたまま", () => {
    const pts = arc(120, 100, 0, Math.PI * 2 - 0.2); // 終点は始点から約 20
    expect(pencilSubpath(pts, OPTIONS)!.subpath.closed).toBe(false);
  });

  it("2 点だけのなぞりは閉じない", () => {
    const sub = pencilSubpath(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
      ],
      OPTIONS,
    )!.subpath;
    expect(sub.closed).toBe(false);
    expect(sub.points).toHaveLength(2);
  });

  it("閉じた輪郭が曲線 1 本で収まっても、点は 2 個以上にする", () => {
    const pts = arc(40, 30, 0, Math.PI * 2 - 0.1);
    const sub = pencilSubpath(pts, { ...OPTIONS, tolerance: 1000 })!.subpath;
    expect(sub.closed).toBe(true);
    expect(sub.points.length).toBeGreaterThanOrEqual(2);
  });

  it("点の数の上限を超えるなら誤差を広げて当てはめ直す。広げきっても超えるなら作らない", () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({ x: i * 2, y: i % 2 === 0 ? 0 : 30 }));
    const free = pencilSubpath(pts, OPTIONS)!;
    expect(free.subpath.points.length).toBeGreaterThan(20);
    expect(free.tolerance).toBe(2);
    const limited = pencilSubpath(pts, { ...OPTIONS, maxPoints: 20 })!;
    expect(limited.subpath.points.length).toBeLessThanOrEqual(20);
    expect(limited.tolerance).toBeGreaterThan(2);
    expect(limited.tolerance).toBeLessThanOrEqual(2 * 2 ** MAX_WIDEN);
    expect(pencilSubpath(pts, { ...OPTIONS, maxPoints: 1 })).toBeNull();
  });
});

describe("curvesToSubpath", () => {
  it("長さ 0 のハンドルは null", () => {
    const sub = curvesToSubpath(
      [
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 0 },
        ],
      ],
      false,
    )!;
    expect(sub.points).toEqual([
      { x: 0, y: 0, in: null, out: null, mirror: "none" },
      { x: 10, y: 0, in: null, out: null, mirror: "none" },
    ]);
  });

  it("空なら null", () => {
    expect(curvesToSubpath([], false)).toBeNull();
  });
});

/** 輪郭を曲線の列に戻す (点とハンドルは相対)。 */
function subpathCurves(sub: Subpath): CubicCurve[] {
  const pts = sub.points;
  const n = sub.closed ? pts.length : pts.length - 1;
  const curves: CubicCurve[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    curves.push([
      { x: a.x, y: a.y },
      a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : { x: a.x, y: a.y },
      b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : { x: b.x, y: b.y },
      { x: b.x, y: b.y },
    ]);
  }
  return curves;
}

function distanceToCurves(p: Point, curves: readonly CubicCurve[]): number {
  let best = Infinity;
  for (const c of curves) {
    let prev = c[0];
    for (let i = 1; i <= 400; i++) {
      const q = bezierPoint(c, i / 400);
      const dx = q.x - prev.x;
      const dy = q.y - prev.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0
          ? 0
          : Math.max(0, Math.min(1, ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / len2));
      best = Math.min(best, Math.hypot(p.x - (prev.x + t * dx), p.y - (prev.y + t * dy)));
      prev = q;
    }
  }
  return best;
}

describe("丸めと誤差", () => {
  it("高い倍率 (誤差が小さい) でも、丸めた後の曲線がなぞった点から誤差以内", () => {
    let s = 9;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (const zoom of [16, 64]) {
      const tolerance = 2 / zoom;
      // 画面で 800 点のなぞり (文書の単位では小さい)
      const pts = Array.from({ length: 800 }, (_, i) => ({
        x: 10.123 + (i * 0.7) / zoom + ((rnd() - 0.5) * 0.6) / zoom,
        y: 20.456 + (30 * Math.sin(i / 40)) / zoom + ((rnd() - 0.5) * 0.6) / zoom,
      }));
      const sub = pencilSubpath(pts, {
        tolerance,
        closeDistance: 8 / zoom,
        maxPoints: 10000,
      })!.subpath;
      const curves = subpathCurves(sub);
      let worst = 0;
      for (const p of pts) worst = Math.max(worst, distanceToCurves(p, curves));
      expect(worst).toBeLessThanOrEqual(tolerance);
    }
  });
});

describe("短いなぞりは閉じない", () => {
  it("6 px のまっすぐな線は開いたまま", () => {
    const pts = [0, 1.5, 3, 4.5, 6].map((x) => ({ x, y: 0 }));
    const sub = pencilSubpath(pts, OPTIONS)!.subpath;
    expect(sub.closed).toBe(false);
  });

  it("始点から閉じる距離の 2 倍まで離れずに戻った輪は閉じない。離れてから戻れば閉じる", () => {
    const small = arc(40, 7, 0, Math.PI * 2 - 0.3, 0, 0); // 始点から最大 14 (< 16)
    expect(pencilSubpath(small, OPTIONS)!.subpath.closed).toBe(false);
    const large = arc(60, 9, 0, Math.PI * 2 - 0.3, 0, 0); // 始点から最大 18 (≥ 16)
    expect(pencilSubpath(large, OPTIONS)!.subpath.closed).toBe(true);
  });
});

describe("角の点", () => {
  it("V の角は角の点 (`none`)、ほかの点は滑らか", () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 20; i++) pts.push({ x: i * 5, y: i * 5 });
    for (let i = 1; i <= 20; i++) pts.push({ x: 100 + i * 5, y: 100 - i * 5 });
    const sub = pencilSubpath(pts, OPTIONS)!.subpath;
    const corner = sub.points.find((p) => p.x === 100 && p.y === 100);
    expect(corner?.mirror).toBe("none");
    for (const p of sub.points.slice(1, -1)) if (p !== corner) expect(p.mirror).toBe("angle");
  });
});
