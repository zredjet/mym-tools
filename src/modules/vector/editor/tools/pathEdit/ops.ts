/**
 * 点の編集とペンが使う純関数 (`docs/canvas-editor-design.md` §8.6、§8.7)。
 *
 * - 座標: パスの点はノードの座標系 (回転の前の箱の左上が原点)。ポインターから決まる点とハンドルは、
 *   親の座標系で小数第 2 位に丸めてから入れる (§8.6)。回転したパス、回転した frame の中のパスでも、
 *   行列 (`model/geometry.ts`) でページ座標と行き来する
 * - 当たり: 点・ハンドル・線分の当たりはページ座標で、画面 px の余裕を倍率で割って判定する
 * - 形の変更: 輪郭の並び (`Subpath[]`) を受け取って新しい並びを返す。変えない点は同じオブジェクトのまま
 * - 文書への反映: `withSubpaths` が形を入れ、同じ変更の中で `fitPathNodes` を通して箱を合わせ直し、
 *   §3.5 と §8.3.2 の上限を確かめる (超えるなら null。当てない)
 */
import { applyToPoint, applyToVector, invert, multiply, type Matrix } from "../../geometry/matrix";
import { nearestPoint } from "../../geometry/bezier";
import { coordinateMatrix, nodeTransform } from "../../model/geometry";
import { CANVAS_LIMITS } from "../../model/limits";
import { deleteNodes } from "../../model/structure";
import { updateNode } from "../../model/transform";
import { getNode } from "../../model/tree";
import type {
  CanvasDocument,
  HandleMirror,
  NodeId,
  PathNode,
  PathPoint,
  Point,
  Subpath,
} from "../../model/types";
import { geometryWithinLimits } from "../../panels/limits";
import type { HandleSide, PointRef } from "../../path/editSession";
import { insertPointAt } from "../../path/edit";
import { fitPathNodes } from "../../path/fit";
import { subpathToSegments } from "../../path/segments";

/** 点の当たりの半径 (画面 px)。 */
export const POINT_HIT_RADIUS = 6;
/** ハンドルの先の当たりの半径 (画面 px)。 */
export const HANDLE_HIT_RADIUS = 6;
/** 線分の当たりの距離 (画面 px)。 */
export const SEGMENT_HIT_DISTANCE = 4;

/** 小数第 2 位に丸める (`-0` は `0`)。 */
export function round2(value: number): number {
  const r = Math.round(value * 100) / 100;
  return r === 0 ? 0 : r;
}

// ---------------------------------------------------------------------------
// 座標
// ---------------------------------------------------------------------------

/** パスの座標系の行列。 */
export interface PathSpace {
  /** ページ ← 親の座標系 */
  parentToPage: Matrix;
  /** 親の座標系 ← ページ */
  pageToParent: Matrix;
  /** 親の座標系 ← ノードの座標系 */
  localToParent: Matrix;
  /** ノードの座標系 ← 親の座標系 */
  parentToLocal: Matrix;
  /** ページ ← ノードの座標系 */
  localToPage: Matrix;
  /** ノードの座標系 ← ページ */
  pageToLocal: Matrix;
}

export function pathSpace(doc: CanvasDocument, node: PathNode): PathSpace | null {
  const parentToPage = coordinateMatrix(doc, node.id);
  const localToParent = nodeTransform(node);
  const pageToParent = invert(parentToPage);
  const parentToLocal = invert(localToParent);
  if (!pageToParent || !parentToLocal) return null;
  const localToPage = multiply(parentToPage, localToParent);
  return {
    parentToPage,
    pageToParent,
    localToParent,
    parentToLocal,
    localToPage,
    pageToLocal: multiply(parentToLocal, pageToParent),
  };
}

/** ページ座標の点を、親の座標系で丸めてからノードの座標系へ直す (§8.6)。 */
export function pageToLocalRounded(space: PathSpace, page: Point): Point {
  const parent = applyToPoint(space.pageToParent, page);
  return applyToPoint(space.parentToLocal, { x: round2(parent.x), y: round2(parent.y) });
}

/** ページ座標のベクトルを、親の座標系で丸めてからノードの座標系へ直す。長さ 0 になれば null。 */
export function pageVectorToLocalRounded(space: PathSpace, vector: Point): Point | null {
  const parent = applyToVector(space.pageToParent, vector);
  const rounded = { x: round2(parent.x), y: round2(parent.y) };
  if (rounded.x === 0 && rounded.y === 0) return null;
  return applyToVector(space.parentToLocal, rounded);
}

