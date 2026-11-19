import { describe, expect, it } from "vitest";
import { distance, pointAt } from "../geometry/bezier";
import type { PathPoint, Subpath } from "../model/types";
import { formatPathNumber, parsePathData, subpathsToPathData } from "./pathData";
import { subpathToSegments } from "./segments";
import { ellipseSubpaths, rectSubpaths } from "./shapes";

function corner(x: number, y: number): PathPoint {
  return { x, y, in: null, out: null, mirror: "none" };
}

function coords(sub: Subpath | undefined): number[][] {
  return (sub?.points ?? []).map((p) => [p.x, p.y]);
}

/** 輪郭の形 (点とハンドル) が `eps` 以内で同じ。連動の種類は比べない。 */
function expectSameShape(a: Subpath[], b: Subpath[], eps: number) {
  expect(a).toHaveLength(b.length);
  a.forEach((sub, i) => {
    const other = b[i]!;
    expect(sub.closed).toBe(other.closed);
    expect(sub.points).toHaveLength(other.points.length);
    sub.points.forEach((p, j) => {
      const q = other.points[j]!;
      expect(Math.abs(p.x - q.x)).toBeLessThanOrEqual(eps);
      expect(Math.abs(p.y - q.y)).toBeLessThanOrEqual(eps);
      for (const key of ["in", "out"] as const) {
        const h = p[key];
        const k = q[key];
        expect(h === null).toBe(k === null);
        if (h && k) {
          expect(Math.abs(h.x - k.x)).toBeLessThanOrEqual(eps * 2);
          expect(Math.abs(h.y - k.y)).toBeLessThanOrEqual(eps * 2);
        }
      }
    });
  });
}

describe("formatPathNumber", () => {
  it("rounds to 4 decimals and drops trailing zeros", () => {
    expect(formatPathNumber(10)).toBe("10");
    expect(formatPathNumber(1.23456)).toBe("1.2346");
    expect(formatPathNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatPathNumber(-1.5)).toBe("-1.5");
    expect(formatPathNumber(-0)).toBe("0");
    expect(formatPathNumber(-0.00001)).toBe("0");
    expect(formatPathNumber(1e-5)).toBe("0");
    expect(formatPathNumber(0.0001)).toBe("0.0001");
    expect(formatPathNumber(123456.78901)).toBe("123456.789");
    expect(formatPathNumber(-999999.99999)).toBe("-1000000");
  });
});

describe("subpathsToPathData", () => {
  it("writes lines, curves and the explicit closing edge", () => {
    const sub: Subpath = {
      closed: true,
      points: [
        corner(0, 0),
        { x: 10, y: 0, in: null, out: { x: 0, y: 5.5 }, mirror: "none" },
        { x: 0, y: 10, in: { x: 4.4, y: 0 }, out: null, mirror: "none" },
      ],
    };
    expect(subpathsToPathData([sub])).toBe("M0 0 L10 0 C10 5.5 4.4 10 0 10 L0 0 Z");
    expect(subpathsToPathData([{ ...sub, closed: false }], { x: 100, y: -1 })).toBe(
      "M100 -1 L110 -1 C110 4.5 104.4 9 100 9",
    );
  });

  it("uses the point as the control point when only one handle exists", () => {
    const sub: Subpath = {
      closed: false,
      points: [corner(0, 0), { x: 10, y: 0, in: { x: 0, y: -5 }, out: null, mirror: "none" }],
    };
    expect(subpathsToPathData([sub])).toBe("M0 0 C0 0 10 -5 10 0");
  });

  it("skips single-point subpaths and returns an empty string for nothing", () => {
    expect(subpathsToPathData([{ closed: true, points: [corner(1, 1)] }])).toBe("");
    expect(subpathsToPathData([])).toBe("");
    const two = subpathsToPathData([
      { closed: false, points: [corner(5, 5)] },
      { closed: false, points: [corner(0, 0), corner(1, 1)] },
    ]);
    expect(two).toBe("M0 0 L1 1");
  });

  it("writes rectangles and ellipses as the SVG 2 equivalent paths", () => {
    expect(subpathsToPathData(rectSubpaths(100, 50, 0))).toBe("M0 0 L100 0 L100 50 L0 50 L0 0 Z");
    expect(subpathsToPathData(rectSubpaths(100, 50, 10))).toBe(
      "M10 0 L90 0 C95.5228 0 100 4.4772 100 10 L100 40 C100 45.5228 95.5228 50 90 50 " +
        "L10 50 C4.4772 50 0 45.5228 0 40 L0 10 C0 4.4772 4.4772 0 10 0 Z",
    );
    expect(subpathsToPathData(ellipseSubpaths(100, 50))).toBe(
      "M100 25 C100 38.8071 77.6142 50 50 50 C22.3858 50 0 38.8071 0 25 " +
        "C0 11.1929 22.3858 0 50 0 C77.6142 0 100 11.1929 100 25 Z",
    );
  });
});

