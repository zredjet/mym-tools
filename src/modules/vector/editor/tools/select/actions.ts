/**
 * 選択に関するキー操作 (§5.4 の「編集」の節から呼ぶ)。
 * 文書の操作は `state/commands.ts` の関数を使い、ここでは次だけを足す。
 * - 結果の座標が §3.5 の範囲を超える操作を当てない (矢印、複製、貼り付け)
 * - ロック中・非表示のノードを動かさない (矢印)
 * - Enter / Esc の段階的な動作
 */
import type { StoreApi } from "zustand";
import { insertFragment } from "../../model/fragment";
import { duplicateNodes } from "../../model/structure";
import { getNode, getParentNode, topLevelIds } from "../../model/tree";
import type { CanvasDocument, NodeId } from "../../model/types";
import { geometryWithinLimits } from "../../panels/limits";
import { editorClipboard, PASTE_OFFSET, type EditorClipboard } from "../../state/clipboard";
import { duplicateSelection, pasteClipboard, pasteTarget } from "../../state/commands";
import type { EditorStore } from "../../state/types";
import { isInteractive, isTopLevelFrame } from "../../hit/hitTest";
import { moveDocument } from "./move";

type Store = StoreApi<EditorStore>;

const NONE: readonly NodeId[] = [];
let lastTransformable: {
  doc: CanvasDocument;
  selection: readonly NodeId[];
  ids: readonly NodeId[];
} | null = null;

/**
 * 動かせる選択 (祖先も選ばれているものを除き、本人と祖先が表示中でロックされていないもの)。
 * ホバーのたびに呼ぶので、文書と選択が同じなら前の結果を返す (返した配列は書き換えない)。
 */
export function transformableIds(
  doc: CanvasDocument,
  selection: readonly NodeId[],
): readonly NodeId[] {
  if (selection.length === 0) return NONE;
  const last = lastTransformable;
  if (last && last.doc === doc && last.selection === selection) return last.ids;
  const ids = topLevelIds(doc, selection).filter((id) => isInteractive(doc, id));
  lastTransformable = { doc, selection, ids };
  return ids;
}

/** 矢印キー: 選択を動かす (1 px、Shift で 10 px)。動かせるものがなければ false。 */
export function nudgeSelection(store: Store, dx: number, dy: number): boolean {
  const state = store.getState();
  const ids = transformableIds(state.doc, state.selection);
  if (ids.length === 0) return false;
  state.apply(
    (doc) => moveDocument({ doc, pageId: state.pageId, ids, delta: { x: dx, y: dy } }) ?? doc,
  );
  return true;
}

/** Cmd/Ctrl+D: 範囲を超えない場合だけ複製する。 */
export function duplicateWithinLimits(store: Store): void {
  const { doc, selection } = store.getState();
  const dry = duplicateNodes(doc, selection, { x: PASTE_OFFSET, y: PASTE_OFFSET });
  if (dry.doc === doc || !geometryWithinLimits(dry.doc, dry.ids)) return;
  duplicateSelection(store);
}

/** Cmd/Ctrl+V: 範囲を超えない場合だけ貼り付ける。 */
export function pasteWithinLimits(
  store: Store,
  clipboard: EditorClipboard = editorClipboard,
): void {
  const state = store.getState();
  const content = clipboard.content;
  if (!content) return;
  const target = pasteTarget(state, clipboard);
  const offset = clipboard.pasteOffset(state.doc, target);
  if (!offset) return;
  const dry = insertFragment(state.doc, content, target, { offset });
  if (dry.doc === state.doc || !geometryWithinLimits(dry.doc, dry.ids)) return;
  pasteClipboard(store, clipboard);
}

/**
 * Enter: テキストなら本文の編集、frame / group なら中に入って子を選ぶ。
 * 1 つだけ選んでいないときと、ほかのノードでは何もしない (false)。
 */
export function enterSelection(store: Store): boolean {
  const state = store.getState();
  const [id, ...rest] = state.selection;
  if (id === undefined || rest.length > 0 || !isInteractive(state.doc, id)) return false;
  const node = getNode(state.doc, id);
  if (!node) return false;
  if (node.type === "text") {
    state.startTextEdit(id);
    return true;
  }
  if (node.type !== "frame" && node.type !== "group") return false;
  state.setScope(id);
  state.setSelection(
    node.children.filter((child) => {
      const childNode = getNode(state.doc, child);
      return childNode !== undefined && childNode.visible && !childNode.locked;
    }),
  );
  return true;
}

/**
 * Esc (何もしていないとき): 本文の編集の終了 → スコープを 1 段外へ (出たノードを選ぶ) → 選択の解除。
 * 何もすることがなければ false。
 */
export function escapeSelection(store: Store): boolean {
  const state = store.getState();
  if (state.editingTextId !== null) {
    state.endTextEdit();
    return true;
  }
  if (state.scopeId !== null) {
    const scope = state.scopeId;
    const parent = getParentNode(state.doc, scope);
    // ページ直下の frame の子は直接選べるので、そこまで出たらページ直下として扱う
    const next = parent && !isTopLevelFrame(state.doc, parent.id) ? parent.id : null;
    state.setScope(next);
    state.setSelection(isInteractive(state.doc, scope) ? [scope] : []);
    return true;
  }
  if (state.selection.length > 0) {
    state.setSelection([]);
    return true;
  }
  return false;
}
