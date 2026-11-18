/**
 * 回転と反転のモデルの関数 (`docs/canvas-editor-design.md` §8.5.3、§8.5.6)。すべて純関数で、
 * 変わらなければ引数の文書をそのまま返す。
 *
 * E・G が使うもの (角度は度、時計回りが正。点はページ座標):
 * - `rotationCenter(doc, ids)`: 回転の中心。1 個の箱を持つノードなら箱の中心、それ以外は選択の外接矩形の中心
 * - `rotateNodes(doc, ids, angle, center)`: 選択を `center` のまわりに `angle` 回す。箱を持つノードは中心を回して
 *   `rotation` に足し、線は端点を回す。group とブーリアンは子に同じことをする。frame は frame だけを回す
 *   (子の値は変えない)。`rotation` は (-180, 180] にそろえて小数第 2 位で丸める。`x` `y` `width` `height` は
 *   丸めない。ドラッグの間は、開始時の文書に毎回当て直す
 * - `snapRotationDelta(delta, step?)`: 回した量を `step` (既定 15°) の倍数にする (複数選択の Shift)
 * - `snapRotationTo(current, delta, step?)`: 結果の角度が `step` の倍数になるよう、回す量を直す (1 個の Shift)
 * - `setNodesRotation(doc, ids, angle)`: 箱を持つノードを、それぞれ自分の中心のまわりに `angle` へそろえる
 *   (パネルの回転の欄。箱を持たないノードは変えない)
 * - `roundRotation(angle)`: (-180, 180] にそろえて小数第 2 位で丸める
 * - `canFlip(doc, ids)`: 反転できるか (テキスト・画像・埋め込み SVG・frame を子孫にも含まない、空でない選択)
 * - `flipNodes(doc, ids, axis)`: 選択の外接矩形の中心を通るページの縦 (`"horizontal"`、左右反転) か横
 *   (`"vertical"`、上下反転) の軸で映す。反転できない選択なら何もしない
 */
import {
  applyToPoint,
  invert,
  type Matrix,
  multiply,
  normalizeRotation,
  rotate,
} from "../geometry/matrix";
import { DocDraft } from "./draft";
import {
  boxCenter,
  coordinateMatrix,
  getSelectionBounds,
  isBoxNode,
  nodePageMatrix,
  pageRotation,
  parentPageRotation,
  rectCenter,
} from "./geometry";
import { cleanRotation, transformInDraft } from "./transform";
import { getDescendantIds, getNode, getParent, topLevelIds } from "./tree";
import type { CanvasDocument, CanvasNode, NodeId, Paint, PathPoint, Point, Shadow } from "./types";

/** Shift の回転の刻み (度)。 */
export const ROTATION_SNAP_STEP = 15;

/** (-180, 180] にそろえて小数第 2 位で丸める (§8.5.3)。 */
export function roundRotation(angle: number): number {
  const r = Math.round(normalizeRotation(angle) * 100) / 100;
  const n = r <= -180 ? r + 360 : r;
  return n === 0 ? 0 : n;
}

/** 回転の中心 (ページ座標)。1 個の箱を持つノードなら箱の中心、それ以外は選択の外接矩形の中心。 */
export function rotationCenter(doc: CanvasDocument, ids: readonly NodeId[]): Point | null {
  const tops = topLevelIds(doc, ids);
  const only = tops.length === 1 ? getNode(doc, tops[0] as NodeId) : undefined;
  if (only && isBoxNode(only))
    return applyToPoint(nodePageMatrix(doc, only.id), { x: only.width / 2, y: only.height / 2 });
  const bounds = getSelectionBounds(doc, tops);
  return bounds ? rectCenter(bounds) : null;
}

/** 回した量を `step` の倍数にする。 */
export function snapRotationDelta(delta: number, step = ROTATION_SNAP_STEP): number {
  const snapped = Math.round(delta / step) * step;
  return snapped === 0 ? 0 : snapped;
}

/** 結果の角度 (`current + delta`) が `step` の倍数になるよう、回す量を直す。 */
export function snapRotationTo(current: number, delta: number, step = ROTATION_SNAP_STEP): number {
  const target = Math.round((current + delta) / step) * step;
  const result = target - current;
  return result === 0 ? 0 : result;
}

