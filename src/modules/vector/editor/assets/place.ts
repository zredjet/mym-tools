/**
 * 取り込んだ画像・SVG を文書に置く計算 (§4.8 / §3.4)。純関数 (SVG の検証を通す `checkSavable` を除き DOM に依存しない)。
 *
 * - 置く位置は、表示範囲の中央か、指定した点 (OS からのドロップ)。その点を中心にする
 * - 大きすぎる画像は表示範囲に収まる大きさに縮める (アセットは元のまま)。縦横比は保つ。結果は整数
 * - 親は作成ツールと同じ規則 (点の下の最も前面の frame、スコープの中ならスコープ)。表示範囲の中央に置くときは、
 *   置く箱を丸ごと含む frame だけを親にする (`parentRule`)。座標は親の座標系に直す。回転した frame の中では、
 *   中心を frame の座標系に直してから箱を作る (frame の向きにそろい、中心が指定の点に来る。§4.11.2)。
 *   丸ごと含むかは、frame ごとに「その frame の向きで置いた箱」の 4 隅で確かめる (`containParent`)
 * - 同じ中身のアセットがあれば、それを使い回す (`addAsset`)
 * - アセットの上限、ノード数と深さ、§3.5 の範囲、ペイロード全体 (`checkSavable`) を超えるなら置かない
 */
import { applyToPoint } from "../geometry/matrix";
import { isInteractive } from "../hit/hitTest";
import { dropFrameContains, type DropFrame } from "../hit/marquee";
import { addAsset, pruneAssets, totalAssetBytes } from "../model/assets";
import { createImage, createSvg } from "../model/create";
import {
  getPageBounds,
  isTranslation,
  parentMatrix,
  pageToLocal,
  rectContainsPoint,
  rectCorners,
  type Rect,
} from "../model/geometry";
import { createId } from "../model/ids";
import { CANVAS_LIMITS } from "../model/limits";
import { checkSavable } from "../model/payload";
import { insertNode } from "../model/structure";
import {
  getAncestors,
  getNode,
  getPageOf,
  isAncestorOf,
  isGroupLike,
  outsideBooleans,
  type ParentRef,
} from "../model/tree";
import type { Asset, CanvasDocument, NodeId, PageId, Point } from "../model/types";
import { geometryWithinLimits } from "../panels/limits";
import type { Viewport } from "../state/types";
import { creationFrames, creationParent } from "../tools/create/parent";

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

/**
 * `center` (ページ座標) を中心にした矩形を、親の座標系の整数にする。親が回転した frame の中なら、中心を
 * 親の座標系に直してから大きさの半分を引く (箱は親の向きにそろう)。
 */
export function centeredBox(
  doc: CanvasDocument,
  parent: ParentRef,
  center: Point,
  size: Size,
): Rect {
  const round = (v: number) => {
    const r = Math.round(v);
    return r === 0 ? 0 : r;
  };
  const local = isTranslation(parentMatrix(doc, parent))
    ? pageToLocal(doc, parent, { x: center.x - size.width / 2, y: center.y - size.height / 2 })
    : (() => {
        const c = pageToLocal(doc, parent, center);
        return { x: c.x - size.width / 2, y: c.y - size.height / 2 };
      })();
  return { x: round(local.x), y: round(local.y), width: size.width, height: size.height };
}

/** `center` を中心に `parent` の向きで置く箱 (`centeredBox`) の 4 隅 (ページ座標)。 */
function placedCorners(doc: CanvasDocument, parent: ParentRef, center: Point, size: Size): Point[] {
  const m = parentMatrix(doc, parent);
  return rectCorners(centeredBox(doc, parent, center, size)).map((p) => applyToPoint(m, p));
}

/**
 * 置く箱を丸ごと入れられる親 (`parentRule: "contain"`)。規則は `containingParent` (tools/create/parent.ts) と同じ
 * (スコープが箱を含むならスコープの中の最も前面の frame か、なければスコープ。そうでなければ箱を丸ごと含む最も
 * 前面の frame、なければページ直下。ブーリアンのスコープならブーリアンの外の最も近い親)。
 *
 * `containingParent` はページの軸に平行な 1 つの矩形で判定するが、置く箱は親の向きにそろう (§4.11.2) ので、
 * 回転した frame では形が違う。ここでは frame ごとに、その frame の向きで置いた箱の 4 隅が見えている範囲
 * (`dropFrameContains`) に収まるかで確かめる。回転していない文書では `containingParent` と同じ結果。
 */
export function containParent(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId | null,
  center: Point,
  size: Size,
  frames: readonly DropFrame[] = creationFrames(doc, pageId),
): ParentRef {
  const fits = frames.filter((frame) =>
    placedCorners(doc, { kind: "node", id: frame.id }, center, size).every((corner) =>
      dropFrameContains(frame, corner),
    ),
  );
  const frontmost = (candidates: readonly DropFrame[]): NodeId | null =>
    candidates.length === 0 ? null : (candidates[candidates.length - 1] as DropFrame).id;
  if (scopeId !== null && scopeHolds(doc, pageId, scopeId, center, size, fits)) {
    const within = frontmost(
      fits.filter((frame) => frame.id === scopeId || isAncestorOf(doc, scopeId, frame.id)),
    );
    return within !== null
      ? { kind: "node", id: within }
      : outsideBooleans(doc, { kind: "node", id: scopeId });
  }
  const front = frontmost(fits);
  return front === null ? { kind: "page", id: pageId } : { kind: "node", id: front };
}

/**
 * スコープが置く箱を丸ごと含むか。frame は見えている範囲 (`fits` に入っているか)。group とブーリアンは、
 * その座標系の向きで置いた箱の 4 隅が外接矩形と、祖先の切り抜く frame の外接矩形の中にあるか
 * (回転した切り抜く frame は外接矩形で近似する。`containingParent` と同じ)。
 */
function scopeHolds(
  doc: CanvasDocument,
  pageId: PageId,
  scopeId: NodeId,
  center: Point,
  size: Size,
  fits: readonly DropFrame[],
): boolean {
  const scope = getNode(doc, scopeId);
  if (!scope || getPageOf(doc, scopeId)?.id !== pageId || !isInteractive(doc, scopeId))
    return false;
  if (scope.type === "frame") return fits.some((frame) => frame.id === scopeId);
  if (!isGroupLike(scope)) return false;
  const corners = placedCorners(doc, { kind: "node", id: scopeId }, center, size);
  const holds = (rect: Rect | null) =>
    rect !== null && corners.every((corner) => rectContainsPoint(rect, corner));
  if (!holds(getPageBounds(doc, scopeId))) return false;
  return getAncestors(doc, scopeId).every(
    (ancestor) =>
      ancestor.type !== "frame" || !ancestor.clip || holds(getPageBounds(doc, ancestor.id)),
  );
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
      : containParent(added.doc, input.pageId, input.scopeId, input.center, size);
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
