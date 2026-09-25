import { invoke } from "@tauri-apps/api/core";
import type { VectorPayloadV1 } from "@/lib/types";
export const vectorEditorUrl = () => invoke<string>("vector_editor_url");
/** SVG の取り込み結果。draw.io の SVG などを変換した場合は、その内容を `notices` に持つ */
export interface VectorImportResult extends VectorPayloadV1 {
  notices: string[];
}

export const vectorReadFile = (path: string) =>
  invoke<VectorImportResult>("vector_read_file", { path });
export const vectorReadImage = (path: string) => invoke<string>("vector_read_image", { path });
export const vectorWriteFile = (path: string, format: "svg" | "png", data: string) =>
  invoke<void>("vector_write_file", { path, format, data });
