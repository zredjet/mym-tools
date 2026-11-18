import { describe, expect, it } from "vitest";
import type { Point } from "../model/types";
import { curvesToSubpath, MAX_WIDEN, pencilSubpath } from "./build";

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
