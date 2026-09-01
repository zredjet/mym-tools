import { invoke } from "@tauri-apps/api/core";

export type MermaidExportFormat = "svg" | "png";

export function mermaidWriteFile(input: {
  path: string;
  format: MermaidExportFormat;
  data: string;
}): Promise<void> {
  return invoke<void>("mermaid_write_file", input);
}
