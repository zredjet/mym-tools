/**
 * 「変換」の節の「線のアウトライン化」(§8.10、§8.13)。
 *
 * 型と補助は `panels/sections/convertSupport.ts` から読み込む (一覧 `convertActions.ts` は読み込まない)。
 * ショートカット (Shift+Cmd/Ctrl+O) は `canvas/shortcuts.ts` の `OUTLINE_SHORTCUTS` が `outlineSelection` を呼ぶ。
 *
 * - 出すのは、選択 (祖先も選ばれているノードを除く) がどれも矩形・楕円・線・パス・ブーリアンで、線のある
 *   ノード (ブーリアンの子を除く) が 1 つ以上あるとき (§8.13 の「対象があるとき」)。線のないノードとブーリアン
 *   の子は飛ばす
 * - 押すと、線のあるノードそれぞれに当てる (`outline/nodes.ts`)。履歴 1 件。当てられなければ理由を出す
 *   (ショートカットで、線のないノードだけを選んでいるときも理由を出す)
 */
import { LineSquiggle } from "lucide-react";

import { IS_MAC } from "../canvas/input";
import { createId } from "../model/ids";
import { getAncestors, getNode } from "../model/tree";
import type { CanvasDocument, NodeId } from "../model/types";
import {
  applyConvertChange,
  refuseConvert,
  type ConvertAction,
  type ConvertAvailability,
  type ConvertContext,
  type ConvertStore,
} from "../panels/sections/convertSupport";
import { isBooleanChild, isOutlinable, OUTLINE_FAILURE_MESSAGES, outlineNodes } from "./nodes";

/** 選択の形 (出し分け用)。文書と選択の組ごとに 1 回だけ求める (パネルは描くたびに呼ぶ)。 */
let memo: {
  doc: CanvasDocument;
  selection: readonly NodeId[];
  value: ConvertAvailability | null;
} | null = null;

function computeAvailability(
  doc: CanvasDocument,
  selection: readonly NodeId[],
): ConvertAvailability | null {
  const selected = new Set(selection);
  let target = false;
  for (const id of selected) {
    const node = getNode(doc, id);
    if (!node || getAncestors(doc, id).some((ancestor) => selected.has(ancestor.id))) continue;
    if (!isOutlinable(node)) return null;
    if (node.stroke !== null && !isBooleanChild(doc, id)) target = true;
  }
  return target ? { enabled: true } : null;
}

export function outlineAvailability({
  doc,
  selection,
}: ConvertContext): ConvertAvailability | null {
  if (memo && memo.doc === doc && memo.selection === selection) return memo.value;
  const value = computeAvailability(doc, selection);
  memo = { doc, selection, value };
  return value;
}

/** 線をアウトライン化する (Shift+Cmd/Ctrl+O)。当てられなければ理由を出す。 */
export function outlineSelection(store: ConvertStore): void {
  const state = store.getState();
  if (state.editingPathId !== null || state.selection.length === 0) return;
  const created = new Set<NodeId>();
  const newId = (): NodeId => {
    let id = createId(state.doc.nodes);
    while (created.has(id)) id = createId(state.doc.nodes);
    created.add(id);
    return id;
  };
  const outcome = outlineNodes(state.doc, state.selection, newId);
  if (!outcome.ok) {
    // 対象にならない選択 (テキストなど) では黙って何もしない (ボタンも出ていない)
    if (outcome.reason !== "unsupported") refuseConvert(OUTLINE_FAILURE_MESSAGES[outcome.reason]);
    return;
  }
  applyConvertChange(store, () => outcome);
}

export const OUTLINE_CONVERT_ACTIONS: readonly ConvertAction[] = [
  {
    id: "outline",
    label: "線のアウトライン化",
    icon: LineSquiggle,
    shortcut: IS_MAC ? "⇧⌘O" : "Ctrl+Shift+O",
    availability: outlineAvailability,
    run: outlineSelection,
  },
];
