/**
 * 文書と payload v2 の変換。エディタのモデルは payload と同じ形 (§3.1) なので、
 * 違いは検索用テキスト `text` の有無と、参照されないアセットを落とすことだけ。
 */
import { pruneAssets } from "./assets";
import { computeSearchText } from "./searchText";
import type { CanvasDocument, VectorPayloadV2 } from "./types";
import { validatePayload } from "./validate";

/** 保存する形にする。参照されないアセットを落とし、検索用テキストを付ける。検証はしない。 */
export function toPayload(doc: CanvasDocument): VectorPayloadV2 {
  const pruned = pruneAssets(doc);
  return {
    pages: pruned.pages,
    nodes: pruned.nodes,
    assets: pruned.assets,
    text: computeSearchText(pruned),
  };
}

/** payload から文書を取り出す (`text` を外すだけ。検証はしない)。 */
export function fromPayload(payload: VectorPayloadV2): CanvasDocument {
  return { pages: payload.pages, nodes: payload.nodes, assets: payload.assets };
}

export type ParsePayloadResult = { ok: true; doc: CanvasDocument } | { ok: false; error: string };

/** 読み込んだ値を検証してから文書にする。 */
export function parsePayload(value: unknown): ParsePayloadResult {
  const error = validatePayload(value);
  if (error !== null) return { ok: false, error };
  return { ok: true, doc: fromPayload(value as VectorPayloadV2) };
}

/** 保存できる形か確かめる。保存の前に呼び、理由があれば保存せずに利用者へ示す。 */
export function checkSavable(doc: CanvasDocument): string | null {
  return validatePayload(toPayload(doc));
}
