/**
 * パスの範囲、面積と向き、内外判定、輪郭までの距離 (`docs/canvas-editor-design.md` §8.5.1、§8.5.8、§8.6、§8.9.2)。
 *
 * 返すもの:
 * - `pathBounds(subpaths, matrix?)`: 曲線そのものの範囲 (ハンドルの先は含めない)。行列を渡すと、点とハンドルを
 *   写した形の範囲 (回転した円が大きくならない、§8.5.1)。点が 1 個の輪郭は、その点を含める (箱を合わせる
 *   `fitPathNodes` が描きかけのパスにも箱を持たせるため)。点がなければ null
 * - `signedArea(sub)` / `isClockwise(sub)`: 閉じた形の符号つきの面積。開いた輪郭は最後の点から先頭へ閉じた形。
 *   y が下向きの座標で時計回りなら正 (`isClockwise` が true)。3 次ベジェの面積は厳密な式
 * - `windingNumber(subpaths, p)` / `windingNumberOfSegments(segments, p)`: 点を通る右向きの半直線と輪郭の
 *   交わりから求めた巻き数。時計回りの輪郭の内側で +1。開いた輪郭は閉じた形として扱う
 *   (`windingNumberOfSegments` は閉じた線分の並びを受け、閉じない)
 * - `containsPoint(subpaths, p, fillRule)`: `nonzero` は巻き数が 0 でない、`evenodd` は奇数
 * - `nearestOnPath(subpaths, p)` / `distanceToPath(subpaths, p)`: 描かれる輪郭 (閉じた輪郭は閉じる辺を含み、
 *   開いた輪郭は含まない。点が 1 個の輪郭は描かれないので除く) で最も近い点と距離。
 *   `segmentIndex` は `subpathToSegments` の添字 (点 i から点 i + 1 への辺。閉じる辺は n - 1)
 *
 * 誤差と前提:
 * - 巻き数は、曲線を y の極値で単調な区間に分け、区間ごとに半開区間 [下端, 上端) の規則で数える
 *   (頂点や水平の接線を二重に数えない)。交わる t は挟み撃ちで 1e-15 まで詰めるので、曲線から 1e-9 px 程度より
 *   離れた点は正しく判定する。輪郭の上の点 (距離がそれ以下) はどちらにもなりうる。当たりの判定では
 *   距離と組み合わせて使う
 * - 距離の誤差は `nearestPoint` (`geometry/bezier.ts`) と同じ
 */
