/**
 * パスの点の編集に使う幾何 (`docs/canvas-editor-design.md` §4.13.3)。
 *
 * 返すもの:
 * - `insertPointAt(sub, segmentIndex, t)`: 辺 `segmentIndex` (`subpathToSegments` の添字。点 i から点 i + 1、
 *   閉じる辺は n - 1) の t に点を足した輪郭。曲線の形は変わらない (de Casteljau で分ける)
 *   - 変えるのは、足す点と、辺の両端の 2 点のハンドル (前の点の `out`、次の点の `in`) だけ。ほかの点は
 *     同じオブジェクトのまま
 *   - 線分 (両端のハンドルが null) なら、ハンドルのない角の点を足す
 *   - 両端のハンドルの null はそのまま (null の側は点が制御点なので、分けても点に重なる)
 *   - 足す点の `mirror` は前後のハンドルから推す (`inferMirror`: 同じ直線の上なので `angle` か `angle-length`)。
 *     両端の点が `angle-length` で、分けてハンドルの長さがそろわなくなったら `angle` にする
 *   - t が 0 以下か 1 以上なら何もせず、同じ輪郭を返す (端の点に重なる点は足さない)
 *   - 辺の添字が範囲の外なら RangeError
 *
 * 前提: 純関数。
 */
import { splitSegment, type CubicSegment } from "../geometry/bezier";
import type { HandleMirror, PathPoint, Point, Subpath } from "../model/types";
import { inferMirror, segmentBetween } from "./segments";

export function insertPointAt(sub: Subpath, segmentIndex: number, t: number): Subpath {
  const pts = sub.points;
  const n = pts.length;
  const edges = n < 2 ? 0 : sub.closed ? n : n - 1;
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= edges) {
    throw new RangeError(`insertPointAt: no segment ${segmentIndex}`);
  }
  if (!(t > 0 && t < 1)) return sub;
  const i = segmentIndex;
  const j = (i + 1) % n;
  const p = pts[i]!;
  const q = pts[j]!;
  const seg = segmentBetween(p, q);
  let prev: PathPoint = p;
  let next: PathPoint = q;
  let added: PathPoint;
  if (seg.kind === "line") {
    added = {
      x: (1 - t) * p.x + t * q.x,
      y: (1 - t) * p.y + t * q.y,
      in: null,
      out: null,
      mirror: "none",
    };
  } else {
    const [left, right] = splitSegment(seg, t) as [CubicSegment, CubicSegment];
    const at = left.to;
    const handleIn = nonZero(sub2(left.c2, at));
    const handleOut = nonZero(sub2(right.c1, at));
    added = {
      x: at.x,
      y: at.y,
      in: handleIn,
      out: handleOut,
      mirror: inferMirror(handleIn, handleOut),
    };
    if (p.out) {
      const out = sub2(left.c1, p);
      prev = { ...p, out, mirror: keepMirror(p.mirror, p.in, out) };
    }
    if (q.in) {
      const inH = sub2(right.c2, q);
      next = { ...q, in: inH, mirror: keepMirror(q.mirror, inH, q.out) };
    }
  }
  const points = pts.slice();
  if (j === 0 && i === n - 1) {
    // 閉じる辺: 最後に足す。i と j が同じ点 (点 1 個) にはならない (n >= 2)
    points[i] = prev;
    points[0] = next;
    points.push(added);
  } else {
    points[i] = prev;
    points[j] = next;
    points.splice(j, 0, added);
  }
  return { closed: sub.closed, points };
}

function sub2(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function nonZero(v: Point): Point | null {
  return v.x === 0 && v.y === 0 ? null : v;
}

/** `angle-length` の点で、ハンドルの長さがそろわなくなったら `angle` にする。 */
function keepMirror(
  mirror: HandleMirror,
  handleIn: Point | null,
  handleOut: Point | null,
): HandleMirror {
  if (mirror !== "angle-length" || !handleIn || !handleOut) return mirror;
  const li = Math.hypot(handleIn.x, handleIn.y);
  const lo = Math.hypot(handleOut.x, handleOut.y);
  return Math.abs(li - lo) <= 1e-6 * Math.max(li, lo) ? mirror : "angle";
}