/** 回転の値を丸める (`transformInDraft` が足した値を、操作の規則で書き直す)。 */
function roundRotationInDraft(draft: DocDraft, id: NodeId): void {
  const node = draft.get(id);
  if (!node) return;
  if (node.type === "group" || node.type === "boolean") {
    for (const child of node.children) roundRotationInDraft(draft, child);
    return;
  }
  if (!isBoxNode(node)) return;
  const rotation = roundRotation(node.rotation);
  if (rotation !== node.rotation) draft.set({ ...node, rotation });
}

/**
 * 選択を `center` (ページ座標) のまわりに `angle` 度回す (§8.5.3)。祖先も選ばれているノードは祖先と一緒に回る。
 * 回転した frame の中のノードも、ページ上で同じ角度だけ回る (frame は回転と平行移動だけなので、親の座標系でも
 * 同じ角度)。`angle` が 0 なら文書をそのまま返す。
 */
export function rotateNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  angle: number,
  center: Point,
): CanvasDocument {
  if (angle === 0 || !Number.isFinite(angle)) return doc;
  const draft = new DocDraft(doc);
  for (const id of topLevelIds(doc, ids)) {
    const space = coordinateMatrix(doc, id);
    const back = invert(space);
    if (!back) continue;
    const c = applyToPoint(back, center);
    transformInDraft(draft, id, rotate(angle, c.x, c.y));
    roundRotationInDraft(draft, id);
  }
  return draft.finish();
}

/**
 * 箱を持つノードを、それぞれ自分の中心のまわりに `angle` (自分の `rotation` の値) へそろえる (§8.5.5 の
 * 回転の欄)。回転は箱の中心のまわりなので、`x` `y` `width` `height` は変わらない。箱を持たないノードは変えない。
 */
export function setNodesRotation(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  angle: number,
): CanvasDocument {
  if (!Number.isFinite(angle)) return doc;
  const rotation = roundRotation(angle);
  const draft = new DocDraft(doc);
  for (const id of topLevelIds(doc, ids)) {
    const node = draft.get(id);
    if (!node || !isBoxNode(node) || node.rotation === rotation) continue;
    draft.set({ ...node, rotation });
  }
  return draft.finish();
}

// ---------------------------------------------------------------------------
// 反転
// ---------------------------------------------------------------------------

export type FlipAxis = "horizontal" | "vertical";

/** 鏡像を表せない種類 (§8.5.6)。 */
function cannotMirror(node: CanvasNode | undefined): boolean {
  return (
    node === undefined ||
    node.type === "text" ||
    node.type === "image" ||
    node.type === "svg" ||
    node.type === "frame"
  );
}

/** 反転できるか。テキスト・画像・埋め込み SVG・frame を (子孫に) 含む選択と、空の選択はできない。 */
export function canFlip(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  const tops = topLevelIds(doc, ids);
  if (tops.length === 0) return false;
  return tops.every(
    (id) =>
      !cannotMirror(getNode(doc, id)) &&
      getDescendantIds(doc, id).every((child) => !cannotMirror(getNode(doc, child))),
  );
}

/** 塗りのグラデーションを、正規化した座標の `axis` の成分で映す (1 − 値)。単色はそのまま。 */
function flipPaint(paint: Paint | null, axis: "x" | "y"): Paint | null {
  if (!paint || paint.type === "solid") return paint;
  const flip = (p: Point): Point =>
    axis === "x" ? { x: 1 - p.x, y: p.y } : { x: p.x, y: 1 - p.y };
  if (paint.type === "linear") return { ...paint, from: flip(paint.from), to: flip(paint.to) };
  return { ...paint, center: flip(paint.center) };
}

/** 影のずれの `axis` の成分の符号を変える。 */
function flipShadow(shadow: Shadow | null, axis: "x" | "y"): Shadow | null {
  if (!shadow) return shadow;
  const value = -shadow[axis];
  return { ...shadow, [axis]: value === 0 ? 0 : value };
}

/** パスの点とハンドルを、自分の座標系で `axis` の向きに映す (x → width − x、ハンドルは符号を変える)。 */
function flipPoint(pt: PathPoint, axis: "x" | "y", size: number): PathPoint {
  const neg = (v: number) => (v === 0 ? 0 : -v);
  const handle = (h: Point | null) =>
    h ? (axis === "x" ? { x: neg(h.x), y: h.y } : { x: h.x, y: neg(h.y) }) : null;
  const x = axis === "x" ? size - pt.x : pt.x;
  const y = axis === "y" ? size - pt.y : pt.y;
  return { ...pt, x: x === 0 ? 0 : x, y: y === 0 ? 0 : y, in: handle(pt.in), out: handle(pt.out) };
}

