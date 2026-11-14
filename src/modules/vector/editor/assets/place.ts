/**
 * 取り込んだ画像・SVG を文書に置く計算 (§4.8 / §3.4)。純関数 (SVG の検証を通す `checkSavable` を除き DOM に依存しない)。
 *
 * - 置く位置は、表示範囲の中央か、指定した点 (OS からのドロップ)。その点を中心にする
 * - 大きすぎる画像は表示範囲に収まる大きさに縮める (アセットは元のまま)。縦横比は保つ。結果は整数
 * - 親は作成ツールと同じ規則 (点の下の最も前面の frame、スコープの中ならスコープ)。表示範囲の中央に置くときは、
 *   置く矩形を丸ごと含む frame だけを親にする (`parentRule`)。座標は親の座標系に直す
 * - 同じ中身のアセットがあれば、それを使い回す (`addAsset`)
 * - アセットの上限、ノード数と深さ、§3.5 の範囲、ペイロード全体 (`checkSavable`) を超えるなら置かない
 */
import { addAsset, pruneAssets, totalAssetBytes } from "../model/assets";
import { createImage, createSvg } from "../model/create";
import { pageToLocal, type Rect } from "../model/geometry";
import { createId } from "../model/ids";
import { CANVAS_LIMITS } from "../model/limits";
import { checkSavable } from "../model/payload";
import { insertNode } from "../model/structure";
import type { ParentRef } from "../model/tree";
import type { Asset, CanvasDocument, NodeId, PageId, Point } from "../model/types";
import { geometryWithinLimits } from "../panels/limits";
import type { Viewport } from "../state/types";
import { containingParent, creationParent } from "../tools/create/parent";

export interface Size {
  width: number;
  height: number;
}

/** 表示範囲 (ページ座標)。キャンバスの大きさが分からなければ null。 */
export function visibleArea(viewport: Viewport, viewSize: Size): Rect | null {
  if (!(viewSize.width > 0 && viewSize.height > 0 && viewport.zoom > 0)) return null;
  return {
    x: viewport.x,
    y: viewport.y,
    width: viewSize.width / viewport.zoom,
    height: viewSize.height / viewport.zoom,
  };
}

/** 表示範囲の中央 (ページ座標)。キャンバスの大きさが分からなければ表示位置の左上。 */
export function visibleCenter(viewport: Viewport, viewSize: Size): Point {
  const area = visibleArea(viewport, viewSize);
  return area
    ? { x: area.x + area.width / 2, y: area.y + area.height / 2 }
    : { x: viewport.x, y: viewport.y };
}

/**
 * 置く大きさ (整数、1 以上)。`available` (表示範囲の大きさ) に収まらなければ縦横比を保って縮める。
 * 拡大はしない。`available` が null なら元の大きさ。
 */
export function fitSize(natural: Size, available: Size | null): Size {
  let scale = 1;
  if (available && available.width > 0 && available.height > 0)
    scale = Math.min(1, available.width / natural.width, available.height / natural.height);
  const round = (v: number) => Math.min(CANVAS_LIMITS.maxSize, Math.max(1, Math.round(v)));
  return { width: round(natural.width * scale), height: round(natural.height * scale) };
}

/** `center` (ページ座標) を中心にした矩形を、親の座標系の整数にする。 */
export function centeredBox(
  doc: CanvasDocument,
  parent: ParentRef,
  center: Point,
  size: Size,
): Rect {
  const local = pageToLocal(doc, parent, {
    x: center.x - size.width / 2,
    y: center.y - size.height / 2,
  });
  const round = (v: number) => {
    const r = Math.round(v);
    return r === 0 ? 0 : r;
  };
  return { x: round(local.x), y: round(local.y), width: size.width, height: size.height };
}

export interface PlaceAssetInput {
  pageId: PageId;
  scopeId: NodeId | null;
  asset: Asset;
  /** ノードの名前 */
  name: string;
  /** 置く中心 (ページ座標) */
  center: Point;
  /** 収める大きさ (表示範囲の大きさ、ページ座標)。null なら縮めない */
  available: Size | null;
  /**
   * 親の決め方。`point` は中心の点の下の frame (OS からのドロップ、画像ツールのクリック)、
   * `contain` は置く矩形を丸ごと含む frame (表示範囲の中央に置くとき。大きな画像が frame に切り抜かれないように)
   */
  parentRule: "point" | "contain";
  /** 新しいノードの ID (省けば振る) */
  nodeId?: NodeId;
}

export type PlaceAssetResult =
  | { ok: true; doc: CanvasDocument; id: NodeId; parent: ParentRef }
  | { ok: false; reason: string };

const MIB = 1024 * 1024;

/** 画像・SVG を文書に置く。置けなければ理由を返す。 */
export function placeAsset(doc: CanvasDocument, input: PlaceAssetInput): PlaceAssetResult {
  const { asset } = input;
  const L = CANVAS_LIMITS;
  const valid = (v: number) => Number.isFinite(v) && v > 0 && v <= L.maxSize;
  if (!valid(asset.width) || !valid(asset.height))
    return { ok: false, reason: `大きさが 1 辺 ${L.maxSize} px を超えるため、取り込めません。` };

  const added = addAsset(doc, asset);
  const size = fitSize(asset, input.available);
  const parent =
    input.parentRule === "point"
      ? creationParent(added.doc, input.pageId, input.scopeId, input.center)
      : containingParent(added.doc, input.pageId, input.scopeId, {
          x: input.center.x - size.width / 2,
          y: input.center.y - size.height / 2,
          ...size,
        });
  const box = centeredBox(added.doc, parent, input.center, size);
  const id = input.nodeId ?? createId(added.doc.nodes);
  const init = { id, name: input.name, ...box };
  const node =
    asset.kind === "image" ? createImage(added.assetId, init) : createSvg(added.assetId, init);

  const next = insertNode(added.doc, node, parent);
  if (next === added.doc)
    return {
      ok: false,
      reason: `ノードの数 (${L.maxNodes} 個) か入れ子の深さ (${L.maxDepth} 段) の上限を超えるため、取り込めません。`,
    };
  if (!geometryWithinLimits(next, [id]))
    return { ok: false, reason: "置く位置が座標の範囲を超えるため、取り込めません。" };
  if (totalAssetBytes(pruneAssets(next).assets) > L.payloadBytes)
    return {
      ok: false,
      reason: `画像と SVG の合計が ${L.payloadBytes / MIB} MiB を超えるため、取り込めません。`,
    };
  // ペイロード全体 (検索用テキストの大きさなど)。取り込む前から保存できない文書なら、取込のせいではないので止めない
  const error = checkSavable(next);
  if (error !== null && checkSavable(doc) === null)
    return {
      ok: false,
      reason: `取り込むと保存できない作品になるため、取り込みません (${error})。`,
    };
  return { ok: true, doc: next, id, parent };
}
