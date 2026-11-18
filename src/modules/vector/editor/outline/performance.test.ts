/**
 * 線のアウトライン化の速さ (§8.10。目安はないので、アイコンの大きさ (曲線 200 本ほど) の 1 回の時間を測る)。
 *
 * 手元 (Apple Silicon、Node 24) の実測は PR の説明に書く。ここでは中央値に上限を置き、桁が変わるような遅れだけを
 * 捕まえる。CI の機械は遅く、ほかのテストのファイルと並んで動くので、CI では 3 倍にする
 * (`boolean/performance.test.ts` と同じ考え方)。
 */
import { describe, expect, it } from "vitest";
import { booleanOperation } from "../boolean/index";
import { ellipse, operand, rect, star } from "../boolean/testing";
import { rotate } from "../geometry/matrix";
import type { Subpath } from "../model/types";
import { subpathToSegments } from "../path/segments";
import { transformSubpaths } from "../path/transform";
import { strokeOutline, type StrokeShape } from "./index";

const BUDGET_MS = process.env["CI"] ? 300 : 100;

/** 歯車のアイコン: 角丸の歯 12 本の外形、穴 (円 17 個、星、角丸の矩形 6 個)。曲線 198 本 */
function gearIconPath(): Subpath[] {
  const ops = [operand(ellipse(100, 100, 60))];
  for (let i = 0; i < 12; i++) {
    ops.push(operand(transformSubpaths(rect(90, 20, 20, 40, 6), rotate(i * 30, 100, 100))));
  }
  const outer = booleanOperation("union", ops)!;
  const holes: Subpath[] = [...ellipse(100, 100, 14), ...star(5, 0.45, 75, 75, 50)];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    holes.push(...ellipse(100 + 44 * Math.cos(a), 100 + 44 * Math.sin(a), 4));
  }
  for (let i = 0; i < 6; i++) holes.push(...rect(52 + i * 16, 168, 12, 18, 3));
  return [...outer, ...holes];
}

function curveCount(subpaths: readonly Subpath[]): number {
  return subpaths.reduce((n, s) => n + subpathToSegments(s).length, 0);
}

function medianMs(fn: () => void, runs = 9): number {
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)]!;
}

const CASES: [string, StrokeShape][] = [
  ["太さ 2、実線", { width: 2, cap: "butt", join: "miter", dash: [] }],
  ["太さ 2、破線 6 3", { width: 2, cap: "butt", join: "miter", dash: [6, 3] }],
  ["太さ 3、丸の点線 0 6", { width: 3, cap: "round", join: "round", dash: [0, 6] }],
  ["太さ 8、丸、破線 10 4", { width: 8, cap: "round", join: "round", dash: [10, 4] }],
  ["太さ 12、実線 (角丸と小さい円がきつい)", { width: 12, cap: "butt", join: "miter", dash: [] }],
];

/** 交わりの多い大きな形 (合体の手間が大きい)。1 秒ほどで終わるか、手間を見積もって断ること (§8.10)。 */
const point = (x: number, y: number, h?: [number, number]) => ({
  x,
  y,
  in: h ? { x: -h[0], y: -h[1] } : null,
  out: h ? { x: h[0], y: h[1] } : null,
  mirror: "none" as const,
});

/** 縦横の網掛けを 1 本の折れ線で (200 + 200 点、交点 4 万ほど)。 */
function hatch(n: number, size: number): Subpath[] {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(point(i % 2 ? size : 0, (i * size) / n + (i % 2) * 2));
  for (let i = 0; i < n; i++) pts.push(point((i * size) / n + (i % 2) * 2, i % 2 ? size : 0));
  return [{ closed: false, points: pts }];
}

/** 乱数の 3 次ベジェの落書き (n 本、300 px 四方)。 */
function scribble(n: number, seed: number): Subpath[] {
  let s = seed >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pts = Array.from({ length: n }, () => {
    const x = r() * 300;
    const y = r() * 300;
    return point(x, y, [(r() - 0.5) * 40, (r() - 0.5) * 40]);
  });
  return [{ closed: false, points: pts }];
}

const HEAVY_BUDGET_MS = process.env["CI"] ? 3000 : 1000;

describe("outlineStroke の速さ (交わりの多い形)", () => {
  const heavy: [string, Subpath[], StrokeShape][] = [
    ["網掛け 400 点、太さ 3", hatch(200, 300), { width: 3, cap: "round", join: "round", dash: [] }],
    [
      "落書き 300 本、太さ 8",
      scribble(300, 1),
      { width: 8, cap: "round", join: "round", dash: [] },
    ],
    [
      "落書き 1000 本、太さ 8",
      scribble(1000, 2),
      { width: 8, cap: "round", join: "round", dash: [] },
    ],
  ];
  for (const [name, subpaths, stroke] of heavy) {
    it(`${name}: ${HEAVY_BUDGET_MS} ms 以内に終わるか断る`, () => {
      const t0 = performance.now();
      const result = strokeOutline(subpaths, stroke);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(HEAVY_BUDGET_MS);
      expect(result.ok || result.reason === "tooComplex").toBe(true);
    });
  }

  it("網掛け 100 + 100 点 (交点 1 万ほど) は求められる", () => {
    expect(
      strokeOutline(hatch(100, 300), { width: 3, cap: "round", join: "round", dash: [] }).ok,
    ).toBe(true);
  });
});

describe("outlineStroke の速さ", () => {
  const icon = gearIconPath();

  it("アイコンは曲線 200 本ほど", () => {
    const n = curveCount(icon);
    expect(n).toBeGreaterThan(180);
    expect(n).toBeLessThan(220);
  });

  for (const [name, stroke] of CASES) {
    it(`${name}: 中央値 ${BUDGET_MS} ms 以内`, () => {
      let ok = false;
      const ms = medianMs(() => {
        ok = strokeOutline(icon, stroke).ok;
      });
      expect(ok).toBe(true);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});