/** 親の座標系の点 (丸めない) を、ノードの座標系へ直す。 */
export function parentToLocal(space: PathSpace, parent: Point): Point {
  return applyToPoint(space.parentToLocal, parent);
}

/** ノードの座標系の点の、親の座標系での位置。 */
export function localToParent(space: PathSpace, local: Point): Point {
  return applyToPoint(space.localToParent, local);
}

// ---------------------------------------------------------------------------
// ページ座標の形
// ---------------------------------------------------------------------------

/** 点とハンドルの先のページ座標。 */
export interface PagePoint {
  ref: PointRef;
  at: Point;
  inTip: Point | null;
  outTip: Point | null;
}

export interface PageGeometry {
  node: PathNode;
  space: PathSpace;
  /** 輪郭ごとの点 */
  points: PagePoint[][];
}

export function pageGeometry(doc: CanvasDocument, id: NodeId): PageGeometry | null {
  const node = getNode(doc, id);
  if (node?.type !== "path") return null;
  const space = pathSpace(doc, node);
  if (!space) return null;
  const m = space.localToPage;
  const points = node.subpaths.map((sub, subpath) =>
    sub.points.map((p, index): PagePoint => {
      const at = applyToPoint(m, p);
      const tip = (h: Point | null) => (h ? applyToPoint(m, { x: p.x + h.x, y: p.y + h.y }) : null);
      return { ref: { subpath, index }, at, inTip: tip(p.in), outTip: tip(p.out) };
    }),
  );
  return { node, space, points };
}

export function pagePointOf(geometry: PageGeometry, ref: PointRef): PagePoint | null {
  return geometry.points[ref.subpath]?.[ref.index] ?? null;
}

/** 輪郭の中で、点 `index` の前と後の点の添字 (閉じた輪郭は回り込む。なければ null)。 */
export function neighbours(
  sub: Subpath,
  index: number,
): { prev: number | null; next: number | null } {
  const n = sub.points.length;
  if (n < 2) return { prev: null, next: null };
  const prev = index > 0 ? index - 1 : sub.closed ? n - 1 : null;
  const next = index < n - 1 ? index + 1 : sub.closed ? 0 : null;
  return { prev: prev === index ? null : prev, next: next === index ? null : next };
}

