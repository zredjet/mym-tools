import { invoke } from "@tauri-apps/api/core";

import type { Confidence, SourceEncoding, TextEncoding } from "@/ipc/encoding";

/** ファイルと復号後の文字列の上限 (ADR-0024)。`src-tauri/src/modules/csvview/commands.rs` と同じ値。 */
export const MAX_CSV_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_TEXT_BYTES = 32 * 1024 * 1024;

export interface CsvFileText {
  text: string;
  encoding: TextEncoding;
  confidence: Confidence | null;
  bom: TextEncoding | null;
  size: number;
}

export function csvviewReadFile(input: {
  operationId: string;
  path: string;
  source: SourceEncoding;
}): Promise<CsvFileText> {
  return invoke<CsvFileText>("csvview_read_file", input);
}

export function cancelCsvViewOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
