/**
 * 線のアウトライン化の操作のモデル (`docs/canvas-editor-design.md` §4.16)。純関数で、引数の文書は変えない。
 *
 * - `outlineTargets(doc, ids)`: 当てるノード (祖先も選ばれているノードを除き、重なり順)。対象は線のある矩形・
 *   楕円・線・パス・ブーリアン。線のないノードとブーリアンの子 (子の線は描かない。§4.15.1) は飛ばす。ほかの
 *   種類を含む選択では効かない
 * - `outlineNodes(doc, ids, newId)`: 当てた文書と、選び直す ID。当てられなければ理由
 *
 * 結果 (ノードごと):
 * - 線の面: 線の見た目どおりの塗りの面のパス (`outlineStroke`)。塗りは線の色と不透明度の単色、線はなし。
 *   回転は点に焼き込む (回転 0)
 * - 塗りのないノード: 線の面のパス 1 つ。元のノードの ID・名前・表示・ロック・不透明度・影を引き継ぐ。影の
 *   ずれは、焼き込んだ回転の分だけ回す (ページの上の影の向きを変えない)
 * - 塗りもあるノード: 塗りの形 (線なしのパス。パスに変換と同じ形で、箱を持つノードは回転も同じ) と線の面を、
 *   元のノードの ID・名前・表示・ロック・不透明度の group にまとめる (塗りが背面)。影は塗りの形に付ける
 *   (塗りの形は回転を保つので、影の向きも変わらない)。**既知の近似**: group は影を持てないので、元の影 (塗りと
 *   線を合わせた形の影) のうち、線の外側の半分の影がなくなる。塗りの不透明度が低いと影もほとんど見えなくなる
 *   (影は塗りの形の不透明度から作られるため)。線の面にも付けると、線の影が塗りの上に落ちる。子の名前は「塗り」「線」
 * - 結果は元のノードの位置 (親と重なり順) に置く。ブーリアンは子ごと置き換える
 * - 複数のノードに当てるときは、まとめて 1 つの文書にする (履歴 1 件)。線が何も描かれないノード (長さ 0 の
 *   butt の線など) は飛ばして残りに当て、当てるものが 1 つもなければ断る。ほかの理由で当てられないノードが
 *   あれば、どれも当てない
 *
 * 線の中心線 (§4.12 の始点と向き): 矩形・楕円は描画 (`<rect rx>` と `<ellipse>`) との差が許容値の 1/8 以内に
 * なるよう、円弧を必要なだけ細かい 3 次ベジェにする (始点と向きは §4.12 の形と同じ)。線は始点から終点。
 * パスは点の形。ブーリアンは結果の形 (`getBooleanResult`)。
 *
 * 当てないとき: 結果が §3.5 の上限 (座標、大きさ、輪郭・点の数、ノードの数、入れ子の深さ) を超える、
 * 線の形を求められない、ブーリアンの結果が求められない、線が何も描かれていない。
 */
import { getBooleanResult } from "../boolean/result";
import type { Segment } from "../geometry/bezier";
import { cosSinDeg, nodeMatrix } from "../geometry/matrix";
import { createGroup, createPath, solidPaint } from "../model/create";
import { DocDraft } from "../model/draft";
import { CANVAS_LIMITS } from "../model/limits";
import { getDepth, getNode, getParentNode, topLevelIds } from "../model/tree";
import type {
  CanvasDocument,
  CanvasNode,
  NodeId,
  PathNode,
  Shadow,
  Stroke,
  Subpath,
} from "../model/types";
import { geometryWithinLimits, pathPointsWithinLimits } from "../panels/limits";
import { fitPathNode } from "../path/fit";
import { segmentsToSubpath } from "../path/segments";
import { ellipseSubpaths, lineSubpaths, rectSubpaths } from "../path/shapes";
import { transformSubpaths } from "../path/transform";
import { arcSegments } from "./contour";
import { outlineTolerance, strokeOutline } from "./index";

export type OutlinableNode = Extract<
  CanvasNode,
  { type: "rect" | "ellipse" | "line" | "path" | "boolean" }
>;

export type OutlineFailure =
  | "unsupported"
  | "noStroke"
  | "booleanChild"
  | "booleanFailed"
  | "failed"
  | "tooComplex"
  | "empty"
  | "limits";

