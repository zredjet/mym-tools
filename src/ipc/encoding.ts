import { invoke } from "@tauri-apps/api/core";

/** 1 ファイルの上限 (ADR-0024)。`src-tauri/src/modules/encoding/commands.rs` と同じ値。 */
export const MAX_ENCODING_INPUT_BYTES = 64 * 1024 * 1024;

export type TextEncoding = "utf8" | "utf16_le" | "utf16_be" | "shift_jis" | "euc_jp" | "iso2022_jp";
export type SourceEncoding = "auto" | TextEncoding;
export type TargetEncoding = "utf8" | "utf8_bom" | "shift_jis" | "euc_jp";
export type NewlineMode = "keep" | "lf" | "crlf";
export type Confidence = "bom" | "exact" | "guess" | "none";

export interface ByteIssue {
  offset: number;
  line: number;
  bytes: string;
}

export interface EncodingCandidate {
  encoding: TextEncoding;
  ok: boolean;
  malformed_count: number;
  first_error: ByteIssue | null;
}

export interface EncodingDetection {
  encoding: TextEncoding | null;
  confidence: Confidence;
  ascii_only: boolean;
  candidates: EncodingCandidate[];
}

export interface NewlineStats {
  crlf: number;
  lf: number;
  cr: number;
}

export interface EncodingInspection {
  size: number;
  bom: TextEncoding | null;
  detection: EncodingDetection | null;
  encoding: TextEncoding | null;
  ascii_only: boolean;
  malformed_count: number;
  malformed: ByteIssue[];
  newlines: NewlineStats;
  line_count: number;
  char_count: number;
  private_use_count: number;
  preview: string;
  preview_truncated: boolean;
}

export interface CharIssue {
  code_point: string;
  char: string;
  line: number;
  column: number;
}

export interface ConvertWarning {
  kind: "substituted" | "private_use";
  code_point: string;
  char: string;
  replacement: string | null;
  count: number;
  first_line: number;
}

export interface EncodingConvertResult {
  status: "written" | "rejected";
  source: TextEncoding;
  bytes_written: number;
  malformed_count: number;
  malformed: ByteIssue[];
  unmappable_count: number;
  unmappable: CharIssue[];
  normalized_count: number;
  warnings: ConvertWarning[];
  newlines: NewlineStats;
  duration_ms: number;
}

export function encodingInspectFile(input: {
  operationId: string;
  path: string;
  source: SourceEncoding;
}): Promise<EncodingInspection> {
  return invoke<EncodingInspection>("encoding_inspect_file", input);
}

export function encodingConvertFile(input: {
  operationId: string;
  inputPath: string;
  outputPath: string;
  source: SourceEncoding;
  target: TargetEncoding;
  newline: NewlineMode;
  normalizeMacSymbols: boolean;
}): Promise<EncodingConvertResult> {
  return invoke<EncodingConvertResult>("encoding_convert_file", input);
}

export function cancelEncodingOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
