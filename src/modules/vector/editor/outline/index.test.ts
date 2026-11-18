import { describe, expect, it } from "vitest";
import {
  ellipse,
  point,
  polygon,
  random,
  randomBlob,
  randomPolygon,
  rect,
  star,
} from "../boolean/testing";
import { rotate } from "../geometry/matrix";
import type { StrokeCap, StrokeJoin, Subpath } from "../model/types";
import { signedArea, windingNumber } from "../path/measure";
import { transformSubpaths, translateSubpaths } from "../path/transform";
import {
  outlineStroke,
  outlineTolerance,
  strokeContours,
  strokeOutline,
  type StrokeShape,
} from "./index";
import { compareStrokeOnGrid } from "./testing";

/**
 * 格子で結果を確かめるテストは重く、CI の遅い機械や負荷の高い手元では既定の 5 秒を超えることがある
 * (`canvas-stage2` の CI で時間切れになった)。速さは `performance.test.ts` が見るので、ここは時間切れだけを延ばす
 */
const HEAVY_TIMEOUT_MS = 30_000;

function stroke(
  width: number,
  cap: StrokeCap = "butt",
  join: StrokeJoin = "miter",
  dash: number[] = [],
): StrokeShape {
  return { width, cap, join, dash };
}

/** 結果を参照と格子で比べ、違いがないこと・巻き数が 0 か 1 であることを確かめる。 */
function expectMatches(subpaths: Subpath[], s: StrokeShape, steps = 72): Subpath[] {
  const result = outlineStroke(subpaths, s);
  expect(result).not.toBeNull();
  const report = compareStrokeOnGrid(subpaths, s, result!, {
    steps,
    margin: outlineTolerance(s.width),
  });
  expect(report.checked).toBeGreaterThan(steps * steps * 0.5);
  expect(report.mismatches.slice(0, 5)).toEqual([]);
  expect(report.badWinding.slice(0, 5)).toEqual([]);
  expect(report.boundaryOff.slice(0, 5)).toEqual([]);
  return result!;
}

const CAPS: StrokeCap[] = ["butt", "round", "square"];
const JOINS: StrokeJoin[] = ["miter", "round", "bevel"];

describe("outlineStroke: 端と角", { timeout: HEAVY_TIMEOUT_MS }, () => {
  for (const cap of CAPS) {
    it(`線分の端 (${cap})`, () => {
      const r = expectMatches(
        polygon(
          [
            [0, 0],
            [100, 30],
          ],
          false,
        ),
        stroke(12, cap),
      );
      expect(r.length).toBe(1);
      expect(signedArea(r[0]!)).toBeGreaterThan(0);
    });
  }

  for (const join of JOINS) {
    it(`折れ線の角 (${join}、鋭い角と鈍い角)`, () => {
      const zig = polygon(
        [
          [0, 0],
          [40, 60],
          [60, 0],
          [64, 60],
          [120, 30],
          [180, 32],
        ],
        false,
      );
      for (const cap of CAPS) expectMatches(zig, stroke(10, cap, join));
    });
  }

  it("マイターの上限: 4 以内はとがらせ、超えたらベベル", () => {
    // 向きの変わりが 140° (1/cos 70° ≈ 2.92) と 160° (1/cos 80° ≈ 5.76)
    for (const turn of [140, 160]) {
      const a = (turn * Math.PI) / 180;
      const path = polygon(
        [
          [0, 0],
          [100, 0],
          [100 + 100 * Math.cos(a), 100 * Math.sin(a)],
        ],
        false,
      );
      const r = expectMatches(path, stroke(10, "butt", "miter"));
      // 140° のマイターの先は (113.7, −5)。160° はベベルなので (106, 0) に届かない
      if (turn === 140) expect(windingNumber(r, { x: 112, y: -4 })).toBe(1);
      else expect(windingNumber(r, { x: 106, y: 0 })).toBe(0);
    }
  });

  it("ほぼ折り返す角 (179°) と、ちょうど折り返す角", () => {
    for (const join of JOINS) {
      const back = polygon(
        [
          [0, 0],
          [100, 0],
          [0, 1.5],
        ],
        false,
      );
      expectMatches(back, stroke(8, "butt", join));
      const exact = polygon(
        [
          [0, 0],
          [100, 0],
          [30, 0],
        ],
        false,
      );
      expectMatches(exact, stroke(8, "round", join));
    }
  });

  it("閉じた矩形は始点にも角を描く (穴のある面になる)", () => {
    for (const join of JOINS) {
      const r = expectMatches(rect(0, 0, 100, 60), stroke(10, "butt", join));
      expect(r.length).toBe(2);
      expect(windingNumber(r, { x: 50, y: 30 })).toBe(0);
      expect(windingNumber(r, { x: -4.9, y: -4.9 })).toBe(join === "miter" ? 1 : 0);
    }
  });

  it("閉じていない輪郭は閉じる辺を描かない", () => {
    const open = polygon(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      false,
    );
    const r = expectMatches(open, stroke(6, "butt", "miter"));
    expect(windingNumber(r, { x: 50, y: 50 })).toBe(0);
  });
});

