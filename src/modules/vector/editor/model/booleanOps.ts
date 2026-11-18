/**
 * ブーリアンの作成と演算の切替 (`docs/canvas-editor-design.md` §4.15.4)。純関数で、変わらなければ引数の文書を
 * そのまま返す。解除は `structure.ts` の `ungroupNodes` が group と同じく行う。
 *
 * - `booleanCandidates(doc, ids)`: ブーリアンにできる選択なら、子にするノード (重なり順、背面が先)。できなければ null。
 *   2 個以上で、どれも矩形・楕円・パス・ブーリアン、すべて同じ親 (祖先も選ばれているノードは除いて数える)
 * - `createBooleanFromNodes(doc, ids, op, booleanId)`: 選んだノードを、選択の中で最も前面のものの位置に置いた
 *   ブーリアンに入れる。子の順は元の重なり順。塗り・線・影は最背面の子のものを写し、不透明度は 1、表示、
 *   ロックなし。名前は演算の名前。ノード数・深さの上限を超えるなら何もしない
 * - `setBooleanOp(doc, ids, op)`: 選択の中のブーリアンの演算を変える。名前が元の演算の既定の名前のままなら、
 *   名前も新しい演算の名前にする
 *
 * §4.15.1 の不変条件 (ブーリアンの子は 1 個以上で、種類は rect / ellipse / path / boolean だけ) は、
 * `booleanCandidates` が種類を確かめ、子を同じ親から移すだけなので保たれる (元の親は子を失うが、2 個以上を
 * 1 個のブーリアンに置き換えるので空にはならない)。
 */
import { BOOLEAN_OP_NAMES, createBoolean } from "./create";
import { DocDraft } from "./draft";
import { CANVAS_LIMITS } from "./limits";
import { parentDepth, subtreeHeight } from "./structure";
import {
  canBeBooleanChild,
  canHaveChildOfType,
  getNode,
  getParent,
  sameParent,
  topLevelIds,
  type ParentRef,
} from "./tree";
import type { BooleanNode, BooleanOp, CanvasDocument, CanvasNode, NodeId } from "./types";

/** ブーリアンの子にするノードと、その親。 */
export interface BooleanCandidates {
  /** 重なり順 (背面が先) */
  ids: NodeId[];
  parent: ParentRef;
}

/**
 * ブーリアンにできる選択なら、子にするノードと親。できなければ null (§4.15.4)。
 * 祖先も選ばれているノードは除いてから数える。
 */
export function booleanCandidates(
  doc: CanvasDocument,
  ids: readonly NodeId[],
): BooleanCandidates | null {
  const tops = topLevelIds(doc, ids);
  if (tops.length < 2) return null;
  let parent: ParentRef | null = null;
  for (const id of tops) {
    const node = getNode(doc, id);
    if (!node || !canBeBooleanChild(node.type)) return null;
    const p = getParent(doc, id);
    if (!p) return null;
    if (parent === null) parent = p;
    else if (!sameParent(parent, p)) return null;
  }
  if (parent === null || !canHaveChildOfType(doc, parent, "boolean")) return null;
  return { ids: tops, parent };
}

/** 塗り・線・影を写す (文書は書き換えない約束なので、オブジェクトは共有してよい)。子にできる種類はどれもこの 3 つを持つ。 */
function copyLook(node: CanvasNode): Partial<Pick<BooleanNode, "fill" | "stroke" | "shadow">> {
  if (
    node.type !== "rect" &&
    node.type !== "ellipse" &&
    node.type !== "path" &&
    node.type !== "boolean"
  )
    return {};
  return {
    fill: node.fill,
    stroke: node.stroke,
    shadow: node.shadow,
  };
}

/**
 * 選んだノードをブーリアンに入れる (§4.15.4)。`booleanId` を渡しておくと、呼び出し側がその ID で選び直せる。
 * ブーリアンにできない選択、ID が使われている、ノード数・深さの上限を超えるときは何もしない。
 */
export function createBooleanFromNodes(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  op: BooleanOp,
  booleanId: NodeId,
): CanvasDocument {
  const candidates = booleanCandidates(doc, ids);
  if (!candidates || getNode(doc, booleanId) !== undefined) return doc;
  const { ids: children, parent } = candidates;
  if (Object.keys(doc.nodes).length + 1 > CANVAS_LIMITS.maxNodes) return doc;
  const depth = parentDepth(doc, parent);
  if (children.some((id) => depth + 1 + subtreeHeight(doc.nodes, id) > CANVAS_LIMITS.maxDepth))
    return doc;
  const back = getNode(doc, children[0] as NodeId);
  if (!back) return doc;

  const draft = new DocDraft(doc);
  const siblings = draft.children(parent);
  const front = children[children.length - 1] as NodeId;
  const frontIndex = siblings.indexOf(front);
  // 最も前面の子の位置から、それより背面にある (外す) 子の数を引いた位置に入れる
  const at =
    frontIndex - siblings.slice(0, frontIndex).filter((id) => children.includes(id)).length;
  const set = new Set(children);
  draft.setChildren(
    parent,
    siblings.filter((id) => !set.has(id)),
  );
  draft.set(
    createBoolean(op, children, {
      id: booleanId,
      ...copyLook(back),
    }),
  );
  draft.attach(booleanId, parent, at);
  return draft.finish();
}

/**
 * 選択の中のブーリアンの演算を `op` にする (履歴 1 件はパネルが積む)。名前が元の演算の名前 (作ったときの既定)
 * のままなら、新しい演算の名前にする。ブーリアンでないノードは無視する。
 */
export function setBooleanOp(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  op: BooleanOp,
): CanvasDocument {
  const draft = new DocDraft(doc);
  for (const id of new Set(ids)) {
    const node = draft.get(id);
    if (node?.type !== "boolean" || node.op === op) continue;
    const name = node.name === BOOLEAN_OP_NAMES[node.op] ? BOOLEAN_OP_NAMES[op] : node.name;
    draft.set({ ...node, op, name });
  }
  return draft.finish();
}