/** ページの軸の反転を、ページ上の角度 α の座標系で近い方の軸 (x / y) に直す (ブーリアンの塗りと影)。 */
function nearestAxis(pageAxis: "x" | "y", alpha: number): "x" | "y" {
  const r = (alpha * Math.PI) / 180;
  const alongX = Math.abs(Math.cos(r)) >= Math.abs(Math.sin(r));
  if (alongX) return pageAxis;
  return pageAxis === "x" ? "y" : "x";
}

/**
 * 下書きの中でノードを映す。`mirror` はページ座標の反転の行列、`space` はページ ← ノードの親の座標系。
 * `pageAxis` は映すページの軸の成分 (左右反転なら x)。
 */
function flipInDraft(
  doc: CanvasDocument,
  draft: DocDraft,
  id: NodeId,
  mirror: Matrix,
  space: Matrix,
  pageAxis: "x" | "y",
): void {
  const node = draft.get(id);
  if (!node) return;
  const back = invert(space);
  if (!back) return;
  // 親の座標系の反転 (ページの反転を親の座標系へ写したもの)
  const local = multiply(back, multiply(mirror, space));
  switch (node.type) {
    case "group":
      for (const child of node.children) flipInDraft(doc, draft, child, mirror, space, pageAxis);
      return;
    case "boolean": {
      for (const child of node.children) flipInDraft(doc, draft, child, mirror, space, pageAxis);
      // ブーリアンの塗りと影は親の座標系の向き。祖先の frame の角度が 90° の倍数でなければ近似 (§8.5.6)
      const parent = getParent(doc, id);
      const axis = nearestAxis(pageAxis, parent ? parentPageRotation(doc, parent) : 0);
      draft.set({
        ...node,
        fill: flipPaint(node.fill, axis),
        shadow: flipShadow(node.shadow, axis),
      });
      return;
    }
    case "line": {
      const a = applyToPoint(local, { x: node.x1, y: node.y1 });
      const b = applyToPoint(local, { x: node.x2, y: node.y2 });
      draft.set({ ...node, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      return;
    }
    case "rect":
    case "ellipse":
    case "path": {
      // ページ上の角度 φ は −φ になり、自分の座標系では同じ向き (左右なら x) に映す (§8.5.6)
      const phi = pageRotation(doc, id);
      const parent = getParent(doc, id);
      const alpha = parent ? parentPageRotation(doc, parent) : 0;
      const c = applyToPoint(local, boxCenter(node));
      const rotation = cleanRotation(-phi - alpha);
      const base = {
        x: c.x - node.width / 2,
        y: c.y - node.height / 2,
        rotation,
        fill: flipPaint(node.fill, pageAxis),
        shadow: flipShadow(node.shadow, pageAxis),
      };
      const pos = { x: base.x === 0 ? 0 : base.x, y: base.y === 0 ? 0 : base.y };
      if (node.type === "path") {
        const size = pageAxis === "x" ? node.width : node.height;
        draft.set({
          ...node,
          ...base,
          ...pos,
          subpaths: node.subpaths.map((sub) => ({
            ...sub,
            points: sub.points.map((pt) => flipPoint(pt, pageAxis, size)),
          })),
        });
      } else draft.set({ ...node, ...base, ...pos });
      return;
    }
    default:
      return;
  }
}

/**
 * 選択を、選択の外接矩形の中心を通るページの縦 (`"horizontal"`、左右反転) か横 (`"vertical"`、上下反転) の
 * 軸で映す (§8.5.6)。反転できない選択 (`canFlip` が false) なら何もしない。位置は丸めない。
 */
export function flipNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  axis: FlipAxis,
): CanvasDocument {
  if (!canFlip(doc, ids)) return doc;
  const tops = topLevelIds(doc, ids);
  const bounds = getSelectionBounds(doc, tops);
  if (!bounds) return doc;
  const center = rectCenter(bounds);
  const pageAxis = axis === "horizontal" ? "x" : "y";
  const mirror: Matrix =
    axis === "horizontal"
      ? { a: -1, b: 0, c: 0, d: 1, e: 2 * center.x, f: 0 }
      : { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * center.y };
  const draft = new DocDraft(doc);
  for (const id of tops) {
    flipInDraft(doc, draft, id, mirror, coordinateMatrix(doc, id), pageAxis);
  }
  return draft.finish();
}
