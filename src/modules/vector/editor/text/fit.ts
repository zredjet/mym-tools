/**
 * テキストの大きさを本文に合わせて求め直す (`docs/canvas-editor-design.md` §4.7)。
 *
 * 名前と引数は契約で、選択と変形 (リサイズの後)、パネル、本文の編集、読み込みの前の処理が呼ぶ。
 * 行分割は `layoutText` に任せ、ここでは結果をノードの大きさへ反映するだけにする。
 */
import { CANVAS_LIMITS } from "../model/limits";
import { mapNodes, type NodePatch } from "../model/transform";
import { getDescendantIds } from "../model/tree";
import type { CanvasDocument, CanvasNode, NodeId } from "../model/types";
import type { TextMeasurer } from "../render/types";
import { ceilSize, layoutText } from "./layout";

/**
 * `ids` のノードとその子孫のうち、テキストの大きさを本文・フォント・幅から求め直す。
 * `ids` が null なら、文書のすべてのテキストを対象にする (読み込みの前)。
 *
 * - `auto-width`: 幅と高さを行分割の結果に合わせる。幅が変わるときは、揃えが左なら左端、
 *   中央なら中心、右なら右端を保つ
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

/**
 * 中央揃えで幅が変わったときの左端のずれ。整数の位置を保つため半分を丸める。0 から遠い方へ丸めるので、
 * 広げてから同じだけ狭めると元の位置へ戻る (片側へ少しずつずれていかない)。
 */
function halfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value) / 2);
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
  if (node.sizing === "auto-height") return { height };
  const width = ceilSize(layout.width);
  const grown = width - node.width;
  const shift =
    node.align === "center" ? halfAwayFromZero(grown) : node.align === "right" ? grown : 0;
  return { x: clampCoordinate(node.x - shift), width, height };
}
