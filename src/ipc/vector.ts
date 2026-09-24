import { invoke } from "@tauri-apps/api/core";
import type { VectorPayloadV1 } from "@/lib/types";
export const vectorEditorUrl = () => invoke<string>("vector_editor_url");
export const vectorReadFile = (path: string) =>
  invoke<VectorPayloadV1>("vector_read_file", { path });
export const vectorReadImage = (path: string) => invoke<string>("vector_read_image", { path });
export const vectorWriteFile = (path: string, format: "svg" | "png", data: string) =>
  invoke<void>("vector_write_file", { path, format, data });
