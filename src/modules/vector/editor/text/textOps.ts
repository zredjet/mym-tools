/**
 * 文字の節 (`panels/sections/TextSection.tsx`) の変更 (純関数)。
 * どの変更も同じ `DocRecipe` の中で `fitTextNodes` を通す (操作 1 回が履歴 1 件。§4.7)。
 */
import { CANVAS_LIMITS } from "../model/limits";
import { updateNodes } from "../model/transform";
import { getNode } from "../model/tree";
import type { CanvasDocument, NodeId, TextNode } from "../model/types";
import type { TextMeasurer } from "../render/types";
import { fitTextNodes } from "./fit";

export type TextStylePatch = Partial<
  Pick<
    TextNode,
    | "fontFamily"
    | "fontSize"
    | "fontWeight"
    | "italic"
    | "lineHeight"
    | "letterSpacing"
    | "align"
    | "sizing"
  >
>;

/** 太さの選択肢 (100〜900)。パネルの幅に収まる短い名前にする。 */
export const FONT_WEIGHTS: readonly { value: number; label: string }[] = [
  { value: 100, label: "100 極細" },
  { value: 200, label: "200 特細" },
  { value: 300, label: "300 細" },
  { value: 400, label: "400 標準" },
  { value: 500, label: "500 中" },
  { value: 600, label: "600 中太" },
  { value: 700, label: "700 太" },
  { value: 800, label: "800 特太" },
  { value: 900, label: "900 極太" },
];

/** `ids` のうちテキストのものに書式を当て、大きさを求め直す。変わらなければ引数の文書を返す。 */
export function applyTextStyle(
  doc: CanvasDocument,
  ids: readonly NodeId[],
  patch: TextStylePatch,
  measurer: TextMeasurer,
): CanvasDocument {
  const texts = ids.filter((id) => getNode(doc, id)?.type === "text");
  const next = updateNodes(doc, texts, patch);
  if (next === doc) return doc;
  return fitTextNodes(next, texts, measurer);
}

/** Rust の `char::is_control` (一般カテゴリ Cc) と同じ集合。 */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * フォント名の入力を解釈する。前後の空白を落とし、1〜`maxFontFamilyLength` 文字で制御文字を含まなければ
 * その名前、そうでなければ null (§3.5)。
 */
export function parseFontFamilyInput(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || hasControl(trimmed)) return null;
  if (Array.from(trimmed).length > CANVAS_LIMITS.maxFontFamilyLength) return null;
  // 対になっていないサロゲートは保存できない
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return null;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = trimmed.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      i++;
    }
  }
  return trimmed;
}