import {
  type Bounds,
  type NearestPoint,
  nearestPoint,
  pointAt,
  type Segment,
  segmentBounds,
  segmentExtrema,
  transformSegment,
  unionBounds,
} from "../geometry/bezier";
import { applyToPoint, type Matrix } from "../geometry/matrix";
import type { FillRule, Point, Subpath } from "../model/types";
import { subpathToSegments } from "./segments";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boundsToRect(b: Bounds): Rect {
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

// ---------------------------------------------------------------------------
// 範囲
// ---------------------------------------------------------------------------

export function pathBounds(subpaths: readonly Subpath[], matrix?: Matrix): Bounds | null {
  let out: Bounds | null = null;
  for (const sub of subpaths) {
    if (sub.points.length === 0) continue;
    if (sub.points.length === 1) {
      const p0 = sub.points[0]!;
      const p = matrix ? applyToPoint(matrix, p0) : { x: p0.x, y: p0.y };
      out = unionBounds(out, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
      continue;
    }
    for (const seg of subpathToSegments(sub)) {
      out = unionBounds(out, segmentBounds(matrix ? transformSegment(seg, matrix) : seg));
    }
  }
  return out;
}

/** `pathBounds` を `{ x, y, width, height }` で。点がなければ null。 */
export function pathBoundsRect(subpaths: readonly Subpath[], matrix?: Matrix): Rect | null {
  const b = pathBounds(subpaths, matrix);
  return b ? boundsToRect(b) : null;
}

// ---------------------------------------------------------------------------
// 面積と向き
// ---------------------------------------------------------------------------

/** 線分 1 本の面積への寄与 (1/2 ∮ (x dy − y dx))。閉じた並びを足し合わせると囲む面積。 */
export function segmentArea(seg: Segment): number {
  const x0 = seg.from.x;
  const y0 = seg.from.y;
  const x3 = seg.to.x;
  const y3 = seg.to.y;
  if (seg.kind === "line") return (x0 * y3 - x3 * y0) / 2;
  const x1 = seg.c1.x;
  const y1 = seg.c1.y;
  const x2 = seg.c2.x;
  const y2 = seg.c2.y;
  return (
    (6 * (x0 * y1 - x1 * y0) +
      3 * (x0 * y2 - x2 * y0) +
      (x0 * y3 - x3 * y0) +
      3 * (x1 * y2 - x2 * y1) +
      3 * (x1 * y3 - x3 * y1) +
      6 * (x2 * y3 - x3 * y2)) /
    20
  );
}

export function signedArea(sub: Subpath): number {
  let area = 0;
  for (const seg of subpathToSegments(sub, { implicitClose: true })) area += segmentArea(seg);
  return area;
}

/** y が下向きの座標で時計回り (面積が正)。面積が 0 なら false。 */
export function isClockwise(sub: Subpath): boolean {
  return signedArea(sub) > 0;
}

// ---------------------------------------------------------------------------
// 内外判定
// ---------------------------------------------------------------------------

export function windingNumber(subpaths: readonly Subpath[], p: Point): number {
  let w = 0;
  for (const sub of subpaths) {
    w += windingNumberOfSegments(subpathToSegments(sub, { implicitClose: true }), p);
  }
  return w;
}

export function windingNumberOfSegments(segments: readonly Segment[], p: Point): number {
  let w = 0;
  for (const seg of segments) w += segmentWinding(seg, p);
  return w;
}

export function containsPoint(subpaths: readonly Subpath[], p: Point, fillRule: FillRule): boolean {
  const w = windingNumber(subpaths, p);
  return fillRule === "evenodd" ? (w & 1) === 1 : w !== 0;
}

function segmentWinding(seg: Segment, p: Point): number {
  if (seg.kind === "line") {
    return monotoneWinding(seg, 0, 1, seg.from.y, seg.to.y, p);
  }
  // 範囲の外なら交わらない
  const minY = Math.min(seg.from.y, seg.c1.y, seg.c2.y, seg.to.y);
  const maxY = Math.max(seg.from.y, seg.c1.y, seg.c2.y, seg.to.y);
  if (p.y < minY || p.y >= maxY) return 0;
  const maxX = Math.max(seg.from.x, seg.c1.x, seg.c2.x, seg.to.x);
  if (p.x >= maxX) return 0;
  const stops = [0, ...segmentExtrema(seg).y, 1];
  let w = 0;
  let prevY = seg.from.y;
  for (let i = 1; i < stops.length; i++) {
    const t1 = stops[i]!;
    const y1 = i === stops.length - 1 ? seg.to.y : pointAt(seg, t1).y;
    w += monotoneWinding(seg, stops[i - 1]!, t1, prevY, y1, p);
    prevY = y1;
  }
  return w;
}

/** y が単調な区間 [t0, t1] (両端の y は y0, y1) と、点から右への半直線の交わり。下向き (+y) なら +1。 */
function monotoneWinding(
  seg: Segment,
  t0: number,
  t1: number,
  y0: number,
  y1: number,
  p: Point,
): number {
  if (y0 === y1) return 0;
  const dir = y1 > y0 ? 1 : -1;
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  if (p.y < lo || p.y >= hi) return 0;
  let x: number;
  if (seg.kind === "line") {
    const s = (p.y - seg.from.y) / (seg.to.y - seg.from.y);
    x = seg.from.x + (seg.to.x - seg.from.x) * s;
  } else {
    // y(t) = p.y を挟み撃ちで解く
    let a = t0;
    let b = t1;
    for (let i = 0; i < 80 && b - a > 1e-15; i++) {
      const m = (a + b) / 2;
      const ym = pointAt(seg, m).y;
      if ((ym - p.y) * dir < 0) a = m;
      else b = m;
    }
    x = pointAt(seg, (a + b) / 2).x;
  }
  return x > p.x ? dir : 0;
}

// ---------------------------------------------------------------------------
// 距離
// ---------------------------------------------------------------------------

export interface PathNearestPoint extends NearestPoint {
  subpathIndex: number;
  /** `subpathToSegments` の添字。点 i から点 i + 1 (閉じる辺は n - 1) */
  segmentIndex: number;
}

export function nearestOnPath(subpaths: readonly Subpath[], p: Point): PathNearestPoint | null {
  let best: PathNearestPoint | null = null;
  subpaths.forEach((sub, subpathIndex) => {
    subpathToSegments(sub).forEach((seg, segmentIndex) => {
      const n = nearestPoint(seg, p);
      if (!best || n.distance < best.distance) best = { ...n, subpathIndex, segmentIndex };
    });
  });
  return best;
}

/** 描かれる輪郭までの距離。描かれる輪郭がなければ `Infinity`。 */
export function distanceToPath(subpaths: readonly Subpath[], p: Point): number {
  return nearestOnPath(subpaths, p)?.distance ?? Infinity;
}