describe("outlineStroke: 曲線", { timeout: HEAVY_TIMEOUT_MS }, () => {
  it("円と楕円 (太さが半径より小さい)", () => {
    expectMatches(ellipse(50, 50, 40), stroke(6));
    expectMatches(ellipse(50, 50, 60, 20), stroke(10, "butt", "round"));
  });

  it("曲率半径が太さの半分より小さい所 (小さい円は塗りつぶした円になる)", () => {
    const r = expectMatches(ellipse(50, 50, 3), stroke(10));
    expect(r.length).toBe(1);
    expect(windingNumber(r, { x: 50, y: 50 })).toBe(1);
    expectMatches(ellipse(50, 50, 20, 3), stroke(10, "butt", "bevel"));
  });

  it("角丸の半径が太さの半分より小さい矩形", () => {
    for (const join of JOINS) expectMatches(rect(0, 0, 80, 50, 2), stroke(12, "butt", join));
    expectMatches(rect(0, 0, 80, 50, 6), stroke(12));
  });

  it("S 字の曲線 (変曲点) と、強く曲がる曲線", () => {
    const s: Subpath[] = [
      {
        closed: false,
        points: [point(0, 0, undefined, { x: 120, y: 0 }), point(100, 80, { x: -120, y: 0 })],
      },
    ];
    for (const cap of CAPS) expectMatches(s, stroke(14, cap));
    const hook: Subpath[] = [
      {
        closed: false,
        points: [point(0, 0, undefined, { x: 200, y: 0 }), point(10, 20, { x: 200, y: 0 })],
      },
    ];
    for (const join of JOINS) expectMatches(hook, stroke(16, "round", join));
  });

  it("ほぼ尖った所 (ごく小さく折り返す曲線) は、折り返しの丸い扇になる", () => {
    // レビューの再現: (0,0) c1 (60,60) c2 (dx,60) → (60,0)。dx が 0 に近いと t = 0.5 でほぼ尖る
    for (const dx of [-2, -0.5, -0.1, -0.01, 0.01, 0.1, 0.5, 2])
      for (const cap of CAPS) {
        const near: Subpath[] = [
          {
            closed: false,
            points: [point(0, 0, undefined, { x: 60, y: 60 }), point(60, 0, { x: dx - 60, y: 60 })],
          },
        ];
        expectMatches(near, stroke(8, cap), 96);
      }
  });

  it("尖り (速さが 0 になる 3 次ベジェ)", () => {
    const cusp: Subpath[] = [
      {
        closed: false,
        points: [point(0, 0, undefined, { x: 100, y: 100 }), point(100, 0, { x: -100, y: 100 })],
      },
    ];
    const r = outlineStroke(cusp, stroke(10));
    expect(r).not.toBeNull();
    expect(windingNumber(r!, { x: 50, y: 70 })).toBe(1);
  });

  it("ハンドルが点に重なった曲線の端 (角から出る曲線)", () => {
    const sub: Subpath[] = [
      {
        closed: true,
        points: [
          point(0, 0, undefined, undefined),
          point(100, 0, undefined, { x: 0, y: 80 }),
          point(0, 80, { x: 60, y: 0 }),
        ],
      },
    ];
    for (const join of JOINS) expectMatches(sub, stroke(10, "butt", join));
  });

  it("ハンドルが点に重なった端 (ペンで角の点から引いた曲線) は、どの太さ・端・破線でも求められる", () => {
    // 開発用の画面の「開いた曲線」と同じ形: 両端の点はハンドルなし (端の速さが 0、曲率が限りなく大きい)
    const pen: Subpath[] = [
      {
        closed: false,
        points: [point(0, 90), point(60, 0, { x: -40, y: 0 }, { x: 40, y: 0 }), point(140, 90)],
      },
    ];
    for (const cap of CAPS)
      for (const width of [0.5, 1, 3, 6, 10, 15, 30, 80])
        for (const dash of [[], [10, 5]]) {
          const shape = translateSubpaths(pen, 480, 370);
          expect(outlineStroke(shape, stroke(width, cap, "miter", dash))).not.toBeNull();
        }
    expectMatches(pen, stroke(3, "round", "miter", [10, 5]));
    expectMatches(pen, stroke(10, "square", "round"));
    expectMatches(pen, stroke(30, "butt", "bevel"));
  });

  it("ハンドルのない点が混ざる形 (ペンで描いたような形) 30 通り", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = random(seed * 104729);
      const blob = randomBlob(rand, 100, 100, 20 + rand() * 80, 2 + Math.floor(rand() * 6));
      const points = blob.points.map((p) => ({
        ...p,
        in: rand() < 0.4 ? null : p.in,
        out: rand() < 0.4 ? null : p.out,
        mirror: "none" as const,
      }));
      const closed = rand() < 0.5;
      const s = stroke(
        0.5 + rand() * rand() * 30,
        CAPS[Math.floor(rand() * 3)]!,
        JOINS[Math.floor(rand() * 3)]!,
        rand() < 0.35 ? [1 + rand() * 20, 1 + rand() * 8] : [],
      );
      expectMatches([{ closed, points }], s, 40);
    }
  });

  it("わずかに曲がる角 (1e-6° から 5°)", () => {
    for (const deg of [1e-6, 1e-4, 0.01, 0.5, 5])
      for (const join of JOINS)
        for (const width of [1, 10]) {
          const a = (deg * Math.PI) / 180;
          const kink = polygon(
            [
              [0, 0],
              [100, 0],
              [100 + 100 * Math.cos(a), 100 * Math.sin(a)],
            ],
            false,
          );
          expectMatches(kink, stroke(width, "butt", join), 40);
        }
  });

  it("自己交差する輪郭 (8 の字) は重なりを 1 つの面にする", () => {
    const eight: Subpath[] = [
      {
        closed: true,
        points: [
          point(0, 0, { x: -30, y: 30 }, { x: 30, y: -30 }),
          point(100, 0, { x: 0, y: -40 }, { x: 0, y: 40 }),
          point(0, 0, { x: 30, y: 30 }, { x: -30, y: -30 }),
          point(-100, 0, { x: 0, y: -40 }, { x: 0, y: 40 }),
        ].map((p, i) => (i === 2 ? { ...p, x: 0.01 } : p)),
      },
    ];
    expectMatches(eight, stroke(8, "butt", "round"));
  });
});