/** 重ね描きと当たりに出すハンドル。選んだ点のハンドルと、選んだ点へ向かう前後の点のハンドル。 */
export function visibleHandles(
  subpaths: readonly Subpath[],
  refs: readonly PointRef[],
): { ref: PointRef; side: HandleSide }[] {
  const seen = new Set<string>();
  const result: { ref: PointRef; side: HandleSide }[] = [];
  const add = (subpath: number, index: number, side: HandleSide) => {
    const point = subpaths[subpath]?.points[index];
    if (!point || !point[side]) return;
    const key = `${subpath}:${index}:${side}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ ref: { subpath, index }, side });
  };
  for (const ref of refs) {
    const sub = subpaths[ref.subpath];
    if (!sub) continue;
    add(ref.subpath, ref.index, "in");
    add(ref.subpath, ref.index, "out");
    const { prev, next } = neighbours(sub, ref.index);
    if (prev !== null) add(ref.subpath, prev, "out");
    if (next !== null) add(ref.subpath, next, "in");
  }
  return result;
}

// ---------------------------------------------------------------------------
// 当たり
// ---------------------------------------------------------------------------

/** 点の下の点 (いちばん近いもの)。 */
export function hitPoint(geometry: PageGeometry, page: Point, zoom: number): PointRef | null {
  const radius = POINT_HIT_RADIUS / zoom;
  let best: PointRef | null = null;
  let bestDistance = Infinity;
  for (const sub of geometry.points)
    for (const p of sub) {
      const d = Math.hypot(p.at.x - page.x, p.at.y - page.y);
      if (d <= radius && d < bestDistance) {
        best = p.ref;
        bestDistance = d;
      }
    }
  return best;
}

/** 点の下のハンドルの先 (`handles` のうち、いちばん近いもの)。 */
export function hitHandle(
  geometry: PageGeometry,
  handles: readonly { ref: PointRef; side: HandleSide }[],
  page: Point,
  zoom: number,
): { ref: PointRef; side: HandleSide } | null {
  const radius = HANDLE_HIT_RADIUS / zoom;
  let best: { ref: PointRef; side: HandleSide } | null = null;
  let bestDistance = Infinity;
  for (const handle of handles) {
    const p = pagePointOf(geometry, handle.ref);
    const tip = handle.side === "in" ? p?.inTip : p?.outTip;
    if (!tip) continue;
    const d = Math.hypot(tip.x - page.x, tip.y - page.y);
    if (d <= radius && d < bestDistance) {
      best = handle;
      bestDistance = d;
    }
  }
  return best;
}

export interface SegmentHit {
  subpath: number;
  /** `subpathToSegments` の添字 (点 i から点 i + 1、閉じる辺は n - 1) */
  segment: number;
  t: number;
}

/** 点の下の線分 (いちばん近いもの)。距離はノードの座標系で測る (回転と平行移動なので変わらない)。 */
export function hitSegment(geometry: PageGeometry, page: Point, zoom: number): SegmentHit | null {
  const limit = SEGMENT_HIT_DISTANCE / zoom;
  const local = applyToPoint(geometry.space.pageToLocal, page);
  let best: SegmentHit | null = null;
  let bestDistance = Infinity;
  geometry.node.subpaths.forEach((sub, subpath) => {
    subpathToSegments(sub).forEach((seg, segment) => {
      const near = nearestPoint(seg, local);
      if (near.distance <= limit && near.distance < bestDistance) {
        best = { subpath, segment, t: near.t };
        bestDistance = near.distance;
      }
    });
  });
  return best;
}

/** 線分の両端の点。 */
export function segmentEnds(subpaths: readonly Subpath[], hit: SegmentHit): PointRef[] {
  const n = subpaths[hit.subpath]?.points.length ?? 0;
  if (n < 2) return [];
  return [
    { subpath: hit.subpath, index: hit.segment },
    { subpath: hit.subpath, index: (hit.segment + 1) % n },
  ];
}

// ---------------------------------------------------------------------------
// 形の変更 (ノードの座標系)
// ---------------------------------------------------------------------------

/** `refs` の点だけを `change` で変える。ほかの点と輪郭は同じオブジェクトのまま。 */
export function mapPoints(
  subpaths: readonly Subpath[],
  refs: readonly PointRef[],
  change: (point: PathPoint, ref: PointRef) => PathPoint,
): Subpath[] {
  const bySubpath = new Map<number, Set<number>>();
  for (const ref of refs) {
    let set = bySubpath.get(ref.subpath);
    if (!set) bySubpath.set(ref.subpath, (set = new Set()));
    set.add(ref.index);
  }
  return subpaths.map((sub, subpath) => {
    const indices = bySubpath.get(subpath);
    if (!indices) return sub;
    let changed = false;
    const points = sub.points.map((point, index) => {
      if (!indices.has(index)) return point;
      const next = change(point, { subpath, index });
      if (next !== point) changed = true;
      return next;
    });
    return changed ? { closed: sub.closed, points } : sub;
  });
}

/**
 * 点を動かす (ハンドルは点からの相対なので一緒に動く)。`delta` はページ座標のずれ。
 * `round` が "position" なら動かした後の位置を、"delta" ならずれを、親の座標系で小数第 2 位に丸める
 * (ポインターで動かすときは位置、矢印キーはずれ)。ずれが 0 なら同じ並びを返す。
 */
export function movePoints(
  subpaths: readonly Subpath[],
  refs: readonly PointRef[],
  space: PathSpace,
  delta: Point,
  round: "position" | "delta",
): readonly Subpath[] {
  if (delta.x === 0 && delta.y === 0) return subpaths;
  const d = applyToVector(space.pageToParent, delta);
  const shift = round === "delta" ? { x: round2(d.x), y: round2(d.y) } : d;
  if (shift.x === 0 && shift.y === 0) return subpaths;
  return mapPoints(subpaths, refs, (point) => {
    const parent = localToParent(space, point);
    const moved = { x: parent.x + shift.x, y: parent.y + shift.y };
    const target = round === "position" ? { x: round2(moved.x), y: round2(moved.y) } : moved;
    const local = parentToLocal(space, target);
    return { ...point, x: local.x, y: local.y };
  });
}

/** 点を親の座標系の位置へ置く (プロパティパネル)。`axis` の成分だけを変える。 */
export function placePoints(
  subpaths: readonly Subpath[],
  refs: readonly PointRef[],
  space: PathSpace,
  axis: "x" | "y",
  value: number,
): Subpath[] {
  return mapPoints(subpaths, refs, (point) => {
    const parent = localToParent(space, point);
    if (parent[axis] === value) return point;
    const local = parentToLocal(space, { ...parent, [axis]: value });
    return { ...point, x: local.x, y: local.y };
  });
}

function negate(v: Point): Point {
  return { x: -v.x || 0, y: -v.y || 0 };
}

/**
 * ハンドルを変える (§8.7.3)。`vector` はノードの座標系の点からの相対 (null は点に重ねる)。
 * `mirror` が `angle` なら反対のハンドルの向きを、`angle-length` なら向きと長さをそろえる。
 * `breakLink` (Alt) は、その点の `mirror` を `none` にして反対のハンドルを変えない。
 */
export function setHandle(
  subpaths: readonly Subpath[],
  ref: PointRef,
  side: HandleSide,
  vector: Point | null,
  breakLink: boolean,
): Subpath[] {
  const otherSide: HandleSide = side === "in" ? "out" : "in";
  return mapPoints(subpaths, [ref], (point) => {
    let mirror: HandleMirror = breakLink ? "none" : point.mirror;
    let other = point[otherSide];
    if (!vector) mirror = "none";
    else if (mirror === "angle-length") other = negate(vector);
    else if (mirror === "angle" && other) {
      const length = Math.hypot(other.x, other.y);
      const own = Math.hypot(vector.x, vector.y);
      if (own > 0)
        other = { x: (-vector.x / own) * length || 0, y: (-vector.y / own) * length || 0 };
    }
    return { ...point, [side]: vector, [otherSide]: other, mirror } as PathPoint;
  });
}

/** 点からハンドルを引き出す (Cmd/Ctrl のドラッグ)。`out` は描く向きのハンドル。`in` はその反対。 */
export function pullHandles(
  subpaths: readonly Subpath[],
  ref: PointRef,
  out: Point | null,
): Subpath[] {
  return mapPoints(subpaths, [ref], (point) =>
    out
      ? { ...point, in: negate(out), out, mirror: "angle-length" }
      : { ...point, in: null, out: null, mirror: "none" },
  );
}

/**
 * 角と滑らかを切り替える (点のダブルクリック、§8.7.3)。ハンドルがあれば角 (ハンドルなし、`none`)、
 * なければ前後の点から求めたハンドル (`angle-length`) にする。向きは前の点から次の点へ、長さは前後の点
 * までの距離の 1/3 の平均。端の点は 1 つの隣だけから求める。求められなければ同じ並びを返す。
 */
export function toggleSmooth(subpaths: readonly Subpath[], ref: PointRef): readonly Subpath[] {
  const sub = subpaths[ref.subpath];
  const point = sub?.points[ref.index];
  if (!sub || !point) return subpaths;
  if (point.in || point.out) {
    return mapPoints(subpaths, [ref], (p) => ({ ...p, in: null, out: null, mirror: "none" }));
  }
  const { prev, next } = neighbours(sub, ref.index);
  const p0 = prev === null ? null : sub.points[prev]!;
  const p1 = next === null ? null : sub.points[next]!;
  let dir: Point | null = null;
  let length = 0;
  if (p0 && p1) {
    dir = { x: p1.x - p0.x, y: p1.y - p0.y };
    length =
      (Math.hypot(point.x - p0.x, point.y - p0.y) + Math.hypot(p1.x - point.x, p1.y - point.y)) / 6;
    if (Math.hypot(dir.x, dir.y) === 0) {
      // 前後の点が同じ場所: 前の点からの向きに直交させる
      dir = { x: -(point.y - p0.y), y: point.x - p0.x };
    }
  } else if (p1) {
    dir = { x: p1.x - point.x, y: p1.y - point.y };
    length = Math.hypot(dir.x, dir.y) / 3;
  } else if (p0) {
    dir = { x: point.x - p0.x, y: point.y - p0.y };
    length = Math.hypot(dir.x, dir.y) / 3;
  }
  const norm = dir ? Math.hypot(dir.x, dir.y) : 0;
  if (!dir || norm === 0 || length === 0) return subpaths;
  const out = { x: (dir.x / norm) * length, y: (dir.y / norm) * length };
  return pullHandles(subpaths, ref, out);
}

/**
 * 連動の種類を変える (プロパティパネル)。`angle` は `out` の向きを `in` の反対にそろえ (長さは保つ)、
 * `angle-length` は `out` を `in` の反対にする。片方しかなければ、もう片方をその反対で作る。
 */
export function setMirror(
  subpaths: readonly Subpath[],
  refs: readonly PointRef[],
  mirror: HandleMirror,
): Subpath[] {
  return mapPoints(subpaths, refs, (point) => {
    if (point.mirror === mirror) return point;
    if (mirror === "none") return { ...point, mirror };
    const base = point.in ?? (point.out ? negate(point.out) : null);
    if (!base) return { ...point, mirror };
    const inH = point.in ?? base;
    let out: Point;
    if (mirror === "angle-length" || !point.out) out = negate(inH);
    else {
      const length = Math.hypot(point.out.x, point.out.y);
      const own = Math.hypot(inH.x, inH.y);
      out = { x: (-inH.x / own) * length || 0, y: (-inH.y / own) * length || 0 };
    }
    return { ...point, in: inH, out, mirror };
  });
}

/**
 * 点を消して前後をつなぐ (§8.7.3)。点がなくなった輪郭は消す。点が 1 個になった輪郭は閉じない。
 * 輪郭がなくなれば空の並びを返す (呼び出し側がノードごと消す)。
 */
export function deletePoints(subpaths: readonly Subpath[], refs: readonly PointRef[]): Subpath[] {
  const bySubpath = new Map<number, Set<number>>();
  for (const ref of refs) {
    let set = bySubpath.get(ref.subpath);
    if (!set) bySubpath.set(ref.subpath, (set = new Set()));
    set.add(ref.index);
  }
  const result: Subpath[] = [];
  subpaths.forEach((sub, subpath) => {
    const indices = bySubpath.get(subpath);
    if (!indices) {
      result.push(sub);
      return;
    }
    const points = sub.points.filter((_, index) => !indices.has(index));
    if (points.length === 0) return;
    result.push({ closed: sub.closed && points.length >= 2, points });
  });
  return result;
}

/** 線分に点を足す (曲線の形を変えずに分ける)。足した点の参照も返す。 */
export function insertPoint(
  subpaths: readonly Subpath[],
  hit: SegmentHit,
): { subpaths: Subpath[]; ref: PointRef } | null {
  const sub = subpaths[hit.subpath];
  if (!sub) return null;
  const next = insertPointAt(sub, hit.segment, hit.t);
  if (next === sub) return null;
  const n = sub.points.length;
  // 閉じる辺 (最後の点から先頭の点) に足した点は最後に入る
  const index = sub.closed && hit.segment === n - 1 ? n : hit.segment + 1;
  const list = subpaths.slice();
  list[hit.subpath] = next;
  return { subpaths: list, ref: { subpath: hit.subpath, index } };
}

// ---------------------------------------------------------------------------
// 文書への反映と上限
// ---------------------------------------------------------------------------

/** 文書のすべてのパスの点の数。 */
export function totalPathPoints(doc: CanvasDocument): number {
  let total = 0;
  for (const node of Object.values(doc.nodes))
    if (node.type === "path") for (const sub of node.subpaths) total += sub.points.length;
  return total;
}

/**
 * パスが §3.5 と §8.3.2 の上限に収まっているか: 輪郭の数、点の数、点とハンドルの座標、箱。
 * `checkTotal` なら文書の全パスの点の合計も確かめる (点を足すとき)。
 */
export function pathWithinLimits(doc: CanvasDocument, id: NodeId, checkTotal: boolean): boolean {
  const node = getNode(doc, id);
  if (node?.type !== "path") return false;
  const { maxCoordinate, maxSubpaths, maxPathPoints, maxTotalPathPoints } = CANVAS_LIMITS;
  const coord = (v: number) => Number.isFinite(v) && Math.abs(v) <= maxCoordinate;
  const vector = (v: Point | null) => v === null || (coord(v.x) && coord(v.y));
  if (node.subpaths.length === 0 || node.subpaths.length > maxSubpaths) return false;
  let count = 0;
  for (const sub of node.subpaths) {
    if (sub.points.length === 0) return false;
    for (const p of sub.points) {
      count++;
      if (!coord(p.x) || !coord(p.y) || !vector(p.in) || !vector(p.out)) return false;
    }
  }
  if (count > maxPathPoints) return false;
  if (!geometryWithinLimits(doc, [id])) return false;
  return !checkTotal || totalPathPoints(doc) <= maxTotalPathPoints;
}

/**
 * パスの形を入れ替え、箱を合わせ直す (§8.6)。上限を超えるなら null。同じなら文書をそのまま返す。
 * 輪郭がなくなればノードごと消す。`checkTotal` は点を足すとき。
 */
export function withSubpaths(
  doc: CanvasDocument,
  id: NodeId,
  subpaths: readonly Subpath[],
  checkTotal = false,
): CanvasDocument | null {
  const node = getNode(doc, id);
  if (node?.type !== "path") return null;
  if (subpaths === node.subpaths) return doc;
  if (subpaths.length === 0) return deleteNodes(doc, [id]);
  const next = fitPathNodes(updateNode(doc, id, { subpaths: subpaths as Subpath[] }), [id]);
  if (next === doc) return doc;
  return pathWithinLimits(next, id, checkTotal) ? next : null;
}
