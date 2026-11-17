/**
 * ブーリアン演算のテスト用の道具 (テストからだけ使う)。
 *
 * - 形を作る: 矩形 (角丸)、楕円、多角形、星、点の並びからの輪郭
 * - `compareOnGrid`: 結果の面と期待の面を、細かい格子の点で内外判定して比べる (`path/measure.ts` の
 *   `containsPoint`)。どれかの入力の輪郭に近い点 (境界の上はどちらにもなりうる) は除く。結果を `nonzero` で
 *   塗ったときの巻き数が 0 か 1 であること (外側が時計回り、穴が反時計回り) も調べる
 */
import {
  type Bounds,
  controlBounds,
  nearestPoint,
  type Segment,
  unionBounds,
} from "../geometry/bezier";
import type { BooleanOp, FillRule, PathPoint, Point, Subpath } from "../model/types";
import { pathBounds, windingNumber } from "../path/measure";
import { subpathToSegments } from "../path/segments";
import { ellipseSubpaths, rectSubpaths } from "../path/shapes";
import { polygonSubpath, starSubpath } from "../path/polygon";
import { translateSubpaths } from "../path/transform";
import type { BooleanOperand } from "./index";

export function point(x: number, y: number, inH?: Point, outH?: Point): PathPoint {
  return { x, y, in: inH ?? null, out: outH ?? null, mirror: "none" };
}

export function rect(x: number, y: number, w: number, h: number, radius = 0): Subpath[] {
  return translateSubpaths(rectSubpaths(w, h, radius), x, y);
}

export function ellipse(cx: number, cy: number, rx: number, ry = rx): Subpath[] {
  return translateSubpaths(ellipseSubpaths(2 * rx, 2 * ry), cx - rx, cy - ry);
}

export function polygon(points: readonly [number, number][], closed = true): Subpath[] {
  return [{ closed, points: points.map(([x, y]) => point(x, y)) }];
}

export function regularPolygon(sides: number, x: number, y: number, size: number): Subpath[] {
  return [polygonSubpath(sides, { x, y, width: size, height: size })];
}

export function star(points: number, ratio: number, x: number, y: number, size: number): Subpath[] {
  return [starSubpath(points, ratio, { x, y, width: size, height: size })];
}

export function operand(
  subpaths: readonly Subpath[],
  fillRule: FillRule = "nonzero",
): BooleanOperand {
  return { subpaths, fillRule };
}

function insideOf(w: number, rule: FillRule): boolean {
  return rule === "evenodd" ? (w & 1) === 1 : w !== 0;
}

/** 期待の面: 入力ごとの内外から演算で決める。 */
export function expectedInside(
  op: BooleanOp,
  operands: readonly BooleanOperand[],
  p: Point,
): boolean {
  const ins = operands.map((o) => insideOf(windingNumber(o.subpaths, p), o.fillRule));
  switch (op) {
    case "union":
      return ins.some(Boolean);
    case "intersect":
      return ins.length > 0 && ins.every(Boolean);
    case "exclude":
      return ins.filter(Boolean).length % 2 === 1;
    case "subtract":
      return ins.length > 0 && ins[0]! && !ins.slice(1).some(Boolean);
  }
}

interface BoundarySegment {
  seg: Segment;
  box: Bounds;
}

function boundarySegments(subpathsList: readonly (readonly Subpath[])[]): BoundarySegment[] {
  const out: BoundarySegment[] = [];
  for (const subpaths of subpathsList) {
    for (const sub of subpaths) {
      for (const seg of subpathToSegments(sub, { implicitClose: true })) {
        out.push({ seg, box: controlBounds(seg) });
      }
    }
  }
  return out;
}

function nearBoundary(segs: readonly BoundarySegment[], p: Point, margin: number): boolean {
  for (const { seg, box } of segs) {
    if (
      p.x < box.minX - margin ||
      p.x > box.maxX + margin ||
      p.y < box.minY - margin ||
      p.y > box.maxY + margin
    ) {
      continue;
    }
    if (nearestPoint(seg, p).distance <= margin) return true;
  }
  return false;
}

export interface GridReport {
  /** 比べた点の数 */
  checked: number;
  /** 期待と違った点 */
  mismatches: Point[];
  /** 巻き数が 0 と 1 以外だった点 */
  badWinding: Point[];
}

export interface GridOptions {
  /** 一辺の点の数 */
  steps?: number;
  /** 入力の輪郭からこの距離以内の点は比べない。省くと範囲の大きさ × 1e-3 */
  margin?: number;
}

/** 結果の面と期待の面を格子の点で比べる。 */
export function compareOnGrid(
  op: BooleanOp,
  operands: readonly BooleanOperand[],
  result: readonly Subpath[],
  options: GridOptions = {},
): GridReport {
  let box: Bounds | null = null;
  for (const o of operands) box = unionBounds(box, pathBounds(o.subpaths));
  const report: GridReport = { checked: 0, mismatches: [], badWinding: [] };
  if (!box) return report;
  const steps = options.steps ?? 48;
  const size = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1e-9);
  const margin = options.margin ?? size * 1e-3;
  const pad = size * 0.05;
  const segs = boundarySegments(operands.map((o) => o.subpaths));
  const resultSegs = boundarySegments([result]);
  // 格子は座標のちょうどの値に乗らないよう、半端な位置からずらす
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const p = {
        x: box.minX - pad + ((i + 0.5137) / steps) * (box.maxX - box.minX + 2 * pad),
        y: box.minY - pad + ((j + 0.4729) / steps) * (box.maxY - box.minY + 2 * pad),
      };
      if (nearBoundary(segs, p, margin)) continue;
      report.checked++;
      const w = windingNumber(result, p);
      if (w !== 0 && w !== 1 && !nearBoundary(resultSegs, p, margin)) report.badWinding.push(p);
      if ((w !== 0) !== expectedInside(op, operands, p)) report.mismatches.push(p);
    }
  }
  return report;
}

/** 決まった種から作る乱数 (mulberry32)。 */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 中心のまわりの乱れた多角形 (自己交差しうる)。 */
export function randomPolygon(
  rand: () => number,
  cx: number,
  cy: number,
  r: number,
  n: number,
): Subpath {
  const pts: PathPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const d = r * (0.2 + 0.8 * rand());
    pts.push(point(cx + d * Math.cos(a), cy + d * Math.sin(a)));
  }
  return { closed: true, points: pts };
}

/** 中心のまわりの、曲線でできた閉じた形 (角度の順に点を置き、乱れたハンドルを付ける)。 */
export function randomBlob(
  rand: () => number,
  cx: number,
  cy: number,
  r: number,
  n: number,
): Subpath {
  const pts: PathPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + rand() * 0.6) / n) * Math.PI * 2;
    const d = r * (0.4 + 0.6 * rand());
    const x = cx + d * Math.cos(a);
    const y = cy + d * Math.sin(a);
    const h = (r / n) * (0.5 + 1.5 * rand());
    const ha = a + Math.PI / 2 + (rand() - 0.5);
    const out = { x: h * Math.cos(ha), y: h * Math.sin(ha) };
    const smooth = rand() < 0.7;
    const inH = smooth
      ? { x: -out.x, y: -out.y }
      : { x: -out.x * 0.5 + (rand() - 0.5) * h, y: -out.y * 0.5 + (rand() - 0.5) * h };
    pts.push(point(x, y, inH, out));
  }
  return { closed: true, points: pts };
}
