/** 作成ツールのテスト用の文書。 */
import { createEmptyDocument, createFrame, createRect } from "../../model/create";
import { groupNodes, insertNode } from "../../model/structure";
import type { ParentRef } from "../../model/tree";
import type { CanvasDocument } from "../../model/types";

/**
 * 切り抜かない frame `F` (0,0 100×100) の中に、その外へはみ出した group `g` (r 150,10 50×20)。
 * `clip` で F を切り抜く frame にする。`outer` を渡すと、F をさらに切り抜く frame `A` (幅 outer) に入れる。
 */
export function overflowGroupDocument(clip = false, outer?: number): CanvasDocument {
  let doc: CanvasDocument = createEmptyDocument();
  const top: ParentRef = { kind: "page", id: "page1" };
  let parent: ParentRef = top;
  if (outer !== undefined) {
    doc = insertNode(doc, createFrame({ id: "A", width: outer, height: 300, clip: true }), top);
    parent = { kind: "node", id: "A" };
  }
  doc = insertNode(doc, createFrame({ id: "F", width: 100, height: 100, clip }), parent);
  doc = insertNode(doc, createRect({ id: "r", x: 150, y: 10, width: 50, height: 20 }), {
    kind: "node",
    id: "F",
  });
  return groupNodes(doc, ["r"], "g");
}