describe("outlineStroke: 破線", { timeout: HEAVY_TIMEOUT_MS }, () => {
  it("開いた輪郭の破線 (線分の境目をまたぐ区間、端)", () => {
    const zig = polygon(
      [
        [0, 0],
        [40, 50],
        [80, 0],
        [140, 30],
      ],
      false,
    );
    for (const cap of CAPS)
      for (const join of JOINS) expectMatches(zig, stroke(6, cap, join, [17, 7]));
  });

  it("奇数個の破線は繰り返す", () => {
    const line = polygon(
      [
        [0, 0],
        [200, 0],
      ],
      false,
    );
    const r = expectMatches(line, stroke(4, "butt", "miter", [10, 5, 20]));
    // 10 on, 5 off, 20 on, 10 off, 5 on, 20 off, …
    expect(windingNumber(r, { x: 12, y: 0 })).toBe(0);
    expect(windingNumber(r, { x: 20, y: 0 })).toBe(1);
    expect(windingNumber(r, { x: 40, y: 0 })).toBe(0);
    expect(windingNumber(r, { x: 47, y: 0 })).toBe(1);
  });

  it("閉じた輪郭は始点から。最後の区間が終わりまで続いても先頭とつながない (WebKit と同じ)", () => {
    // 周 320。[25, 10] の最後の区間は 315〜320 で終わりまで届くが、始点 (0, 0) の角は描かない (どちらも端)
    const r = expectMatches(rect(0, 0, 100, 60), stroke(8, "butt", "miter", [25, 10]));
    expect(windingNumber(r, { x: -3.5, y: -3.5 })).toBe(0);
    expect(windingNumber(r, { x: 2, y: -3 })).toBe(1);
    expect(windingNumber(r, { x: -3, y: 2 })).toBe(1);
    // 40 × 40、太さ 10、[45, 5] (レビューの再現): 始点の角に 5 × 5 のマイターの四角を足さない
    const sq = expectMatches(rect(0, 0, 40, 40), stroke(10, "butt", "miter", [45, 5]));
    expect(windingNumber(sq, { x: -2.5, y: -2.5 })).toBe(0);
    // 閉じた三角形と [70, 10] も同じ
    const tri = polygon(
      [
        [0, 0],
        [60, 0],
        [30, 50],
      ],
      true,
    );
    expectMatches(tri, stroke(8, "butt", "miter", [70, 10]));
    // 実線の閉じた輪郭は始点にも角を描く
    const solid = expectMatches(rect(0, 0, 100, 60), stroke(8, "butt", "miter"));
    expect(windingNumber(solid, { x: -3.5, y: -3.5 })).toBe(1);
  });

  it("長さ 0 の破線は丸・四角の端の点になる (点線)", () => {
    const line = polygon(
      [
        [0, 0],
        [100, 0],
        [100, 50],
      ],
      false,
    );
    const dots = expectMatches(line, stroke(6, "round", "miter", [0, 10]));
    expect(windingNumber(dots, { x: 10, y: 0 })).toBe(1);
    expect(windingNumber(dots, { x: 5, y: 0 })).toBe(0);
    expectMatches(line, stroke(6, "square", "miter", [0, 10]));
    expect(outlineStroke(line, stroke(6, "butt", "miter", [0, 10]))).toEqual([]);
  });

  it("円の破線 (曲線の上の区間)", () => {
    for (const cap of CAPS)
      expectMatches(ellipse(60, 60, 50), stroke(5, cap, "miter", [12, 6, 3, 6]));
  });

  it("重なる破線は 1 つの面にする", () => {
    const loop: Subpath[] = [
      {
        closed: false,
        points: [point(0, 0, undefined, { x: 150, y: 0 }), point(0, 10, { x: 150, y: 0 })],
      },
    ];
    expectMatches(loop, stroke(10, "round", "round", [20, 4]));
  });
});

