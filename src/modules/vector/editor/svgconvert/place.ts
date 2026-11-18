/**
 * 埋め込み SVG を編集できる形に置き換える (`docs/canvas-editor-design.md` §8.12)。純関数 (計測を除く)。
 *
 * `prepareSvgConversion(doc, id, measurer)`:
 * - `convertSvg` で SVG を断片 (埋め込み SVG のノードの座標系) にし、根の group に埋め込み SVG の名前・表示・
 *   ロック・不透明度 (ルートの `opacity` を掛ける) を写す
 * - 断片を、埋め込み SVG のノードの行列 (祖先の frame の回転と自分の回転を含む、回転と平行移動だけ) で
 *   ページ座標へ写し (`transformInDraft`。箱を持つノードは `rotation` に角度が足され、線とパスの点は写る)、
 *   埋め込み SVG の位置 (親、重なり順) に `insertFragment` で入れる。親の frame の向きへは `insertFragment` が
 *   §8.5.2 のとおり戻す。ID はすべて振り直す
 * - 埋め込み SVG のノードは消す。アセットは残す (Undo で戻るように。保存の前に `pruneAssets` が落とす。§3.4)
 * - 上限 (ノード数、深さ、座標、大きさ、パスの点の数) を超えるなら当てない。元の文書が保存の検証を通るなら、
 *   結果も保存の検証 (`checkSavable`) を通ることを確かめる (テキストの合計などの残りの上限)
 *
 * 結果: `{ ok: true, doc, ids: [根の group], dropped }` か、理由。
 */
import { DocDraft } from "../model/draft";
import { insertFragment, type Fragment } from "../model/fragment";
import { nodePageMatrix } from "../model/geometry";
import { getOwn } from "../model/ids";
import { checkSavable } from "../model/payload";
import { transformInDraft } from "../model/transform";
import { getIndexInParent, getNode, getParent } from "../model/tree";
import type { CanvasDocument, CanvasNode, GroupNode, NodeId } from "../model/types";
import { geometryWithinLimits, pathPointsWithinLimits } from "../panels/limits";
import type { TextMeasurer } from "../render/types";
import { convertSvg, type SvgConvertFailure } from "./convert";
import type { DroppedItem } from "./dropped";

export type SvgConversionFailure = SvgConvertFailure | "notSvg" | "limits" | "validation";

/** 当てなかった理由の文 (画面に出す)。 */
export const SVG_CONVERSION_MESSAGES: Readonly<Record<SvgConversionFailure, string>> = {
  notSvg: "編集できる形に変換できるのは、埋め込み SVG 1 個だけです。",
  invalid: "SVG を読めないため、編集できる形に変換できません。",
  empty:
    "変換できる形 (パス・矩形・楕円・線・テキスト) が 1 つもないため、編集できる形に変換できません。",
  tooLarge:
    "SVG が大きすぎる (要素の展開かノードの数が上限を超える) ため、編集できる形に変換できません。",
  limits:
    "結果がノードの数・入れ子の深さ・座標・大きさ・パスの点の数の上限を超えるため、編集できる形に変換できません。",
  validation: "変換した結果が保存できない形になるため、編集できる形に変換できません。",
};

export type SvgConversion =
  | { ok: true; doc: CanvasDocument; ids: NodeId[]; dropped: DroppedItem[] }
  | { ok: false; reason: SvgConversionFailure; detail: string | null };

/** 断片を 1 ページの文書として扱う (model の関数をそのまま使うため)。 */
function fragmentDocument(fragment: Fragment): CanvasDocument {
  return {
    pages: [{ id: "convert", name: "", children: fragment.roots, guides: [] }],
    nodes: fragment.nodes,
    assets: fragment.assets,
  };
}

/** 埋め込み SVG `id` を変換した文書を作る (文書は変えない)。 */
export function prepareSvgConversion(
  doc: CanvasDocument,
  id: NodeId,
  measurer: TextMeasurer,
): SvgConversion {
  const node = getNode(doc, id);
  const parent = getParent(doc, id);
  if (node?.type !== "svg" || !parent) return { ok: false, reason: "notSvg", detail: null };
  const asset = getOwn(doc.assets, node.assetId);
  if (asset?.kind !== "svg") return { ok: false, reason: "notSvg", detail: null };
  if (!(node.width > 0 && node.height > 0)) return { ok: false, reason: "empty", detail: null };

  const converted = convertSvg(asset.svg, {
    width: node.width,
    height: node.height,
    assetWidth: asset.width,
    assetHeight: asset.height,
    measurer,
  });
  if (!converted.ok) return converted;

  // 根の group に、埋め込み SVG の名前・表示・ロック・不透明度を写す
  const { fragment } = converted;
  const rootId = fragment.roots[0] as NodeId;
  const root = fragment.nodes[rootId] as GroupNode;
  const named: Record<NodeId, CanvasNode> = {
    ...fragment.nodes,
    [rootId]: {
      ...root,
      name: node.name,
      visible: node.visible,
      locked: node.locked,
      opacity: node.opacity * root.opacity,
    },
  };

  // 埋め込み SVG の座標系 → ページ座標 (回転と平行移動だけ)
  const draft = new DocDraft(fragmentDocument({ ...fragment, nodes: named }));
  transformInDraft(draft, rootId, nodePageMatrix(doc, id));
  const placed = draft.finish();
  const pageFragment: Fragment = { roots: [rootId], nodes: placed.nodes, assets: {} };

  // 埋め込み SVG を外し、同じ位置に入れる
  const index = getIndexInParent(doc, id);
  const removing = new DocDraft(doc);
  removing.detach(id);
  removing.remove(id);
  const without = removing.finish();
  const inserted = insertFragment(without, pageFragment, parent, { index });
  if (inserted.ids.length === 0) return { ok: false, reason: "limits", detail: null };
  const next = inserted.doc;
  if (!geometryWithinLimits(next, inserted.ids) || !pathPointsWithinLimits(next, inserted.ids))
    return { ok: false, reason: "limits", detail: null };

  // 保存の検証 (元の文書が通るときだけ。編集の途中などで元が通らない文書では、変換のせいにしない)
  if (checkSavable(doc) === null) {
    const problem = checkSavable(next);
    if (problem !== null) return { ok: false, reason: "validation", detail: problem };
  }
  return { ok: true, doc: next, ids: inserted.ids, dropped: converted.dropped };
}
