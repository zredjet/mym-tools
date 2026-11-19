import { describe, expect, it } from "vitest";
import { cubicSegment, lineSegment, type Segment } from "../geometry/bezier";
import { intersectSegments } from "../geometry/intersect";
import { subpathToSegments } from "../path/segments";
import { buildCover, coversSeparated } from "./split";
import { ellipse, random } from "./testing";

describe("coversSeparated (交わらない組を安く除く)", () => {
  it("同心円の同じ象限の弧 (範囲も曲線全体の帯も重なる) を分ける", () => {
    const quadrants = (r: number) =>
      subpathToSegments(ellipse(100, 100, r)[0]!, { implicitClose: true });
    for (const r of [5, 30, 60, 101]) {
      const inner = quadrants(r);
      const outer = quadrants(r + 2);
      for (let q = 0; q < 4; q++) {
        expect(coversSeparated(buildCover(inner[q]!), buildCover(outer[q]!), 1e-7)).toBe(true);
      }
    }
  });

  it("交わる・接する・重なる組を分けたとは言わない (乱数の曲線を intersectSegments と比べる)", () => {
    const rand = random(4242);
    const pt = () => ({ x: rand() * 100, y: rand() * 100 });
    let compared = 0;
    for (let k = 0; k < 3000; k++) {
      const a: Segment =
        rand() < 0.2 ? lineSegment(pt(), pt()) : cubicSegment(pt(), pt(), pt(), pt());
      // 半分は a の一部 (重なる)、a に触れる線、ずらした曲線
      const kind = rand();
      let b: Segment;
      if (kind < 0.1) {
        b = a.kind === "line" ? lineSegment(a.from, a.to) : cubicSegment(a.to, a.c2, a.c1, a.from);
      } else if (kind < 0.3) {
        const p = a.kind === "line" ? a.to : a.c2;
        b = lineSegment(p, pt());
      } else if (kind < 0.5 && a.kind === "cubic") {
        const d = (rand() - 0.5) * 2;
        b = cubicSegment(
          { x: a.from.x + d, y: a.from.y },
          { x: a.c1.x + d, y: a.c1.y },
          { x: a.c2.x + d, y: a.c2.y },
          { x: a.to.x + d, y: a.to.y },
        );
      } else {
        b = rand() < 0.2 ? lineSegment(pt(), pt()) : cubicSegment(pt(), pt(), pt(), pt());
      }
      const r = intersectSegments(a, b, { tolerance: 1e-7 });
      if (r.intersections.length === 0 && r.overlaps.length === 0) continue;
      compared++;
      expect(coversSeparated(buildCover(a), buildCover(b), 1e-7)).toBe(false);
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
