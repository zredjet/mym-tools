/**
 * プロパティパネルの変更 (純関数)。どれも変わらなければ引数の文書をそのまま返す。
 */
import { getLocalBounds, getPageBounds, isBoxNode, type BoxNode } from "../../model/geometry";
import { CANVAS_LIMITS } from "../../model/limits";
import { resizeNodes, translateNodes, updateNodes, type NodePatch } from "../../model/transform";
import { getNode, topLevelIds } from "../../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, Shadow, Stroke } from "../../model/types";
import { commonValue, type Mixed } from "../fields/values";
import { geometryWithinLimits } from "../limits";

export type BoundsField = "x" | "y" | "width" | "height";
export type LineField = "x1" | "y1" | "x2" | "y2";

/** 影を入にしたときの既定。 */
export const DEFAULT_SHADOW: Shadow = { x: 0, y: 4, blur: 8, color: "#000000", opacity: 0.25 };

/** 線を足したときの既定 (`createStroke` と同じ)。 */
export const DEFAULT_STROKE: Stroke = { color: "#000000", opacity: 1, width: 1 };

// ---------------------------------------------------------------------------
// 位置と大きさ
// ---------------------------------------------------------------------------

export type PositionValues =
  | { mode: "box"; values: Record<BoundsField, number | Mixed> }
  | { mode: "line"; values: Record<LineField, number | Mixed> };

/**
 * 位置と大きさの節に出す値。親の座標系で見る (frame の子は frame の左上が原点)。
 * 祖先も選ばれているノードは除く (祖先と一緒に動くため)。線だけを選んでいれば始点と終点。
 * group は外接矩形。選択が空なら null。
 */
export function readPosition(
  doc: CanvasDocument,
  selection: readonly NodeId[],
): PositionValues | null {
  const ids = topLevelIds(doc, selection);
  if (ids.length === 0) return null;
  const nodes = ids.map((id) => getNode(doc, id)).filter((n): n is CanvasNode => n !== undefined);
  const lines = nodes.filter((n) => n.type === "line");
  if (lines.length === nodes.length && lines.length > 0)
    return {
      mode: "line",
      values: {
        x1: commonValue(lines.map((n) => n.x1)),
        y1: commonValue(lines.map((n) => n.y1)),
        x2: commonValue(lines.map((n) => n.x2)),
        y2: commonValue(lines.map((n) => n.y2)),
      },
    };
  const bounds = ids.map((id) => getLocalBounds(doc, id)).filter((b) => b !== null);
  if (bounds.length === 0) return null;
  return {
    mode: "box",
    values: {
      x: commonValue(bounds.map((b) => b.x)),
      y: commonValue(bounds.map((b) => b.y)),
      width: commonValue(bounds.map((b) => b.width)),
      height: commonValue(bounds.map((b) => b.height)),
    },
  };
}

/**
 * X / Y / W / H を当てる。X と Y は外接矩形の左上がその値になるように動かし (`translateNodes`)、
 * W と H は左上を保って大きさを変える (`resizeNodes`、整数に丸める)。複数選択はそれぞれに当てる。
 * 結果が範囲の外へ出るなら変えない。
 */
export function setBoundsField(
  doc: CanvasDocument,
  selection: readonly NodeId[],
  field: BoundsField,
  value: number,
): CanvasDocument {
  const ids = topLevelIds(doc, selection);
  let next = doc;
  for (const id of ids) {
    if (field === "x" || field === "y") {
      const local = getLocalBounds(next, id);
      if (!local) continue;
      const delta = value - local[field];
      next = translateNodes(next, [id], field === "x" ? delta : 0, field === "y" ? delta : 0);
    } else {
      const from = getPageBounds(next, id);
      if (!from) continue;
      const node = getNode(next, id);
      if (from[field] === 0 && node && isBoxNode(node)) {
        // 大きさ 0 からは比例で広げられない (`resizeNodes` は倍率 1 にする) ので、値をそのまま当てる
        next = updateNodes(next, [id], zeroSizePatch(node, field, value));
        continue;
      }
      next = resizeNodes(next, [id], from, { ...from, [field]: value }, { round: true });
    }
  }
  return next !== doc && geometryWithinLimits(next, ids) ? next : doc;
}

/**
 * 大きさ 0 のノードに W / H を当てる変更。テキストは `resizeNodes` と同じ規則で大きさの決め方を変える
 * (縦に引いたら `fixed`、横だけなら `auto-width` を `auto-height` に。§4.6)。
 */
function zeroSizePatch(node: BoxNode, field: "width" | "height", value: number): NodePatch {
  const size = field === "width" ? { width: value } : { height: value };
  if (node.type !== "text") return size;
  const sizing =
    field === "height" ? "fixed" : node.sizing === "auto-width" ? "auto-height" : node.sizing;
  return { ...size, sizing };
}

/** 線の始点・終点の座標を当てる (選択の中の線だけ)。 */
export function setLineField(
  doc: CanvasDocument,
  selection: readonly NodeId[],
  field: LineField,
  value: number,
): CanvasDocument {
  if (Math.abs(value) > CANVAS_LIMITS.maxCoordinate) return doc;
  let changed = false;
  const nodes = { ...doc.nodes };
  for (const id of topLevelIds(doc, selection)) {
    const node = getNode(doc, id);
    if (node?.type !== "line" || node[field] === value) continue;
    nodes[id] = { ...node, [field]: value };
    changed = true;
  }
  return changed ? { ...doc, nodes } : doc;
}

// ---------------------------------------------------------------------------
// 種別ごとの対象
// ---------------------------------------------------------------------------

export type FillNode = Extract<CanvasNode, { fill: unknown }>;
export type StrokeNode = Extract<CanvasNode, { stroke: unknown }>;
export type ShadowNode = Extract<CanvasNode, { shadow: unknown }>;
export type RadiusNode = Extract<CanvasNode, { radius: number }>;

export const hasFill = (node: CanvasNode): node is FillNode => "fill" in node;
export const hasStroke = (node: CanvasNode): node is StrokeNode => "stroke" in node;
export const hasShadow = (node: CanvasNode): node is ShadowNode => "shadow" in node;
export const hasRadius = (node: CanvasNode): node is RadiusNode => "radius" in node;
