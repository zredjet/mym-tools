/**
 * 選択に対するよく使う操作。store の `apply` と `setSelection` を組にして呼ぶだけの薄い層で、
 * ショートカット・メニュー・パネルから同じ動作を呼ぶために置く。
 * どれも履歴に 1 件積む (変化がなければ積まない)。
 */
import type { StoreApi } from "zustand";
import { alignNodes, distributeNodes, type AlignKind, type DistributeAxis } from "../model/align";
import { createId } from "../model/ids";
import {
  deleteNodes,
  duplicateNodes,
  groupNodes,
  reorderNodes,
  ungroupNodes,
  type DocChange,
  type ReorderDirection,
} from "../model/structure";
import { translateNodes } from "../model/transform";
import { getChildren, getNode, topLevelIds, type ParentRef } from "../model/tree";
import type { CanvasDocument } from "../model/types";
import { editorClipboard, PASTE_OFFSET, type EditorClipboard } from "./clipboard";
import type { EditorState, EditorStore } from "./types";

type Store = StoreApi<EditorStore>;

/** 新しいノードを入れる先: スコープの中、なければ表示中のページの直下。 */
export function currentParent(state: Pick<EditorState, "pageId" | "scopeId">): ParentRef {
  return state.scopeId !== null
    ? { kind: "node", id: state.scopeId }
    : { kind: "page", id: state.pageId };
}

/** 文書を変え、変わったら選択を `ids` にする。 */
function applyChange(store: Store, change: (doc: CanvasDocument) => DocChange): boolean {
  const state = store.getState();
  const result = change(state.doc);
  if (result.doc === state.doc) return false;
  state.apply(() => result.doc);
  store.getState().setSelection(result.ids);
  return true;
}

/** 選択を消す。 */
export function deleteSelection(store: Store): void {
  const { selection, apply } = store.getState();
  apply((doc) => deleteNodes(doc, selection));
}

/** 選択を複製し、複製を選ぶ (Cmd/Ctrl+D)。複製は `offset` だけずらす。 */
export function duplicateSelection(
  store: Store,
  offset = { x: PASTE_OFFSET, y: PASTE_OFFSET },
): void {
  const { selection } = store.getState();
  applyChange(store, (doc) => duplicateNodes(doc, selection, offset));
}

/** 選択を動かす (矢印キー)。 */
export function nudgeSelection(store: Store, dx: number, dy: number): void {
  const { selection, apply } = store.getState();
  apply((doc) => translateNodes(doc, selection, dx, dy));
}

/** 選択をまとめて group にし、group を選ぶ (Cmd/Ctrl+G)。 */
export function groupSelection(store: Store): void {
  const { selection } = store.getState();
  if (selection.length === 0) return;
  const groupId = createId(store.getState().doc.nodes);
  applyChange(store, (doc) => {
    const next = groupNodes(doc, selection, groupId);
    return { doc: next, ids: next === doc ? [] : [groupId] };
  });
}

/** 選択の中の group を解除し、元の子を選ぶ (Shift+Cmd/Ctrl+G)。 */
export function ungroupSelection(store: Store): void {
  const { selection } = store.getState();
  applyChange(store, (doc) => {
    const ids = selection.flatMap((id) => {
      const node = getNode(doc, id);
      return node?.type === "group" ? node.children : [id];
    });
    return { doc: ungroupNodes(doc, selection), ids };
  });
}

/** 重なり順を変える。 */
export function reorderSelection(store: Store, direction: ReorderDirection): void {
  const { selection, apply } = store.getState();
  apply((doc) => reorderNodes(doc, selection, direction));
}

export function alignSelection(store: Store, kind: AlignKind): void {
  const { selection, apply } = store.getState();
  apply((doc) => alignNodes(doc, selection, kind));
}

export function distributeSelection(store: Store, axis: DistributeAxis): void {
  const { selection, apply } = store.getState();
  apply((doc) => distributeNodes(doc, selection, axis));
}

/** スコープの中をすべて選ぶ (Cmd/Ctrl+A)。非表示とロック中のノードは選ばない。 */
export function selectAll(store: Store): void {
  const state = store.getState();
  const ids = getChildren(state.doc, currentParent(state)).filter((id) => {
    const node = getNode(state.doc, id);
    return node !== undefined && node.visible && !node.locked;
  });
  state.setSelection(ids);
}

/** 選択をコピーする (Cmd/Ctrl+C)。 */
export function copySelection(store: Store, clipboard: EditorClipboard = editorClipboard): boolean {
  const { doc, selection } = store.getState();
  return clipboard.copy(doc, selection);
}

/** 選択を切り取る (Cmd/Ctrl+X)。 */
export function cutSelection(store: Store, clipboard: EditorClipboard = editorClipboard): void {
  if (copySelection(store, clipboard)) deleteSelection(store);
}

/**
 * 貼り付け先: frame を 1 つだけ選んでいればその中、そうでなければスコープの中かページの直下。
 */
export function pasteTarget(state: EditorState): ParentRef {
  const [only, ...rest] = topLevelIds(state.doc, state.selection);
  if (only !== undefined && rest.length === 0 && getNode(state.doc, only)?.type === "frame")
    return { kind: "node", id: only };
  return currentParent(state);
}

/** 貼り付けて、貼り付けたノードを選ぶ (Cmd/Ctrl+V)。 */
export function pasteClipboard(store: Store, clipboard: EditorClipboard = editorClipboard): void {
  const target = pasteTarget(store.getState());
  applyChange(store, (doc) => clipboard.paste(doc, target));
}
