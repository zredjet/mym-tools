/**
 * ペン (§8.7.4) の純関数。描きかけの状態 (`PenDrawing`、`path/editSession.ts`) と文書から、今どこを描いているかを
 * 求め、点を足す・閉じる・最後の点を消す文書を作る。
 *
 * 描く向きと保存の順: 輪郭の最後の点の後へ足すとき (`end: "end"`) は描く向きと保存の順が同じ。先頭の点の前へ
 * 足すとき (`end: "start"`) は逆で、描く向きの `out` (ドラッグの向き) は保存の `in` になる。
 *
 * 新しいパスは 2 点目を置いたときに作る (点が 1 個のパスは文書に入れない。最初の点は `origin` に持つ)。
 * 点の編集の中で新しい輪郭を描くときも、2 点目で輪郭を足す。
 */
import { applyToPoint, applyToVector, invert } from "../../geometry/matrix";
import { parentMatrix } from "../../model/geometry";
import { createPath } from "../../model/create";
import { insertNode, parentExists } from "../../model/structure";
import { getNode } from "../../model/tree";
import type {
  CanvasDocument,
  NodeId,
  PathNode,
  PathPoint,
  Point,
  Subpath,
} from "../../model/types";
import type { PenDrawing, PenPoint } from "../../path/editSession";
import {
  pageToLocalRounded,
  pageVectorToLocalRounded,
  pathSpace,
  pathWithinLimits,
  round2,
  withSubpaths,
  type PathSpace,
} from "./ops";

export type PenTarget =
  /** 最初の点だけ (まだ文書にない) */
  | { kind: "pending"; origin: PenPoint }
  /** 文書の開いた輪郭の端に足していく */
  | { kind: "drawing"; node: PathNode; subpath: number; end: "start" | "end" };

/**
 * 描きかけの状態が今の文書のどこを指すか。Undo などで作ったパスや輪郭が消えたら、最初の点だけの状態に戻る。
 * 続けていた輪郭や編集中のパスが消えたか閉じたら null (描くのを終える)。
 */
export function resolvePen(doc: CanvasDocument, pen: PenDrawing): PenTarget | null {
  if (pen.pathId === null) {
    return pen.created === "path" && parentExists(doc, pen.parent)
      ? { kind: "pending", origin: pen.origin }
      : null;
  }
  const node = getNode(doc, pen.pathId);
  if (node?.type !== "path") {
    return pen.created === "path" && parentExists(doc, pen.parent)
      ? { kind: "pending", origin: pen.origin }
      : null;
  }
  const sub = node.subpaths[pen.subpath];
  if (!sub) return pen.created !== null ? { kind: "pending", origin: pen.origin } : null;
  if (sub.closed || sub.points.length === 0) return null;
  return { kind: "drawing", node, subpath: pen.subpath, end: pen.end };
}

/** 描いている輪郭の、伸ばす端の点の添字。 */
export function endIndex(sub: Subpath, end: "start" | "end"): number {
  return end === "end" ? sub.points.length - 1 : 0;
}

/** 描いている輪郭の、描き始めの点 (閉じる点) の添字。 */
export function startIndex(sub: Subpath, end: "start" | "end"): number {
  return end === "end" ? 0 : sub.points.length - 1;
}

/** 描く向きの `out` を、保存の順の `in` / `out` にする。 */
function storedHandles(
  out: Point | null,
  end: "start" | "end",
): Pick<PathPoint, "in" | "out" | "mirror"> {
  if (!out) return { in: null, out: null, mirror: "none" };
  const back = { x: -out.x || 0, y: -out.y || 0 };
  return end === "end"
    ? { in: back, out, mirror: "angle-length" }
    : { in: out, out: back, mirror: "angle-length" };
}

/** 点の描く向きの `out` ハンドル (ノードの座標系)。 */
export function drawingOut(point: PathPoint, end: "start" | "end"): Point | null {
  return end === "end" ? point.out : point.in;
}

/** 45° 刻みに固定したベクトル (ページの向き)。向きに射影した長さにする。 */
export function constrainVector45(v: Point): Point {
  const length = Math.hypot(v.x, v.y);
  if (length === 0) return v;
  const angle = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) * (Math.PI / 4);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const projected = v.x * ux + v.y * uy;
  // 0・±1 にそろえる (cos(π/2) が 6e-17 にならないように)
  const clean = (value: number) => (Math.abs(value) < 1e-12 ? 0 : value);
  return { x: clean(ux * projected), y: clean(uy * projected) };
}

/** `from` から見て 45° 刻みに固定した点。 */
export function constrainPoint45(from: Point, to: Point): Point {
  const v = constrainVector45({ x: to.x - from.x, y: to.y - from.y });
  return { x: from.x + v.x, y: from.y + v.y };
}

// ---------------------------------------------------------------------------
// 文書を作る
// ---------------------------------------------------------------------------

/** ページ座標の点 (と描く向きのハンドル) を、親の座標系で丸めた点にする (新しいパスの点)。 */
function parentPoint(
  toParent: ReturnType<typeof invert>,
  page: Point,
  out: Point | null,
  end: "start" | "end",
): PathPoint | null {
  if (!toParent) return null;
  const at = applyToPoint(toParent, page);
  let handle: Point | null = null;
  if (out) {
    const v = applyToVector(toParent, out);
    const r = { x: round2(v.x), y: round2(v.y) };
    handle = r.x === 0 && r.y === 0 ? null : r;
  }
  return { x: round2(at.x), y: round2(at.y), ...storedHandles(handle, end) };
}

