import { invoke } from "@tauri-apps/api/core";

export function diagramEditorUrl(): Promise<string> {
  return invoke<string>("diagram_editor_url");
}

export function diagramReadFile(path: string): Promise<string> {
  return invoke<string>("diagram_read_file", { path });
}

export function diagramWriteFile(input: {
  path: string;
  format: "drawio" | "svg" | "png";
  data: string;
}): Promise<void> {
  return invoke<void>("diagram_write_file", input);
}