/** 当てなかった理由の文 (画面に出す)。 */
export const OUTLINE_FAILURE_MESSAGES: Readonly<Record<OutlineFailure, string>> = {
  unsupported: "線のアウトライン化ができるのは矩形・楕円・線・パス・ブーリアンだけです。",
  noStroke: "線がないため、アウトライン化できません。線のあるノードを選んでください。",
  booleanChild: "ブーリアンの子の線は描かれないため、アウトライン化できません。",
  booleanFailed: "ブーリアンの結果を求められないため、線をアウトライン化できません。",
  failed: "線の形を求められないため、アウトライン化できません。",
  tooComplex:
    "線の形が細かすぎる (破線の数が多いなど) ため、アウトライン化できません。破線の間隔を広げてください。",
  empty: "描かれている線がない (長さ 0 の線など) ため、アウトライン化できません。",
  limits:
    "結果が座標・大きさ・パスの点の数・ノードの数・入れ子の深さの上限を超えるため、アウトライン化できません。",
};

/** 塗りの形と線の面の名前 (group の子)。 */
export const OUTLINE_PART_NAMES = { fill: "塗り", stroke: "線" } as const;

export type OutlineTargets =
  | { ok: true; nodes: OutlinableNode[] }
  | { ok: false; reason: OutlineFailure };

export type OutlineOutcome =
  | { ok: true; doc: CanvasDocument; ids: NodeId[] }
  | { ok: false; reason: OutlineFailure };

export function isOutlinable(node: CanvasNode): node is OutlinableNode {
  return (
    node.type === "rect" ||
    node.type === "ellipse" ||
    node.type === "line" ||
    node.type === "path" ||
    node.type === "boolean"
  );
}

/** ブーリアンの子か (子の線は描かないので、アウトライン化しない。§4.15.1)。 */
export function isBooleanChild(doc: CanvasDocument, id: NodeId): boolean {
  return getParentNode(doc, id)?.type === "boolean";
}

/** 当てるノード (重なり順)。当てるものがなければ理由。 */
export function outlineTargets(doc: CanvasDocument, ids: readonly NodeId[]): OutlineTargets {
  const tops = topLevelIds(doc, ids);
  if (tops.length === 0) return { ok: false, reason: "unsupported" };
  const nodes: OutlinableNode[] = [];
  let strokedBooleanChild = false;
  for (const id of tops) {
    const node = getNode(doc, id);
    if (!node || !isOutlinable(node)) return { ok: false, reason: "unsupported" };
    if (node.stroke === null) continue;
    if (isBooleanChild(doc, id)) {
      strokedBooleanChild = true;
      continue;
    }
    nodes.push(node);
  }
  if (nodes.length === 0)
    return { ok: false, reason: strokedBooleanChild ? "booleanChild" : "noStroke" };
  return { ok: true, nodes };
}

// ---------------------------------------------------------------------------
// 中心線
// ---------------------------------------------------------------------------

/**
 * 1/4 の円弧を何本の 3 次ベジェに分けるか。90° の 1 本の半径の誤差は半径の 2.7e-4 で、角度の 6 乗に比例する。
 * 誤差が `tolerance` 以内になる本数 (2 の累乗、16 まで)。
 */
function arcPieces(radius: number, tolerance: number): number {
  let n = 1;
  while (n < 16 && radius * 2.7e-4 * Math.pow(1 / n, 6) > tolerance) n *= 2;
  return n;
}

/**
 * 矩形の中心線。角丸は描画 (`<rect rx>` の楕円の角) との差が `tolerance` 以内になるよう細かく分ける。
 * 始点と向きは §4.12 (`rectSubpaths`) と同じ: (rx, 0) から時計回り。
 */