/** ページ座標の点 (と描く向きのハンドル) を、パスの座標系の点にする (親の座標系で丸める)。 */
function localPoint(
  space: PathSpace,
  page: Point,
  out: Point | null,
  end: "start" | "end",
): PathPoint {
  const at = pageToLocalRounded(space, page);
  const handle = out ? pageVectorToLocalRounded(space, out) : null;
  return { x: at.x, y: at.y, ...storedHandles(handle, end) };
}

/**
 * 最初の点だけの状態から 2 点目を置く。新しいパス (`created: "path"`) なら `id` のパスを親に入れ、
 * 点の編集の中の新しい輪郭 (`created: "subpath"`) なら編集中のパスに輪郭を足す。入れられなければ null。
 */
export function penSecondPoint(
  doc: CanvasDocument,
  pen: PenDrawing,
  id: NodeId,
  page: Point,
  out: Point | null,
): CanvasDocument | null {
  const origin = pen.origin;
  if (pen.created === "subpath" && pen.pathId !== null) {
    const node = getNode(doc, pen.pathId);
    if (node?.type !== "path") return null;
    const space = pathSpace(doc, node);
    if (!space) return null;
    const sub: Subpath = {
      closed: false,
      points: [localPoint(space, origin, origin.out, "end"), localPoint(space, page, out, "end")],
    };
    return withSubpaths(doc, node.id, [...node.subpaths, sub], true);
  }
  const toParent = invert(parentMatrix(doc, pen.parent));
  const first = parentPoint(toParent, origin, origin.out, "end");
  const second = parentPoint(toParent, page, out, "end");
  if (!first || !second) return null;
  const node = createPath([{ closed: false, points: [first, second] }], { id });
  const next = insertNode(doc, node, pen.parent);
  if (next === doc || !pathWithinLimits(next, id, true)) return null;
  return next;
}

/** 描いている輪郭の端に点を足す。入れられなければ null。 */
export function penAddPoint(
  doc: CanvasDocument,
  target: Extract<PenTarget, { kind: "drawing" }>,
  page: Point,
  out: Point | null,
): CanvasDocument | null {
  const node = target.node;
  const sub = node.subpaths[target.subpath];
  const space = pathSpace(doc, node);
  if (!sub || !space) return null;
  const point = localPoint(space, page, out, target.end);
  const points = target.end === "end" ? [...sub.points, point] : [point, ...sub.points];
  const subpaths = node.subpaths.slice();
  subpaths[target.subpath] = { closed: false, points };
  return withSubpaths(doc, node.id, subpaths, true);
}

/**
 * 描いている輪郭を閉じる。`out` (ページ座標) があれば、描き始めの点を滑らかにして、描く向きのハンドルを
 * そのドラッグにする。
 */
export function penClose(
  doc: CanvasDocument,
  target: Extract<PenTarget, { kind: "drawing" }>,
  out: Point | null,
): CanvasDocument | null {
  const node = target.node;
  const sub = node.subpaths[target.subpath];
  const space = pathSpace(doc, node);
  if (!sub || !space || sub.points.length < 2) return null;
  const points = sub.points.slice();
  if (out) {
    const index = startIndex(sub, target.end);
    const handle = pageVectorToLocalRounded(space, out);
    // 閉じる辺から描き始めの点を通って最初の辺へ進む向きが、描く向きの out (= ドラッグの向き)
    points[index] = { ...points[index]!, ...storedHandles(handle, target.end) };
  }
  const subpaths = node.subpaths.slice();
  subpaths[target.subpath] = { closed: true, points };
  return withSubpaths(doc, node.id, subpaths);
}

export interface PenRemoval {
  doc: CanvasDocument;
  pen: PenDrawing | null;
}

/**
 * 描いている間の Backspace (§8.7.4): 最後に足した点を消す。
 * - この描画で作ったパス・輪郭が 2 点なら、パス (輪郭) を消し、残る点を最初の点だけの状態に戻す
 * - 続けている輪郭は、描き始めたときより後に足した点だけを消す。なければ描くのを終える (文書は変えない)
 * - 最初の点だけなら描くのを終える
 */
export function penRemoveLast(doc: CanvasDocument, pen: PenDrawing, target: PenTarget): PenRemoval {
  if (target.kind === "pending") return { doc, pen: null };
  const { node, subpath, end } = target;
  const sub = node.subpaths[subpath]!;
  const n = sub.points.length;
  if (pen.created !== null && n <= 2) {
    // 残る点 (描き始めの点) を最初の点だけの状態にする
    const space = pathSpace(doc, node);
    if (!space) return { doc, pen };
    const remaining = sub.points[startIndex(sub, end)]!;
    const out = drawingOut(remaining, end);
    const at = applyToPoint(space.localToPage, remaining);
    const origin: PenPoint = {
      x: at.x,
      y: at.y,
      out: out ? applyToVector(space.localToPage, out) : null,
    };
    let next: CanvasDocument | null;
    if (pen.created === "path") {
      next = withSubpaths(doc, node.id, []);
    } else {
      const subpaths = node.subpaths.filter((_, i) => i !== subpath);
      next = withSubpaths(doc, node.id, subpaths);
    }
    if (!next) return { doc, pen };
    return {
      doc: next,
      pen: {
        ...pen,
        pathId: pen.created === "path" ? null : pen.pathId,
        subpath: pen.created === "path" ? 0 : node.subpaths.length - 1,
        end: "end",
        origin,
      },
    };
  }
  if (pen.created === null && n <= pen.baseCount) return { doc, pen: null };
  const points = end === "end" ? sub.points.slice(0, -1) : sub.points.slice(1);
  const subpaths = node.subpaths.slice();
  subpaths[subpath] = { closed: false, points };
  const next = withSubpaths(doc, node.id, subpaths);
  return next ? { doc: next, pen } : { doc, pen };
}
