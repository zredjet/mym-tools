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
 * - `windingsBeside(segments, index, t)`: 輪郭の上の点のすぐ左右の巻き数 (ブーリアン演算で、分けた曲線の
 *   部分を残すかを決めるのに使う)。自分を除いて数え、曲線が横向きの所では縦の光線に切り替える。ほかの曲線
 *   (同じ曲線の離れた部分も) が点の許容値以内を通れば `ambiguous` (光線に沿う辺や光線に接する極値も、点からの
 *   距離で見つける)
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
  controlBounds,
  derivativeAt,
  type NearestPoint,
  nearestPoint,
  pointAt,
  type Segment,
  segmentBounds,
  segmentExtrema,
  segmentMagnitude,
  subSegment,
  tangentAt,
  toleranceFor,
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
  // 範囲の外なら交わらない
  if (seg.kind === "cubic") {
    const minY = Math.min(seg.from.y, seg.c1.y, seg.c2.y, seg.to.y);
    const maxY = Math.max(seg.from.y, seg.c1.y, seg.c2.y, seg.to.y);
    if (p.y < minY || p.y >= maxY) return 0;
    if (p.x >= Math.max(seg.from.x, seg.c1.x, seg.c2.x, seg.to.x)) return 0;
  }
  let w = 0;
  for (const c of axisCrossings(seg, "y", p.y)) {
    if (c.other > p.x) w += c.increasing ? 1 : -1;
  }
  return w;
}

interface AxisCrossing {
  t: number;
  /** 交わる点のもう一方の座標 (`axis` が y なら x) */
  other: number;
  /** `axis` の座標が増える向きに横切るか */
  increasing: boolean;
}

/**
 * 曲線と直線 (`axis` の座標 = `value`) の交わり。曲線を `axis` の極値で単調な区間に分け、区間ごとに
 * 半開区間 [下端, 上端) の規則で数える (頂点や接線を二重に数えない)。交わる t は挟み撃ちで 1e-15 まで詰める。
 */
function axisCrossings(seg: Segment, axis: "x" | "y", value: number): AxisCrossing[] {
  const coord = (q: Point) => (axis === "y" ? q.y : q.x);
  const otherOf = (q: Point) => (axis === "y" ? q.x : q.y);
  const out: AxisCrossing[] = [];
  const stops = seg.kind === "line" ? [0, 1] : [0, ...segmentExtrema(seg)[axis], 1];
  let c0 = coord(seg.from);
  for (let i = 1; i < stops.length; i++) {
    const t0 = stops[i - 1]!;
    const t1 = stops[i]!;
    const c1 = i === stops.length - 1 ? coord(seg.to) : coord(pointAt(seg, t1));
    const prev = c0;
    c0 = c1;
    if (prev === c1) continue;
    const increasing = c1 > prev;
    const lo = Math.min(prev, c1);
    const hi = Math.max(prev, c1);
    if (value < lo || value >= hi) continue;
    let t: number;
    if (seg.kind === "line") {
      t = (value - prev) / (c1 - prev);
    } else {
      let a = t0;
      let b = t1;
      for (let k = 0; k < 80 && b - a > 1e-15; k++) {
        const m = (a + b) / 2;
        if ((coord(pointAt(seg, m)) - value) * (increasing ? 1 : -1) < 0) a = m;
        else b = m;
      }
      t = (a + b) / 2;
    }
    out.push({ t, other: otherOf(pointAt(seg, t)), increasing });
  }
  return out;
}

/** `segments[index]` の t の点 p を、ほかの曲線 (同じ曲線の t から離れた部分も) が許容値以内で通るか。 */
function passesThrough(
  segments: readonly Segment[],
  index: number,
  t: number,
  p: Point,
  tol: number,
): boolean {
  for (let k = 0; k < segments.length; k++) {
    const other = segments[k]!;
    const b = controlBounds(other);
    if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) {
      continue;
    }
    if (k !== index) {
      if (nearestPoint(other, p).distance <= tol) return true;
      continue;
    }
    // 自分: t のまわり (点から許容値の 10 倍より近い所) を除いた部分
    const d = derivativeAt(other, t);
    const speed = Math.hypot(d.x, d.y);
    const gap = Math.max(1e-6, speed > 0 ? (10 * tol) / speed : 1e-6);
    if (t - gap > 0 && nearestPoint(subSegment(other, 0, t - gap), p).distance <= tol) return true;
    if (t + gap < 1 && nearestPoint(subSegment(other, t + gap, 1), p).distance <= tol) return true;
  }
  return false;
}

