/**
 * 何をどの範囲で書き出すか (純関数、§4.9)。
 *
 * - 選択がすべて frame なら、frame ごとに 1 ファイル。範囲は frame の矩形
 * - frame でないノードを含む選択は、選択全体を 1 ファイル。範囲は描く範囲 (影や線の太さを含む) の和
 * - 選択がなければ、ページのすべてのノードを 1 ファイル。範囲は同じく描く範囲の和
 *
 * 非表示のノード (祖先が非表示のものを含む) は書き出さない。範囲は外側へ整数に丸める。
 *
 * - frame の範囲は frame の矩形ちょうど。frame の線の外側半分、影、はみ出した子は入らない
 *   (書き出す画像の大きさを frame の大きさと一致させるため)
 * - 入れ子のノードは、親の座標系の原点へ移して位置だけを合わせる。祖先の切り抜きと不透明度は反映しない
 */
import { renderBounds } from "../canvas/culling";
import { DEFAULT_NODE_NAMES } from "../model/create";
import { nodeOrigin, unionRects, type Rect } from "../model/geometry";
import { getAncestors, getNode, getPage, topLevelIds } from "../model/tree";
import type { CanvasDocument, NodeId, PageId } from "../model/types";
import type { TextMeasurer } from "../render/types";
import type { ExportKind, ExportPlan, ExportTarget } from "./types";

/** ページの名前が空のときのファイル名。 */
export const DEFAULT_PAGE_EXPORT_NAME = "ページ";
/** frame でないノードを複数選んだときのファイル名。 */
export const SELECTION_EXPORT_NAME = "選択範囲";

/** 外側へ整数に丸める (左上は切り下げ、右下は切り上げ)。 */
export function snapRectOutward(rect: Rect): Rect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    width: Math.ceil(rect.x + rect.width) - x,
    height: Math.ceil(rect.y + rect.height) - y,
  };
}

/** 自分と祖先がすべて表示中か (画面に描かれるか)。 */
export function isEffectivelyVisible(doc: CanvasDocument, id: NodeId): boolean {
  const node = getNode(doc, id);
  if (!node || !node.visible) return false;
  return getAncestors(doc, id).every((ancestor) => ancestor.visible);
}

function isEmpty(rect: Rect): boolean {
  return !(rect.width > 0 && rect.height > 0);
}

function nodeName(doc: CanvasDocument, id: NodeId): string {
  const node = getNode(doc, id);
  if (!node) return "";
  return node.name.trim() === "" ? DEFAULT_NODE_NAMES[node.type] : node.name;
}

function failure(kind: ExportKind, reason: string): ExportPlan {
  return { ok: false, kind, reason };
}

/** ノードの描く範囲の和 (ページ座標、外側へ整数に丸めたもの)。 */
function unionTarget(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  measurer: TextMeasurer,
  name: string,
): ExportTarget | null {
  const union = unionRects(ids.map((id) => renderBounds(doc, id, measurer)));
  if (!union) return null;
  const bounds = snapRectOutward(union);
  if (isEmpty(bounds)) return null;
  return { nodeIds: ids, bounds, name };
}

/**
 * 書き出しの対象を決める。`selection` は store の選択 (表示中のページのノードに絞ったもの)。
 * 書き出せないとき (描くものがない、範囲の大きさが 0) は理由を返す。
 */
export function planExport(
  doc: CanvasDocument,
  pageId: PageId,
  selection: readonly NodeId[],
  measurer: TextMeasurer,
): ExportPlan {
  if (selection.length === 0) {
    const page = getPage(doc, pageId);
    if (!page) return failure("page", "ページがありません。");
    const ids = page.children.filter((id) => isEffectivelyVisible(doc, id));
    if (ids.length === 0) return failure("page", "ページに表示中のノードがありません。");
    const name = page.name.trim() === "" ? DEFAULT_PAGE_EXPORT_NAME : page.name;
    const target = unionTarget(doc, ids, measurer, name);
    if (!target) return failure("page", "描く範囲の大きさが 0 です。");
    return { ok: true, kind: "page", targets: [target] };
  }

  // 祖先も選ばれているノードは祖先だけにする (frame とその中の frame を選んだら祖先の 1 ファイル)。
  // 非表示のノードを先に除いてから frame だけかを判定する (非表示が混ざっても書き出し方を変えない)
  const ids = topLevelIds(doc, selection);
  const visible = ids.filter((id) => isEffectivelyVisible(doc, id));
  const allFrames = visible.length > 0 && visible.every((id) => getNode(doc, id)?.type === "frame");
  const kind: ExportKind = allFrames ? "frames" : "selection";
  if (visible.length === 0) return failure(kind, "選択したノードはすべて非表示です。");

  if (allFrames) {
    const targets: ExportTarget[] = [];
    for (const id of visible) {
      const frame = getNode(doc, id);
      if (!frame || frame.type !== "frame") continue;
      const origin = nodeOrigin(doc, id);
      const bounds = snapRectOutward({
        x: origin.x + frame.x,
        y: origin.y + frame.y,
        width: frame.width,
        height: frame.height,
      });
      const name = nodeName(doc, id);
      if (isEmpty(bounds)) return failure(kind, `フレーム「${name}」の大きさが 0 です。`);
      targets.push({ nodeIds: [id], bounds, name });
    }
    return { ok: true, kind, targets };
  }

  const name =
    visible.length === 1 && visible[0] ? nodeName(doc, visible[0]) : SELECTION_EXPORT_NAME;
  const target = unionTarget(doc, visible, measurer, name);
  if (!target) return failure(kind, "描く範囲の大きさが 0 です。");
  return { ok: true, kind, targets: [target] };
}
