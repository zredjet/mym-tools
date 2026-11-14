/**
 * アセット (§3.4)。同じ中身の画像・SVG は 1 つのアセットを共有し、
 * 参照されなくなったアセットは保存の前に落とす。
 */
import { createId, hasOwn } from "./ids";
import type { Asset, AssetId, CanvasDocument, CanvasNode } from "./types";

/** 中身が同じアセットか (画像は mime と base64、SVG は文書の文字列で比べる)。 */
export function sameAssetContent(a: Asset, b: Asset): boolean {
  if (a.kind === "image" && b.kind === "image")
    return a.mime === b.mime && a.data.length === b.data.length && a.data === b.data;
  if (a.kind === "svg" && b.kind === "svg") return a.svg.length === b.svg.length && a.svg === b.svg;
  return false;
}

/** 文書の中から同じ中身のアセットを探す。 */
export function findSameAsset(assets: Record<AssetId, Asset>, asset: Asset): AssetId | null {
  for (const [id, existing] of Object.entries(assets))
    if (existing === asset || sameAssetContent(existing, asset)) return id;
  return null;
}

/**
 * アセットを足す。同じ中身のアセットがあればそれを使い、文書は変えない。
 * 返った `assetId` を `createImage` / `createSvg` に渡す。
 */
export function addAsset(
  doc: CanvasDocument,
  asset: Asset,
  id?: AssetId,
): { doc: CanvasDocument; assetId: AssetId } {
  const existing = findSameAsset(doc.assets, asset);
  if (existing !== null) return { doc, assetId: existing };
  const assetId = id !== undefined && !hasOwn(doc.assets, id) ? id : createId(doc.assets);
  return { doc: { ...doc, assets: { ...doc.assets, [assetId]: asset } }, assetId };
}

function assetIdOf(node: CanvasNode): AssetId | null {
  return node.type === "image" || node.type === "svg" ? node.assetId : null;
}

/** ノードから参照されているアセットの ID。 */
export function referencedAssetIds(doc: CanvasDocument): Set<AssetId> {
  const ids = new Set<AssetId>();
  for (const node of Object.values(doc.nodes)) {
    const id = assetIdOf(node);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** 参照されていないアセットを落とす。落とすものがなければ文書をそのまま返す。 */
export function pruneAssets(doc: CanvasDocument): CanvasDocument {
  const used = referencedAssetIds(doc);
  const keys = Object.keys(doc.assets);
  if (keys.every((id) => used.has(id))) return doc;
  const assets: Record<AssetId, Asset> = {};
  for (const id of keys) if (used.has(id)) assets[id] = doc.assets[id] as Asset;
  return { ...doc, assets };
}

/** アセット 1 個の大きさ (§3.4: image は base64 の長さ、svg は UTF-8 のバイト数)。 */
export function assetBytes(asset: Asset): number {
  return asset.kind === "image" ? asset.data.length : utf8Length(asset.svg);
}

/** 全アセットの合計。`CANVAS_LIMITS.payloadBytes` 以下でなければ保存できない。 */
export function totalAssetBytes(assets: Record<AssetId, Asset>): number {
  let total = 0;
  for (const asset of Object.values(assets)) total += assetBytes(asset);
  return total;
}

/** UTF-8 のバイト数 (文字列を符号化せずに数える)。 */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