export interface SideWindings {
  /** 曲線の進む向きに見て左 (y が下向きの画面で見たとおり) の巻き数 */
  left: number;
  /** 右の巻き数。この曲線だけを見れば right = left + 1 (時計回りの内側は右) */
  right: number;
  /**
   * ほかの曲線 (同じ曲線の離れた部分も) が同じ点の許容値以内を通る、または t が端にあり、どちらの側に数えるかが
   * 決まらない。このとき left / right は信用しない。ブーリアン演算では、この曲線の別の t で求め直す
   */
  ambiguous: boolean;
}

/**
 * 輪郭の上の点 (曲線 `segments[index]` の t の点) のすぐ左右の巻き数 (paper.js の windingL / windingR に当たる)。
 * - `segments` は閉じた線分の並び (`subpathToSegments(sub, { implicitClose: true })` を輪郭の分つなげたもの)
 * - その点を通る光線で、ほかの曲線 (同じ曲線のほかの t を含む) の交わりを数える。曲線がそこで縦寄りなら
 *   横の光線、横寄りなら縦の光線を使う (光線が曲線に沿って当たらないように)
 * - 自分の寄与は向きから決める (自分を交わりとして数えない)
 * - t は 0 と 1 から離れた値で呼ぶ (端では隣の曲線も同じ点を通るので `ambiguous`)
 */
export function windingsBeside(
  segments: readonly Segment[],
  index: number,
  t: number,
  options: { tolerance?: number } = {},
): SideWindings {
  const seg = segments[index];
  if (!seg) throw new RangeError(`windingsBeside: no segment at ${index}`);
  const p = pointAt(seg, t);
  const dir = tangentAt(seg, t);
  const tol =
    options.tolerance ??
    toleranceFor(Math.max(segmentMagnitude(seg), Math.abs(p.x), Math.abs(p.y)));
  let ambiguous = !dir || t <= 1e-9 || t >= 1 - 1e-9;
  if (!dir) return { left: 0, right: 0, ambiguous };
  const horizontalRay = Math.abs(dir.y) >= Math.abs(dir.x);
  const axis = horizontalRay ? "y" : "x";
  const value = horizontalRay ? p.y : p.x;
  const at = horizontalRay ? p.x : p.y;
  // 光線: 横なら +x、縦なら +y の向き。巻き数は横なら y が増える横切りで +1、縦なら x が減る横切りで +1
  // (どちらも時計回りの輪郭の内側で +1 になる向き)
  const weight = (c: AxisCrossing) =>
    horizontalRay ? (c.increasing ? 1 : -1) : c.increasing ? -1 : 1;
  // ほかの曲線 (同じ曲線のほかの t も) が点を通るなら、どちらの側に数えるかが決まらない。光線と同じ向きの辺や、
  // 光線に接する極値は交わりとして数えないので、交わりの位置ではなく点からの距離で調べる
  if (!ambiguous) ambiguous = passesThrough(segments, index, t, p, tol);
  let beyond = 0; // 点より光線の先 (+x / +y) にある交わり
  segments.forEach((other, k) => {
    let crossings = axisCrossings(other, axis, value);
    if (k === index) {
      // 自分の t の交わりを除く
      let nearest = -1;
      crossings.forEach((c, i) => {
        if (
          Math.abs(c.t - t) <= 1e-6 &&
          (nearest < 0 || Math.abs(c.t - t) < Math.abs(crossings[nearest]!.t - t))
        ) {
          nearest = i;
        }
      });
      if (nearest >= 0) crossings = crossings.filter((_, i) => i !== nearest);
    }
    for (const c of crossings) {
      if (Math.abs(c.other - at) <= tol) ambiguous = true;
      if (c.other > at) beyond += weight(c);
    }
  });
  // 自分の寄与。光線の手前 (−x / −y) の点からは、自分も先にある
  const selfWeight = horizontalRay ? (dir.y > 0 ? 1 : -1) : dir.x < 0 ? 1 : -1;
  const behindSide = beyond + selfWeight; // 点の手前 (−x / −y) 側の巻き数
  const aheadSide = beyond; // 点の先 (+x / +y) 側の巻き数
  // 進む向きの左は (dir.y, −dir.x) の向き
  const leftIsAhead = horizontalRay ? dir.y > 0 : dir.x < 0;
  return leftIsAhead
    ? { left: aheadSide, right: behindSide, ambiguous }
    : { left: behindSide, right: aheadSide, ambiguous };
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
