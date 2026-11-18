/**
 * テキストの大きさを本文に合わせて求め直す (`docs/canvas-editor-design.md` §4.7、§8.5.7)。
 *
 * 名前と引数は契約で、選択と変形 (リサイズの後)、パネル、本文の編集、読み込みの前の処理が呼ぶ。
 * 行分割は `layoutText` に任せ、ここでは結果をノードの大きさへ反映するだけにする。
 *
 * 回転したテキスト (§8.5.7): 幅や高さが変わるときは、揃えで保つ辺 (左・中央・右) と上の辺が、親の座標系で
 * 動かないように `x` `y` を決める (回転は箱の中心のまわりなので、大きさが変わると中心が動く)。`x` `y` は丸めない。
 */
import { applyToVector, rotate } from "../geometry/matrix";
import { CANVAS_LIMITS } from "../model/limits";
import { mapNodes, type NodePatch } from "../model/transform";
import { getDescendantIds } from "../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, TextNode } from "../model/types";
import type { TextMeasurer } from "../render/types";
import { ceilSize, layoutText } from "./layout";

/**
 * `ids` のノードとその子孫のうち、テキストの大きさを本文・フォント・幅から求め直す。
 * `ids` が null なら、文書のすべてのテキストを対象にする (読み込みの前)。
 *
 * - `auto-width`: 幅と高さを行分割の結果に合わせる。幅が変わるときは、揃えが左なら左端、
 *   中央なら中心、右なら右端を保つ。中央揃えの `x` は丸めない (0.5 刻みになりうる)
 * - `auto-height`: 高さだけを合わせる (幅は折り返しの幅としてそのまま使う)
 * - `fixed`: 変えない
 * - 大きさは切り上げた整数にし、`maxSize` を超えない
 * - 変わるものがなければ、引数の文書そのものを返す (履歴も `revision` も増えない)
 *
 * 文書を変える操作は、同じ `DocRecipe` の中でこれを通す (操作 1 回が履歴 1 件になる)。
 */
export function fitTextNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[] | null,
  measurer: TextMeasurer,
): CanvasDocument {
  const targets = ids === null ? Object.keys(doc.nodes) : withDescendants(doc, ids);
  return mapNodes(doc, targets, (node) => fitPatch(node, measurer));
}

function withDescendants(doc: CanvasDocument, ids: readonly NodeId[]): NodeId[] {
  const result = new Set<NodeId>();
  for (const id of ids) {
    result.add(id);
    for (const child of getDescendantIds(doc, id)) result.add(child);
  }
  return [...result];
}

function clampCoordinate(value: number): number {
  return Math.min(CANVAS_LIMITS.maxCoordinate, Math.max(-CANVAS_LIMITS.maxCoordinate, value));
}

function fitPatch(node: CanvasNode, measurer: TextMeasurer): NodePatch | null {
  if (node.type !== "text" || node.sizing === "fixed") return null;
  const layout = layoutText(node, measurer);
  // 計測が数値を返さなかったときは、今の大きさを残す (保存できない文書にしない)
  if (!Number.isFinite(layout.width) || !Number.isFinite(layout.height)) return null;
  const height = ceilSize(layout.height);
  if (node.rotation !== 0)
    return rotatedFitPatch(
      node,
      node.sizing === "auto-height" ? node.width : ceilSize(layout.width),
      height,
    );
  if (node.sizing === "auto-height") return { height };
  const width = ceilSize(layout.width);
  const grown = width - node.width;
  const shift =
    // 中央揃えの x は丸めない (0.5 刻みになりうる)。丸めると、同じ向きの変更を重ねるたびに片側へずれていく
    node.align === "center" ? grown / 2 : node.align === "right" ? grown : 0;
  return { x: clampCoordinate(node.x - shift), width, height };
}

/** 揃えで保つ辺の、箱の中の x (左は 0、中央は幅の半分、右は幅)。 */
function anchorX(align: TextNode["align"], width: number): number {
  return align === "center" ? width / 2 : align === "right" ? width : 0;
}

/**
 * 回転したテキストの大きさを変える変更。揃えで保つ辺と上の辺の点 a (自分の座標系) が、親の座標系で
 * 動かないよう (x, y) を決める。点 p は (x, y) + c + R(p − c) (c は箱の中心) に描かれるので、
 * (x′, y′) = (x, y) + c + R(a − c) − c′ − R(a′ − c′)。大きさが変わらなければ null。
 */
function rotatedFitPatch(node: TextNode, width: number, height: number): NodePatch | null {
  if (width === node.width && height === node.height) return null;
  const r = rotate(node.rotation);
  const c = { x: node.width / 2, y: node.height / 2 };
  const c2 = { x: width / 2, y: height / 2 };
  const a = { x: anchorX(node.align, node.width), y: 0 };
  const a2 = { x: anchorX(node.align, width), y: 0 };
  const before = applyToVector(r, { x: a.x - c.x, y: a.y - c.y });
  const after = applyToVector(r, { x: a2.x - c2.x, y: a2.y - c2.y });
  const x = clampCoordinate(node.x + c.x + before.x - c2.x - after.x);
  const y = clampCoordinate(node.y + c.y + before.y - c2.y - after.y);
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y, width, height };
}
