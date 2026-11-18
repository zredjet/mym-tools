/**
 * パスの箱を形に合わせる (`docs/canvas-editor-design.md` §4.12)。
 *
 * パスの箱は形にぴったり合わせる: 曲線の範囲 (ハンドルの先は含めない) の左上が (0, 0)、大きさが `width` × `height`。
 * 形を変える操作 (点の編集、リサイズ、変換) のあとは、同じ `DocRecipe` の中で `fitPathNodes(doc, ids)` を通す。
 *
 * E・F・G が使うもの:
 * - `fitPathNodes(doc, ids)`: `ids` のノードと子孫のうちパスの箱を合わせる。`ids` が null なら文書のすべてのパス。
 *   範囲がずれていたら点を平行移動して箱を合わせ、見た目が動かないように (回転していても) `x` `y` を決める。
 *   範囲の差が 1e-6 以下なら直さない。変わるものがなければ文書をそのまま返す。平行移動と `x` `y` は丸めない
 * - `fitPathNode(node)`: ノード 1 個の版 (変わらなければ同じオブジェクト)
 */
import { applyToVector, rotate } from "../geometry/matrix";
import { DocDraft } from "../model/draft";
import { getDescendantIds, getNode } from "../model/tree";
import type { CanvasDocument, NodeId, PathNode } from "../model/types";
import { pathBounds } from "./measure";
import { translateSubpaths } from "./transform";

/** 範囲がこれ以下しかずれていなければ直さない (§4.12)。 */
export const PATH_FIT_EPSILON = 1e-6;

/** `-0` を `0` にする。 */
const noNegativeZero = (v: number) => (v === 0 ? 0 : v);

/**
 * パスの箱を曲線の範囲に合わせたノード。合っていれば (差が `PATH_FIT_EPSILON` 以下) 同じオブジェクトを返す。
 * 点がなければそのまま。
 */
export function fitPathNode(node: PathNode): PathNode {
  const b = pathBounds(node.subpaths);
  if (!b) return node;
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;
  if (
    Math.abs(b.minX) <= PATH_FIT_EPSILON &&
    Math.abs(b.minY) <= PATH_FIT_EPSILON &&
    Math.abs(width - node.width) <= PATH_FIT_EPSILON &&
    Math.abs(height - node.height) <= PATH_FIT_EPSILON
  )
    return node;
  const subpaths = translateSubpaths(node.subpaths, -b.minX, -b.minY);
  let x: number;
  let y: number;
  if (node.rotation === 0) {
    x = node.x + b.minX;
    y = node.y + b.minY;
  } else {
    // 自分の座標系の点 p は、親の座標系で (x, y) + c + R(p − c) (c は箱の中心) に描かれる。
    // 点を m だけ動かした新しい箱でも同じ所に描かれるよう、(x', y') = (x, y) + c − c' + R(m + c' − c)
    const c = { x: node.width / 2, y: node.height / 2 };
    const c2 = { x: width / 2, y: height / 2 };
    const v = applyToVector(rotate(node.rotation), {
      x: b.minX + c2.x - c.x,
      y: b.minY + c2.y - c.y,
    });
    x = node.x + c.x - c2.x + v.x;
    y = node.y + c.y - c2.y + v.y;
  }
  return {
    ...node,
    subpaths,
    x: noNegativeZero(x),
    y: noNegativeZero(y),
    width,
    height,
  };
}

/**
 * `ids` のノードとその子孫のうち、パスの箱を形に合わせる (§4.12)。`ids` が null なら文書のすべてのパス。
 * 変わるものがなければ引数の文書そのものを返す (履歴も `revision` も増えない)。
 */
export function fitPathNodes(doc: CanvasDocument, ids: readonly NodeId[] | null): CanvasDocument {
  const targets = new Set<NodeId>();
  if (ids === null) for (const id of Object.keys(doc.nodes)) targets.add(id);
  else
    for (const id of ids) {
      targets.add(id);
      for (const child of getDescendantIds(doc, id)) targets.add(child);
    }
  const draft = new DocDraft(doc);
  for (const id of targets) {
    const node = getNode(doc, id);
    if (node?.type !== "path") continue;
    const fitted = fitPathNode(node);
    if (fitted !== node) draft.set(fitted);
  }
  return draft.finish();
}