export function rectCenterline(
  width: number,
  height: number,
  radius: number,
  tolerance: number,
): Subpath[] {
  const plain = rectSubpaths(width, height, radius);
  const rx = Math.min(Math.max(0, radius), width / 2);
  const ry = Math.min(Math.max(0, radius), height / 2);
  if (plain.length === 0 || rx === 0 || ry === 0) return plain;
  const n = arcPieces(Math.max(rx, ry), tolerance);
  if (n === 1) return plain;
  const corner = (cx: number, cy: number, from: number): Segment[] =>
    ellipseArc(cx, cy, rx, ry, from, n);
  const line = (x0: number, y0: number, x1: number, y1: number): Segment[] =>
    x0 === x1 && y0 === y1 ? [] : [{ kind: "line", from: { x: x0, y: y0 }, to: { x: x1, y: y1 } }];
  const w = width;
  const h = height;
  const segs: Segment[] = [
    ...line(rx, 0, w - rx, 0),
    ...corner(w - rx, ry, -Math.PI / 2),
    ...line(w, ry, w, h - ry),
    ...corner(w - rx, h - ry, 0),
    ...line(w - rx, h, rx, h),
    ...corner(rx, h - ry, Math.PI / 2),
    ...line(0, h - ry, 0, ry),
    ...corner(rx, ry, Math.PI),
  ];
  return [segmentsToSubpath(segs, true)];
}

/** 中心 (cx, cy)、半径 (rx, ry) の楕円の 1/4 (角度 `from` から時計回りに 90°) を `n` 本に分けた 3 次ベジェ。 */
function ellipseArc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  n: number,
): Segment[] {
  const pieces: Segment[] = [];
  const step = Math.PI / 2 / n;
  for (let i = 0; i < n; i++) {
    const a = from + step * i;
    pieces.push(...arcSegments({ x: 0, y: 0 }, 1, { x: Math.cos(a), y: Math.sin(a) }, step));
  }
  const map = (p: { x: number; y: number }) => ({ x: cx + rx * p.x, y: cy + ry * p.y });
  return pieces.map((s) =>
    s.kind === "line"
      ? { kind: "line", from: map(s.from), to: map(s.to) }
      : { kind: "cubic", from: map(s.from), c1: map(s.c1), c2: map(s.c2), to: map(s.to) },
  );
}

/**
 * 楕円の中心線。描画 (`<ellipse>`) との差が `tolerance` 以内になるよう細かく分ける。始点と向きは §4.12
 * (`ellipseSubpaths`) と同じ: (cx + rx, cy) から時計回り。
 */
export function ellipseCenterline(width: number, height: number, tolerance: number): Subpath[] {
  const plain = ellipseSubpaths(width, height);
  if (plain.length === 0) return plain;
  const rx = width / 2;
  const ry = height / 2;
  const n = arcPieces(Math.max(rx, ry), tolerance);
  if (n === 1) return plain;
  const segs: Segment[] = [];
  for (let q = 0; q < 4; q++) segs.push(...ellipseArc(rx, ry, rx, ry, (q * Math.PI) / 2, n));
  return [segmentsToSubpath(segs, true)];
}

/** 線の中心線 (親の座標系、回転を焼き込む)。ブーリアンの結果が求められなければ null。 */
export function strokeCenterline(
  doc: CanvasDocument,
  node: OutlinableNode,
  tolerance: number,
): Subpath[] | null {
  switch (node.type) {
    case "rect":
    case "ellipse":
    case "path": {
      const local =
        node.type === "rect"
          ? rectCenterline(node.width, node.height, node.radius, tolerance)
          : node.type === "ellipse"
            ? ellipseCenterline(node.width, node.height, tolerance)
            : node.subpaths;
      return transformSubpaths(
        local,
        nodeMatrix(node.x, node.y, node.width, node.height, node.rotation),
      );
    }
    case "line":
      return lineSubpaths({ x: node.x1, y: node.y1 }, { x: node.x2, y: node.y2 });
    case "boolean":
      return getBooleanResult(doc, node.id)?.subpaths ?? null;
  }
}

// ---------------------------------------------------------------------------
// 結果のノード
// ---------------------------------------------------------------------------

/** 塗りの形 (線なしのパス)。パスに変換と同じ形。塗りがない・形がなければ null。 */
function fillPart(doc: CanvasDocument, node: OutlinableNode, id: NodeId): PathNode | null {
  if (node.type === "line" || node.fill === null) return null;
  const common = {
    id,
    name: OUTLINE_PART_NAMES.fill,
    visible: true,
    locked: false,
    opacity: 1,
    fill: node.fill,
    stroke: null,
    shadow: node.shadow,
  };
  switch (node.type) {
    case "rect":
    case "ellipse": {
      const subpaths =
        node.type === "rect"
          ? rectSubpaths(node.width, node.height, node.radius)
          : ellipseSubpaths(node.width, node.height);
      if (subpaths.length === 0) return null;
      return fitPathNode({
        ...common,
        type: "path",
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        subpaths,
        fillRule: "nonzero",
      });
    }
    case "path":
      return { ...node, ...common };
    case "boolean": {
      const result = getBooleanResult(doc, node.id);
      if (!result || result.subpaths.length === 0) return null;
      return createPath(result.subpaths, { ...common, fillRule: "nonzero" });
    }
  }
}