describe("outlineStroke: 長さ 0 と点", { timeout: HEAVY_TIMEOUT_MS }, () => {
  it("点 1 個の輪郭は描かない", () => {
    expect(outlineStroke([{ closed: false, points: [point(5, 5)] }], stroke(10, "round"))).toEqual(
      [],
    );
  });

  it("長さ 0 の輪郭は丸・四角の端の点 (四角は x 軸の向き)。butt と破線は描かない", () => {
    const zero = polygon(
      [
        [5, 5],
        [5, 5],
      ],
      false,
    );
    const round = expectMatches(zero, stroke(10, "round"));
    expect(windingNumber(round, { x: 5, y: 9.5 })).toBe(1);
    const square = expectMatches(zero, stroke(10, "square"));
    expect(windingNumber(square, { x: 9.5, y: 9.5 })).toBe(1);
    expect(outlineStroke(zero, stroke(10, "butt"))).toEqual([]);
    expect(outlineStroke(zero, stroke(10, "round", "miter", [3, 2]))).toEqual([]);
    expect(outlineStroke([{ ...zero[0]!, closed: true }], stroke(10, "round"))).toHaveLength(1);
  });

  it("輪郭の中の長さ 0 の線分は飛ばし、前後の向きで角を描く", () => {
    const dup = polygon(
      [
        [0, 0],
        [50, 0],
        [50, 0],
        [50, 40],
      ],
      false,
    );
    const r = expectMatches(dup, stroke(10, "butt", "miter"));
    expect(windingNumber(r, { x: 54, y: -4 })).toBe(1);
  });

  it("太さ 0 は空、有限でない座標は null", () => {
    expect(outlineStroke(rect(0, 0, 10, 10), stroke(0))).toEqual([]);
    const bad = polygon(
      [
        [0, 0],
        [Number.NaN, 0],
      ],
      false,
    );
    expect(outlineStroke(bad, stroke(1))).toBeNull();
  });
});

