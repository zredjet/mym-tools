/**
 * パスの点の形 (`Subpath` / `PathPoint`、`model/types.ts` の契約) と、計算しやすい線分の並び (`Segment[]`、
 * `geometry/bezier.ts`) の相互変換 (`docs/canvas-editor-design.md` §8.6)。
 *
 * 返すもの:
 * - `subpathToSegments(sub)`: 点 i から点 i + 1 への線分 (または曲線) の並び。閉じた輪郭は最後に
 *   最後の点から先頭の点への 1 本を足す (添字 n - 1)。`implicitClose` を付けると、開いた輪郭も
 *   最後の点から先頭の点への線分で閉じる (塗りの判定用。終点と始点が同じなら足さない)
 *   - 前の点の `out` と次の点の `in` がどちらも null なら線分、そうでなければ 3 次ベジェ
 *     (null の側は点そのものを制御点にする)。`d` の書き出しと同じ規則
 *   - 点が 1 個の輪郭は空 (描かれない、§8.4)
 * - `segmentsToSubpath(segments, closed)`: 逆向き。各線分の `from` を点にし、制御点をハンドル (点からの相対) に
 *   する。ハンドルが点と同じ (長さ 0) なら null。`mirror` は `inferMirror` で決める
 *   - 閉じた輪郭で、最後の線分の `to` が先頭の `from` と (許容値の中で) 同じなら、その線分を閉じる辺にする
 *     (先頭の点を最後に重ねて持たない)。違えば `to` を最後の点にし、閉じる辺は線分になる
 *   - 点が 1 個になる閉じた輪郭 (始点に戻る曲線 1 本) は、曲線を t = 0.5 で分けて 2 点にする
 *     (点 1 個の輪郭は描かれないため)
 *   - 線分はつながっている (`segments[i].to` と `segments[i + 1].from` が同じ) こと。違っても `from` を使う
 * - `inferMirror(in, out)`: 両方のハンドルが逆向きにそろっていれば `angle`、長さもそろえば `angle-length`
 *
 * 誤差と前提:
 * - 純関数。点とハンドルは新しいオブジェクト
 * - 「同じ点」の許容値は max(1e-9, 座標の大きさ × 1e-12) (`samePointTolerance`)。相対座標の `d` を足し合わせた
 *   丸めの誤差を吸収する程度
 * - `inferMirror` は向きの sin と長さの比の差が 1e-6 以内でそろっているとみなす
 */
import { cross, dot, splitSegment, type Segment } from "../geometry/bezier";
import type { HandleMirror, PathPoint, Point, Subpath } from "../model/types";

export interface SubpathToSegmentsOptions {
  /** 開いた輪郭を、最後の点から先頭の点への線分で閉じる (塗り・内外判定用) */
  implicitClose?: boolean;
}

export function subpathToSegments(sub: Subpath, options: SubpathToSegmentsOptions = {}): Segment[] {
  const pts = sub.points;
  const n = pts.length;
  if (n < 2) return [];
  const out: Segment[] = [];
  for (let i = 0; i + 1 < n; i++) out.push(segmentBetween(pts[i]!, pts[i + 1]!));
  const last = pts[n - 1]!;
  const first = pts[0]!;
  if (sub.closed) {
    out.push(segmentBetween(last, first));
  } else if (options.implicitClose && (last.x !== first.x || last.y !== first.y)) {
    out.push({
      kind: "line",
      from: { x: last.x, y: last.y },
      to: { x: first.x, y: first.y },
    });
  }
  return out;
}

/** 輪郭ごとの線分の並び。点が 1 個の輪郭は空の配列 (添字は `subpaths` と同じ)。 */
export function subpathsToSegments(
  subpaths: readonly Subpath[],
  options: SubpathToSegmentsOptions = {},
): Segment[][] {
  return subpaths.map((sub) => subpathToSegments(sub, options));
}

/** 点 p から点 q への線分 (または曲線)。§8.6 の `d` の規則と同じ。 */
export function segmentBetween(p: PathPoint, q: PathPoint): Segment {
  const from = { x: p.x, y: p.y };
  const to = { x: q.x, y: q.y };
  if (p.out === null && q.in === null) return { kind: "line", from, to };
  return {
    kind: "cubic",
    from,
    c1: p.out ? { x: p.x + p.out.x, y: p.y + p.out.y } : { x: p.x, y: p.y },
    c2: q.in ? { x: q.x + q.in.x, y: q.y + q.in.y } : { x: q.x, y: q.y },
    to,
  };
}

export function samePointTolerance(magnitude: number): number {
  return Math.max(1e-9, magnitude * 1e-12);
}

export function segmentsToSubpath(segments: readonly Segment[], closed: boolean): Subpath {
  if (segments.length === 0) throw new RangeError("segmentsToSubpath: segments is empty");
  const first = segments[0]!;
  const lastSeg = segments[segments.length - 1]!;
  if (closed && segments.length === 1 && nearlySame(lastSeg.to, first.from)) {
    // 始点に戻る曲線 1 本は、2 点にしないと描けない
    if (lastSeg.kind === "line") {
      return { closed: true, points: [plainPoint(first.from), plainPoint(lastSeg.to)] };
    }
    const [a, b] = splitSegment(lastSeg, 0.5);
    return segmentsToSubpath([a, b], true);
  }
  const points: { x: number; y: number; in: Point | null; out: Point | null }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = i > 0 ? segments[i - 1]! : null;
    points.push({
      x: seg.from.x,
      y: seg.from.y,
      in: prev ? handleIn(prev) : null,
      out: handleOut(seg),
    });
  }
  if (closed && nearlySame(lastSeg.to, first.from)) {
    // 最後の線分が閉じる辺
    points[0]!.in = handleIn(lastSeg);
  } else {
    points.push({ x: lastSeg.to.x, y: lastSeg.to.y, in: handleIn(lastSeg), out: null });
  }
  return {
    closed,
    points: points.map((p) => ({ ...p, mirror: inferMirror(p.in, p.out) })),
  };
}

function handleOut(seg: Segment): Point | null {
  if (seg.kind === "line") return null;
  return nonZero({ x: seg.c1.x - seg.from.x, y: seg.c1.y - seg.from.y });
}

function handleIn(seg: Segment): Point | null {
  if (seg.kind === "line") return null;
  return nonZero({ x: seg.c2.x - seg.to.x, y: seg.c2.y - seg.to.y });
}

function nonZero(v: Point): Point | null {
  return v.x === 0 && v.y === 0 ? null : v;
}

function plainPoint(p: Point): PathPoint {
  return { x: p.x, y: p.y, in: null, out: null, mirror: "none" };
}

function nearlySame(p: Point, q: Point): boolean {
  const tol = samePointTolerance(
    Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(q.x), Math.abs(q.y)),
  );
  return Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
}

const MIRROR_EPSILON = 1e-6;

/** ハンドルの組から連動の種類を推す。どちらかが null なら `none`。 */
export function inferMirror(handleIn: Point | null, handleOut: Point | null): HandleMirror {
  if (!handleIn || !handleOut) return "none";
  const li = Math.hypot(handleIn.x, handleIn.y);
  const lo = Math.hypot(handleOut.x, handleOut.y);
  if (li === 0 || lo === 0) return "none";
  const sin = cross(handleIn, handleOut) / (li * lo);
  if (Math.abs(sin) > MIRROR_EPSILON || dot(handleIn, handleOut) >= 0) return "none";
  return Math.abs(li - lo) <= MIRROR_EPSILON * Math.max(li, lo) ? "angle-length" : "angle";
}
