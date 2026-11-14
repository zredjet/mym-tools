/**
 * 文書の層 (画面用)。ノードごとのコンポーネントが自分のノードとアセットだけを購読し、
 * ノード 1 個の変更でほかのノードを描き直さない (§4.2)。
 * 形の規則は `render/buildNodeSvg.ts` の `buildNodeShell` を使い、ここには書かない。
 */
import { memo, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { CANVAS_LIMITS } from "../model/limits";
import { getNode, isContainer } from "../model/tree";
import type { NodeId } from "../model/types";
import { assetOf, buildNodeShell } from "../render/buildNodeSvg";
import { canvasTextMeasurer } from "../render/measureText";
import { svgElToReact } from "../render/svgEl";
import { useEditorStore } from "../state/store";
import type { EditorStore } from "../state/types";
import { selectVisibleTopLevelIds } from "./selectors";
import type { Size } from "./viewport";

/** 画面の `<defs>` の id の接頭辞。書き出しは別の接頭辞を使ってよい。 */
export const SCREEN_ID_PREFIX = "cv-";

interface NodeViewProps {
  id: NodeId;
  depth: number;
}

/** ノード 1 個。frame / group は子の `NodeView` を差し込み位置に置く。 */
export const NodeView = memo(function NodeView({ id, depth }: NodeViewProps) {
  const node = useEditorStore((state) => getNode(state.doc, id));
  const asset = useEditorStore((state) => {
    const current = getNode(state.doc, id);
    return current ? assetOf(state.doc, current) : undefined;
  });
  const shell = useMemo(
    () =>
      node
        ? buildNodeShell(node, { measurer: canvasTextMeasurer, idPrefix: SCREEN_ID_PREFIX, asset })
        : null,
    [node, asset],
  );
  if (!node || !shell) return null;
  // 壊れた文書の循環で止まらなくならないよう、深さの上限を超えたら子を描かない
  const slot =
    isContainer(node) && depth <= CANVAS_LIMITS.maxDepth
      ? node.children.map((child) => <NodeView key={child} id={child} depth={depth + 1} />)
      : undefined;
  return <>{svgElToReact(shell, { slot })}</>;
});

/** 表示中のページの、画面に入るページ直下のノード。ページ座標で描く (親の `<g>` が画面へ写す)。 */
export function PageLayer({ size }: { size: Size }) {
  const ids = useEditorStore(
    useShallow((state: EditorStore) => selectVisibleTopLevelIds(state, size)),
  );
  return (
    <>
      {ids.map((id) => (
        <NodeView key={id} id={id} depth={1} />
      ))}
    </>
  );
}
