/**
 * パネルから選択を購読する補助。
 * store の購読はどの変更でも selector を呼ぶ (パンやホバーでも) ので、文書と選択が同じなら
 * 前の結果を返して求め直さない。
 */
import { useShallow } from "zustand/react/shallow";

import { getNode } from "../model/tree";
import type { CanvasDocument, CanvasNode, NodeId } from "../model/types";
import { editorStore, useEditorStore } from "../state/store";

/** 文書と選択の組ごとに結果を覚える (直前の 1 組だけ)。 */
export function memoBySelection<T>(
  compute: (doc: CanvasDocument, selection: readonly NodeId[]) => T,
): (doc: CanvasDocument, selection: readonly NodeId[]) => T {
  let last: { doc: CanvasDocument; selection: readonly NodeId[]; value: T } | null = null;
  return (doc, selection) => {
    if (last && last.doc === doc && last.selection === selection) return last.value;
    const value = compute(doc, selection);
    last = { doc, selection, value };
    return value;
  };
}

/** 選択中のノード (選択の順)。どれかのノードが変わったときだけ新しい配列になる。 */
export function useSelectedNodes(): CanvasNode[] {
  return useEditorStore(
    useShallow((s) =>
      s.selection
        .map((id) => getNode(s.doc, id))
        .filter((node): node is CanvasNode => node !== undefined),
    ),
  );
}

/** 選択に対する変更を履歴に 1 件積む。 */
export function applyToSelection(
  change: (doc: CanvasDocument, selection: readonly NodeId[]) => CanvasDocument,
): void {
  const { selection, apply } = editorStore.getState();
  apply((doc) => change(doc, selection));
}

const selectionSets = new WeakMap<readonly NodeId[], ReadonlySet<NodeId>>();

/**
 * 選択の集合。選択の配列ごとに 1 回だけ作るので、各行が `has` で引いても
 * 行の数 × 選択の数にならない (§5.2)。
 */
export function selectionSet(selection: readonly NodeId[]): ReadonlySet<NodeId> {
  let set = selectionSets.get(selection);
  if (!set) {
    set = new Set(selection);
    selectionSets.set(selection, set);
  }
  return set;
}