/**
 * 線の面に付ける影。影のずれはノードの座標系の向きにある (§4.3) ので、線の面に焼き込んだ回転の分だけ回す
 * (線の面の回転は 0。祖先の frame の回転はそのまま掛かる)。
 */
function bakedShadow(node: OutlinableNode): Shadow | null {
  if (node.type === "line" || node.shadow === null) return null;
  const rotation = node.type === "boolean" ? 0 : node.rotation;
  if (rotation === 0) return node.shadow;
  const { cos, sin } = cosSinDeg(rotation);
  const { x, y } = node.shadow;
  return { ...node.shadow, x: x * cos - y * sin, y: x * sin + y * cos };
}

/** 線の面のパス。 */
function strokePart(
  subpaths: readonly Subpath[],
  stroke: Stroke,
  init: Pick<PathNode, "id" | "name" | "visible" | "locked" | "opacity" | "shadow">,
): PathNode {
  return createPath(subpaths, {
    ...init,
    fill: solidPaint(stroke.color, stroke.opacity),
    stroke: null,
    fillRule: "nonzero",
  });
}

/**
 * 選んだノードの線をアウトライン化する (§4.16)。`newId` は新しいノード (group の子) の ID を作る関数
 * (呼ぶたびに別の ID)。当てられなければ理由を返す (文書は変えない)。
 */
export function outlineNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  newId: () => NodeId,
): OutlineOutcome {
  const targets = outlineTargets(doc, ids);
  if (!targets.ok) return targets;
  const draft = new DocDraft(doc);
  const results: NodeId[] = [];
  let groups = 0;
  for (const node of targets.nodes) {
    const stroke = node.stroke as Stroke;
    const tolerance = outlineTolerance(stroke.width);
    const centerline = strokeCenterline(doc, node, tolerance / 8);
    if (centerline === null) return { ok: false, reason: "booleanFailed" };
    const outline = strokeOutline(centerline, stroke, { tolerance });
    if (!outline.ok) return { ok: false, reason: outline.reason };
    // 線が何も描かれないノード (長さ 0 の butt の線など) は飛ばし、そのままにする
    if (outline.subpaths.length === 0) continue;
    const fill = fillPart(doc, node, newId());
    if (node.type === "boolean") for (const child of node.children) draft.removeSubtree(child);
    if (fill === null) {
      draft.set(
        strokePart(outline.subpaths, stroke, {
          id: node.id,
          name: node.name,
          visible: node.visible,
          locked: node.locked,
          opacity: node.opacity,
          shadow: node.type === "line" ? null : bakedShadow(node),
        }),
      );
    } else {
      const face = strokePart(outline.subpaths, stroke, {
        id: newId(),
        name: OUTLINE_PART_NAMES.stroke,
        visible: true,
        locked: false,
        opacity: 1,
        shadow: null,
      });
      if (getDepth(doc, node.id) + 1 > CANVAS_LIMITS.maxDepth)
        return { ok: false, reason: "limits" };
      draft.set(fill);
      draft.set(face);
      draft.set(
        createGroup([fill.id, face.id], {
          id: node.id,
          name: node.name,
          visible: node.visible,
          locked: node.locked,
          opacity: node.opacity,
        }),
      );
      groups++;
    }
    results.push(node.id);
  }
  if (results.length === 0) return { ok: false, reason: "empty" };
  const next = draft.finish();
  if (groups > 0 && Object.keys(next.nodes).length > CANVAS_LIMITS.maxNodes)
    return { ok: false, reason: "limits" };
  if (!geometryWithinLimits(next, results) || !pathPointsWithinLimits(next, results))
    return { ok: false, reason: "limits" };
  return { ok: true, doc: next, ids: results };
}
