/**
 * プロパティパネルの変更 (純関数)。どれも変わらなければ引数の文書をそのまま返す。
 *
 * 位置と大きさ (§8.5.5、G がパネルの欄から呼ぶ):
 * - `readPosition(doc, selection)`: 1 個の箱を持つノードは W / H が回転の前の大きさ、X / Y が回転した箱の左上の角
 *   (ノードの座標系の原点を親の座標系へ写した点)。複数選択・group・ブーリアンは軸に平行な外接矩形、線は始点と終点
 * - `setBoundsField(doc, selection, field, value)`: 1 個の回転した箱を持つノードは、X / Y でその角を入力した位置へ
 *   動かし、W / H は左上の角を動かさずに自分の向きでリサイズする (§8.5.4。大きさは整数に丸める)
 * - `readRotation(doc, selection)`: 回転の欄の値。箱を持つノードだけの選択なら、全部同じ値ならその値、違えば
 *   `MIXED`。箱を持たないノードを含むか、空なら null (欄を出さない)
 * - `setRotationField(doc, selection, value)`: 各ノードを自分の中心のまわりに、入力した角度へそろえる
 */
import { applyToPoint } from "../../geometry/matrix";
import {
  getLocalBounds,
  getPageBounds,
  isBoxNode,
  nodeTransform,
  type BoxNode,
} from "../../model/geometry";
import { CANVAS_LIMITS } from "../../model/limits";
import { setNodesRotation } from "../../model/rotate";
import {
  resizeNodeInOwnFrame,
  resizeNodes,
  translateNodes,
  updateNodes,
  type NodePatch,
} from "../../model/transform";
import { getNode, topLevelIds } from "../../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, Shadow, Stroke } from "../../model/types";
import { canvasTextMeasurer } from "../../render/measureText";
import type { TextMeasurer } from "../../render/types";
import { fitTextNodes } from "../../text/fit";
import { commonValue, MIXED, type Mixed } from "../fields/values";
import { geometryWithinLimits } from "../limits";

export type BoundsField = "x" | "y" | "width" | "height";
export type LineField = "x1" | "y1" | "x2" | "y2";

/** 影を入にしたときの既定。 */
export const DEFAULT_SHADOW: Shadow = { x: 0, y: 4, blur: 8, color: "#000000", opacity: 0.25 };

/** 線を足したときの既定 (`createStroke` と同じ)。 */
export const DEFAULT_STROKE: Stroke = {
  color: "#000000",
  opacity: 1,
  width: 1,
  cap: "butt",
  join: "miter",
  dash: [],
};

// ---------------------------------------------------------------------------
// 位置と大きさ
// ---------------------------------------------------------------------------

export type PositionValues =
  | { mode: "box"; values: Record<BoundsField, number | Mixed> }
  | { mode: "line"; values: Record<LineField, number | Mixed> };

/** 1 個だけ選んだ、回転した箱を持つノード (§8.5.5 の欄の意味が変わるもの)。なければ null。 */
function singleRotatedBox(doc: CanvasDocument, ids: readonly NodeId[]): BoxNode | null {
  if (ids.length !== 1) return null;
  const node = getNode(doc, ids[0] as NodeId);
  return node && isBoxNode(node) && node.rotation !== 0 ? node : null;
}

/** 回転した箱の左上の角 (ノードの座標系の原点を親の座標系へ写した点)。 */
function boxCorner(node: BoxNode): { x: number; y: number } {
  return applyToPoint(nodeTransform(node), { x: 0, y: 0 });
}

/**
 * 位置と大きさの節に出す値。親の座標系で見る (frame の子は frame の左上が原点)。
 * 祖先も選ばれているノードは除く (祖先と一緒に動くため)。線だけを選んでいれば始点と終点。
 * group は外接矩形。選択が空なら null。
 * 1 個の回転した箱を持つノードは、W / H が回転の前の大きさ、X / Y が回転した箱の左上の角 (§8.5.5)。
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
  const rotated = singleRotatedBox(doc, ids);
  if (rotated) {
    const corner = boxCorner(rotated);
    return {
      mode: "box",
      values: { x: corner.x, y: corner.y, width: rotated.width, height: rotated.height },
    };
  }
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
 * テキストの大きさは同じ変更の中で求め直す (`auto-height` の幅を変えたら、高さが折り返しの結果になる。§4.7)。
 * 結果が範囲の外へ出るなら変えない。
 * 1 個の回転した箱を持つノードは、X / Y で回転した箱の左上の角を入力した位置へ動かし、W / H は左上の角を
 * 動かさずに自分の向きでリサイズする (§8.5.4、§8.5.5。大きさは整数に丸め、`x` `y` は丸めない)。
 */
export function setBoundsField(
  doc: CanvasDocument,
  selection: readonly NodeId[],
  field: BoundsField,
  value: number,
  measurer: TextMeasurer = canvasTextMeasurer,
): CanvasDocument {
  const ids = topLevelIds(doc, selection);
  const rotated = singleRotatedBox(doc, ids);
  if (rotated) {
    let next: CanvasDocument;
    if (field === "x" || field === "y") {
      const corner = boxCorner(rotated);
      const delta = value - corner[field];
      next = translateNodes(
        doc,
        [rotated.id],
        field === "x" ? delta : 0,
        field === "y" ? delta : 0,
      );
    } else {
      const size = Math.max(0, Math.round(value));
      next = resizeNodeInOwnFrame(doc, rotated.id, {
        x: 0,
        y: 0,
        width: field === "width" ? size : rotated.width,
        height: field === "height" ? size : rotated.height,
      });
      next = fitTextNodes(next, ids, measurer);
    }
    return next !== doc && geometryWithinLimits(next, ids) ? next : doc;
  }
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
      // 大きさ 0 のパスは点を広げられない (どの点も同じ x か y) ので変えない
      if (from[field] === 0 && node?.type === "path") continue;
      if (from[field] === 0 && node && isBoxNode(node)) {
        // 大きさ 0 からは比例で広げられない (`resizeNodes` は倍率 1 にする) ので、値をそのまま当てる
        next = updateNodes(next, [id], zeroSizePatch(node, field, value));
        continue;
      }
      next = resizeNodes(next, [id], from, { ...from, [field]: value }, { round: true });
    }
  }
  if (field === "width" || field === "height") next = fitTextNodes(next, ids, measurer);
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

/**
 * 回転の欄の値 (§8.5.5)。箱を持つノードだけの選択なら、全部同じ値ならその値、違えば `MIXED`。
 * 箱を持たないノード (線・group・ブーリアン) を含むか、選択が空なら null (欄を出さない)。
 */
export function readRotation(
  doc: CanvasDocument,
  selection: readonly NodeId[],
): number | Mixed | null {
  const ids = topLevelIds(doc, selection);
  if (ids.length === 0) return null;
  const values: number[] = [];
  for (const id of ids) {
    const node = getNode(doc, id);
    if (!node || !isBoxNode(node)) return null;
    values.push(node.rotation);
  }
  const first = values[0] as number;
  return values.every((v) => v === first) ? first : MIXED;
}

/**
 * 回転の欄に入力した角度を当てる。各ノードを自分の中心のまわりに、その角度 (自分の `rotation`) へそろえる
 * (-180 より大きく 180 以下、小数第 2 位で丸める)。箱を持たないノードは変えない。
 */
export function setRotationField(
  doc: CanvasDocument,
  selection: readonly NodeId[],
  value: number,
): CanvasDocument {
  return setNodesRotation(doc, selection, value);
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
