import { invoke } from "@tauri-apps/api/core";

/**
 * SVG ファイルの取り込み結果 (`vector_read_file`)。SVG ポリシーを通った SVG と、そこから抽出した
 * 検索用テキスト。draw.io の SVG などを変換した場合は、その内容を `notices` に持つ。
 * キャンバスはこれを埋め込み SVG として置く (`docs/canvas-editor-design.md` §4.8)。
 */
export interface VectorImportResult {
  svg: string;
  text: string;
  notices: string[];
}

export const vectorReadFile = (path: string) =>
  invoke<VectorImportResult>("vector_read_file", { path });
/** PNG / JPEG / WebP を読み、`data:image/...;base64,` の data URL で返す。 */
export const vectorReadImage = (path: string) => invoke<string>("vector_read_image", { path });
/** 書き出し。SVG は文字列 (28 MiB 以下)、PNG は `data:image/png;base64,` の data URL。 */
export const vectorWriteFile = (path: string, format: "svg" | "png", data: string) =>
  invoke<void>("vector_write_file", { path, format, data });