describe("parsePathData", () => {
  it("reads absolute and relative commands", () => {
    const r = parsePathData("M10 20 L30 40 l5 5 H0 h1 V3 v-1 z");
    expect(r.error).toBeNull();
    expect(r.subpaths).toHaveLength(1);
    expect(r.subpaths[0]!.closed).toBe(true);
    expect(coords(r.subpaths[0])).toEqual([
      [10, 20],
      [30, 40],
      [35, 45],
      [0, 45],
      [1, 45],
      [1, 3],
      [1, 2],
    ]);
  });

  it("repeats commands implicitly", () => {
    expect(coords(parsePathData("M0 0 10 10 20 0").subpaths[0])).toEqual([
      [0, 0],
      [10, 10],
      [20, 0],
    ]);
    expect(coords(parsePathData("m10 10 5 5 5 0").subpaths[0])).toEqual([
      [10, 10],
      [15, 15],
      [20, 15],
    ]);
    const c = parsePathData("M0 0 C0 10 10 10 10 0 10 -10 20 -10 20 0");
    expect(coords(c.subpaths[0])).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it("reads compact numbers", () => {
    expect(coords(parsePathData("M.5.5L-1-2").subpaths[0])).toEqual([
      [0.5, 0.5],
      [-1, -2],
    ]);
    expect(coords(parsePathData("M1e1,1E-1L+3,.25e+1").subpaths[0])).toEqual([
      [10, 0.1],
      [3, 2.5],
    ]);
    expect(coords(parsePathData("M0,0\n\tL 1 , 1\r\n").subpaths[0])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    const arc = parsePathData("M0 0a10 10 0 0010 0");
    expect(arc.error).toBeNull();
    expect(arc.subpaths[0]!.points[arc.subpaths[0]!.points.length - 1]).toMatchObject({
      x: 10,
      y: 0,
    });
  });

  it("reflects control points for S and T", () => {
    const s = parsePathData("M0 0 C0 10 10 10 10 0 S20 -10 20 0");
    const p = s.subpaths[0]!.points;
    // S の最初の制御点は (10, 0) を中心に (10, 10) を映した (10, -10)
    expect(p[1]!.out).toEqual({ x: 0, y: -10 });
    // 直前が C / S でない S は、今の点を制御点にする
    const t = parsePathData("M0 0 L10 0 S20 10 30 0");
    expect(t.subpaths[0]!.points[1]!.out).toBeNull();

    const q = parsePathData("M0 0 Q10 10 20 0 T40 0");
    const segs = subpathToSegments(q.subpaths[0]!);
    // 2 番目の 2 次ベジェの制御点は (30, -10)。t = 0.5 の点は (30, -5)
    const mid = pointAt(segs[1]!, 0.5);
    expect(mid.x).toBeCloseTo(30, 12);
    expect(mid.y).toBeCloseTo(-5, 12);
    const first = pointAt(segs[0]!, 0.5);
    expect(first.y).toBeCloseTo(5, 12);
  });

  it("starts a new subpath from the closed subpath's start", () => {
    const r = parsePathData("M10 10 l10 0 l0 10 z l-5 -5 m5 5 l1 0");
    expect(r.error).toBeNull();
    expect(r.subpaths).toHaveLength(3);
    expect(coords(r.subpaths[1])).toEqual([
      [10, 10],
      [5, 5],
    ]);
    // z の後の m は輪郭の始点 (10, 10) からの相対… ではなく、直前の点 (5, 5) から
    expect(coords(r.subpaths[2])).toEqual([
      [10, 10],
      [11, 10],
    ]);
  });

  it("merges an explicit return to the start before Z", () => {
    const r = parsePathData("M0 0 L10 0 L10 10 L0 0 Z");
    expect(coords(r.subpaths[0])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const c = parsePathData("M0 0 L10 0 C10 5 5 10 0 0 Z");
    expect(c.subpaths[0]!.points).toHaveLength(2);
    expect(c.subpaths[0]!.points[0]!.in).toEqual({ x: 5, y: 10 });
  });

  it("drops subpaths with a single point", () => {
    expect(parsePathData("M10 10").subpaths).toEqual([]);
    expect(parsePathData("M10 10 Z M0 0 L1 1").subpaths).toHaveLength(1);
    expect(parsePathData("M5 5 M0 0 L1 1").subpaths).toHaveLength(1);
  });

  it("accepts empty input", () => {
    expect(parsePathData("")).toEqual({ subpaths: [], error: null });
    expect(parsePathData("   \n")).toEqual({ subpaths: [], error: null });
  });

  it("reports errors and keeps what was read before them", () => {
    const noMove = parsePathData("L0 0");
    expect(noMove.subpaths).toEqual([]);
    expect(noMove.error).toMatchObject({ index: 0, code: "expected-moveto" });
    expect(parsePathData("10 10").error).toMatchObject({ index: 0, code: "expected-moveto" });

    const partial = parsePathData("M0 0 L10 10 L20");
    expect(coords(partial.subpaths[0])).toEqual([
      [0, 0],
      [10, 10],
    ]);
    expect(partial.error).toMatchObject({ index: 15, code: "expected-number" });

    const bad = parsePathData("M0 0 L10 10 X5");
    expect(bad.subpaths).toHaveLength(1);
    expect(bad.error).toMatchObject({ index: 12, code: "expected-command" });

    expect(parsePathData("M0 0 a10 10 0 2 0 5 5").error).toMatchObject({ code: "expected-flag" });
    expect(parsePathData("M0 0 L1e999 0").error).toMatchObject({ code: "invalid-number" });
    const comma = parsePathData("M0 0 L10 10,");
    expect(comma.error).toMatchObject({ code: "expected-number" });
    expect(coords(comma.subpaths[0])).toHaveLength(2);
    expect(parsePathData("M0 0 L10 10 Z 5 5").error).toMatchObject({ code: "expected-command" });
    expect(parsePathData("M,0 0").error).toMatchObject({ index: 1, code: "expected-number" });
    // 指数の数字がない `e` は数値に入らない (1 で終わり、2 個目の数値がない)
    expect(parsePathData("M0 0 L1e 2").error).toMatchObject({ index: 7, code: "expected-number" });
    expect(parsePathData("M0 0 L1 2").error?.message ?? "").toBe("");
    expect(typeof parsePathData("L").error?.message).toBe("string");
  });

  it("round-trips its own output", () => {
    const shapes: Subpath[][] = [
      rectSubpaths(120.5, 33.25, 7),
      ellipseSubpaths(80, 40),
      [
        {
          closed: false,
          points: [
            corner(0, 0),
            { x: 10, y: 5, in: { x: -3, y: 1 }, out: { x: 3, y: -1 }, mirror: "angle-length" },
            { x: 20, y: 0, in: { x: 0, y: 4 }, out: null, mirror: "none" },
          ],
        },
        { closed: true, points: [corner(50, 50), corner(60, 50)] },
      ],
    ];
    for (const s of shapes) {
      const d = subpathsToPathData(s);
      const back = parsePathData(d);
      expect(back.error).toBeNull();
      expectSameShape(back.subpaths, s, 5e-5);
      // もう一度書くと同じ文字列
      expect(subpathsToPathData(back.subpaths)).toBe(d);
    }
  });
});

describe("arcs", () => {
  function sampleArc(d: string): { x: number; y: number }[] {
    const r = parsePathData(d);
    expect(r.error).toBeNull();
    const out: { x: number; y: number }[] = [];
    for (const seg of subpathToSegments(r.subpaths[0]!)) {
      for (let i = 0; i <= 16; i++) out.push(pointAt(seg, i / 16));
    }
    return out;
  }

  it("draws a semicircle through the top when sweep is 1", () => {
    const pts = sampleArc("M0 0 A50 50 0 0 1 100 0");
    for (const p of pts) {
      expect(Math.abs(distance(p, { x: 50, y: 0 }) - 50)).toBeLessThanOrEqual(50 * 2.8e-4);
    }
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-50, 2);
    const other = sampleArc("M0 0 A50 50 0 0 0 100 0");
    expect(Math.max(...other.map((p) => p.y))).toBeCloseTo(50, 2);
  });

  it("enlarges radii that cannot reach the end point", () => {
    const pts = sampleArc("M0 0 A1 1 0 0 1 100 0");
    for (const p of pts) {
      expect(Math.abs(distance(p, { x: 50, y: 0 }) - 50)).toBeLessThanOrEqual(50 * 2.8e-4);
    }
  });

  it("chooses the large arc and splits it into pieces of at most 90 degrees", () => {
    // 半径 50、(0, 0) から (50, 50): 中心は (50, 0) か (0, 50)
    const r = parsePathData("M0 0 A50 50 0 1 1 50 50");
    const segs = subpathToSegments(r.subpaths[0]!);
    expect(segs).toHaveLength(3);
    const pts = sampleArc("M0 0 A50 50 0 1 1 50 50");
    const toA = pts.map((p) => Math.abs(distance(p, { x: 0, y: 50 }) - 50));
    const toB = pts.map((p) => Math.abs(distance(p, { x: 50, y: 0 }) - 50));
    expect(Math.max(...toA) < 0.02 || Math.max(...toB) < 0.02).toBe(true);
    expect(segs[segs.length - 1]!.to).toEqual({ x: 50, y: 50 });
  });

  it("follows a rotated ellipse", () => {
    const rot = (30 * Math.PI) / 180;
    const cx = 0;
    const cy = 0;
    const at = (a: number) => ({
      x: cx + 40 * Math.cos(a) * Math.cos(rot) - 20 * Math.sin(a) * Math.sin(rot),
      y: cy + 40 * Math.cos(a) * Math.sin(rot) + 20 * Math.sin(a) * Math.cos(rot),
    });
    const p0 = at(0);
    const p1 = at(Math.PI * 0.75);
    const d = `M${p0.x} ${p0.y} A40 20 30 0 1 ${p1.x} ${p1.y}`;
    for (const p of sampleArc(d)) {
      // 楕円の式へ戻す
      const dx = p.x - cx;
      const dy = p.y - cy;
      const u = dx * Math.cos(rot) + dy * Math.sin(rot);
      const v = -dx * Math.sin(rot) + dy * Math.cos(rot);
      expect(Math.abs(Math.hypot(u / 40, v / 20) - 1)).toBeLessThan(2e-3);
    }
  });

  it("turns a zero radius into a line and skips a zero-length arc", () => {
    const line = parsePathData("M0 0 A0 10 0 0 1 10 10");
    expect(subpathToSegments(line.subpaths[0]!)[0]!.kind).toBe("line");
    expect(coords(parsePathData("M0 0 A10 10 0 0 1 0 0 L5 5").subpaths[0])).toEqual([
      [0, 0],
      [5, 5],
    ]);
    // 負の半径は絶対値
    const neg = sampleArc("M0 0 A-50 -50 0 0 1 100 0");
    expect(Math.min(...neg.map((p) => p.y))).toBeCloseTo(-50, 2);
  });
});