describe("outlineStroke: 乱れた形と座標", { timeout: HEAVY_TIMEOUT_MS }, () => {
  it("乱れた曲線の形 (乱数)", () => {
    const rand = random(7);
    for (let i = 0; i < 12; i++) {
      const blob = randomBlob(rand, 100, 100, 80, 3 + Math.floor(rand() * 6));
      const open = rand() < 0.4;
      const s = stroke(
        2 + rand() * 20,
        CAPS[Math.floor(rand() * 3)]!,
        JOINS[Math.floor(rand() * 3)]!,
        rand() < 0.4 ? [5 + rand() * 30, 2 + rand() * 10] : [],
      );
      expectMatches([{ ...blob, closed: !open }], s, 56);
    }
  });

  it("乱れた形 (曲線・折れ線、開いた・閉じた、太さ・端・角・破線もさまざま) 40 通り", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = random(seed * 7919);
      const blob = rand() < 0.6;
      const radius = 20 + rand() * 80;
      const count = 2 + Math.floor(rand() * 7);
      const sub = blob
        ? randomBlob(rand, 100, 100, radius, count)
        : randomPolygon(rand, 100, 100, radius, count);
      const closed = rand() < 0.6;
      const s = stroke(
        0.5 + rand() * rand() * 40,
        CAPS[Math.floor(rand() * 3)]!,
        JOINS[Math.floor(rand() * 3)]!,
        rand() < 0.4
          ? rand() < 0.3
            ? [0, 3 + rand() * 10]
            : [1 + rand() * 30, 1 + rand() * 10, ...(rand() < 0.3 ? [rand() * 5] : [])]
          : [],
      );
      expectMatches([{ ...sub, closed }], s, 40);
    }
  });

  it("星 (鋭い角) と回転した形", () => {
    const shape = transformSubpaths(star(5, 0.4, 0, 0, 120), rotate(17, 60, 60));
    for (const join of JOINS) expectMatches(shape, stroke(7, "butt", join));
  });

  it("大きな座標 (1e5 の所)", () => {
    const far = translateSubpaths(rect(0, 0, 100, 60, 10), 1e5, -1e5);
    expectMatches(far, stroke(4, "round", "round", [20, 7]));
  });

  it("細い線 (誤差 0.05 px) と太い線 (誤差は太さの 1%)", () => {
    expectMatches(ellipse(100, 100, 90, 40), stroke(0.5), 96);
    expectMatches(ellipse(100, 100, 90, 40), stroke(60, "round", "round"), 96);
  });
});

describe("strokeContours", () => {
  it("部品の輪郭はどれも時計回り", () => {
    const shapes = [rect(0, 0, 80, 50, 2), ellipse(50, 50, 3), ellipse(50, 50, 30)];
    for (const shape of shapes) {
      const c = strokeContours(shape, stroke(10, "round", "round", [7, 3]));
      expect(c.ok).toBe(true);
      if (!c.ok) continue;
      for (const sub of c.subpaths) expect(signedArea(sub)).toBeGreaterThanOrEqual(0);
    }
  });

  it("破線の区間が多すぎるときは tooComplex", () => {
    const line = polygon(
      [
        [0, 0],
        [100000, 0],
      ],
      false,
    );
    expect(strokeOutline(line, stroke(1, "butt", "miter", [1, 1]))).toEqual({
      ok: false,
      reason: "tooComplex",
    });
  });
});
