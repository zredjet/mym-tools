/**
 * 入力欄の確定の対象 (§5.3 入力欄の確定の規則)。
 * 確定は入力を始めた時点で選んでいたノードに当て、なくなったノードは外す。
 */
import { getNode } from "../../model/tree";
import type { NodeId } from "../../model/types";
import { editorStore } from "../../state/store";

/** 今の文書に残っている ID だけを返す。 */
export function liveTargets(ids: readonly NodeId[]): NodeId[] {
  const { doc } = editorStore.getState();
  return ids.filter((id) => getNode(doc, id) !== undefined);
}
