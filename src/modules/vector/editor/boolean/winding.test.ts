import { describe, expect, it } from "vitest";
import { lineSegment, cubicSegment } from "../geometry/bezier";
import { windingNumber } from "../path/measure";
import { subpathToSegments } from "../path/segments";
import { random, randomBlob, randomPolygon } from "./testing";
import { createWindingContext, forEachCrossing, windingsAt } from "./winding";

describe("forEachCrossing", () => {
  it("横の光線: y が増える横切りで +1、半開区間で頂点を二重に数えない", () => {
    const hits: [number, number][] = [];
    const visit = (o: number, w: number) => hits.push([o, w]);
    forEachCrossing(lineSegment({ x: 10, y: 0 }, { x: 10, y: 10 }), true, 5, visit);
    forEachCrossing(lineSegment({ x: 20, y: 10 }, { x: 20, y: 0 }), true, 5, visit);
    // 下端 (y = 0) は数え、上端 (y = 10) は数えない
    forEachCrossing(lineSegment({ x: 30, y: 0 }, { x: 30, y: 10 }), true, 0, visit);
    forEachCrossing(lineSegment({ x: 40, y: 0 }, { x: 40, y: 10 }), true, 10, visit);
    // 水平な線分は横切らない
    forEachCrossing(lineSegment({ x: 0, y: 5 }, { x: 50, y: 5 }), true, 5, visit);
    expect(hits).toEqual([
      [10, 1],
      [20, -1],
      [30, 1],
    ]);
  });

  it("縦の光線: x が減る横切りで +1", () => {
    const hits: [number, number][] = [];
    forEachCrossing(lineSegment({ x: 10, y: 3 }, { x: 0, y: 3 }), false, 5, (o, w) =>
      hits.push([o, w]),
    );
    expect(hits).toEqual([[3, 1]]);
  });

  it("曲線を極値で分けて、すべての横切りを返す", () => {
    const s = cubicSegment({ x: 0, y: 0 }, { x: 30, y: 100 }, { x: 70, y: -100 }, { x: 100, y: 0 });
    const hits: [number, number][] = [];
    forEachCrossing(s, false, 50, (o, w) => hits.push([o, w]));
    // y = 0: 始点 (上がる区間の下端、数える)、中央 (下がる区間)、終点 (上がる区間の上端、数えない)
    forEachCrossing(s, true, 0, (o, w) => hits.push([o, w]));
    expect(hits).toHaveLength(3);
    expect(hits[0]![0]).toBeCloseTo(0, 9);
    expect(hits[1]).toEqual([0, 1]);
    expect(hits[2]![0]).toBeCloseTo(50, 9);
    expect(hits[2]![1]).toBe(-1);
  });

  it("光線の先の交わりの和は windingNumber と同じ (乱数の形)", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = random(seed);
      const sub = seed % 2 ? randomBlob(rand, 50, 50, 40, 6) : randomPolygon(rand, 50, 50, 40, 7);
      const segs = subpathToSegments(sub, { implicitClose: true });
      for (let i = 0; i < 40; i++) {
        const p = { x: rand() * 100, y: rand() * 100 };
        let w = 0;
        for (const seg of segs) {
          forEachCrossing(seg, true, p.y, (o, weight) => {
            if (o > p.x) w += weight;
          });
        }
        let wv = 0;
        for (const seg of segs) {
          forEachCrossing(seg, false, p.x, (o, weight) => {
            if (o > p.y) wv += weight;
          });
        }
        const expected = windingNumber([sub], p);
        expect(w).toBe(expected);
        expect(wv).toBe(expected);
      }
    }
  });
});

describe("windingsAt", () => {
  it("時計回りの正方形の辺: 右が内側 (+1)", () => {
    const segs = [
      lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }),
      lineSegment({ x: 10, y: 0 }, { x: 10, y: 10 }),
      lineSegment({ x: 10, y: 10 }, { x: 0, y: 10 }),
      lineSegment({ x: 0, y: 10 }, { x: 0, y: 0 }),
    ];
    const ctx = createWindingContext(segs, [0, 0, 0, 0], [0, 1, 2, 3], 1, 1e-6, 1e-7);
    segs.forEach((seg, i) => {
      expect(windingsAt(ctx, i, seg, 1, 0.5)).toEqual({ left: [0], right: [1] });
    });
  });

  it("重なった 2 本 (逆向き、別の入力) をまとめて数える", () => {
    // 入力 0: 時計回りの正方形 [0,10]²、入力 1: その右の正方形 [10,20]×[0,10]。x = 10 の辺が重なる
    const segs = [
      lineSegment({ x: 0, y: 0 }, { x: 10, y: 0 }),
      lineSegment({ x: 10, y: 0 }, { x: 10, y: 10 }),
      lineSegment({ x: 10, y: 10 }, { x: 0, y: 10 }),
      lineSegment({ x: 0, y: 10 }, { x: 0, y: 0 }),
      lineSegment({ x: 10, y: 0 }, { x: 20, y: 0 }),
      lineSegment({ x: 20, y: 0 }, { x: 20, y: 10 }),
      lineSegment({ x: 20, y: 10 }, { x: 10, y: 10 }),
      lineSegment({ x: 10, y: 10 }, { x: 10, y: 0 }),
    ];
    const edgeOf = [0, 1, 2, 3, 4, 5, 6, 1];
    const ctx = createWindingContext(segs, [0, 0, 0, 0, 1, 1, 1, 1], edgeOf, 2, 1e-6, 1e-7);
    // 辺 1 (下向き): 左 (x > 10) は入力 1 の内側、右 (x < 10) は入力 0 の内側
    expect(windingsAt(ctx, 1, segs[1]!, 2, 0.5)).toEqual({ left: [0, 1], right: [1, 0] });
  });

  it("ほかの曲線が点のすぐ近くで光線を横切れば決めない (null)", () => {
    const segs = [
      lineSegment({ x: 0, y: 0 }, { x: 0, y: 10 }),
      lineSegment({ x: -5, y: 5 }, { x: 5, y: 5 }),
      lineSegment({ x: 1e-9, y: 0 }, { x: 1e-9, y: 10 }),
    ];
    const ctx = createWindingContext(segs, [0, 0, 1], [0, 1, 2], 2, 1e-6, 1e-7);
    expect(windingsAt(ctx, 0, segs[0]!, 1, 0.5)).toBeNull();
  });
});
