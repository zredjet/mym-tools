import { Channel, invoke } from "@tauri-apps/api/core";

export const MAX_PDF_INPUT_FILES = 50;
export const MAX_PDF_TOTAL_BYTES = 200 * 1024 * 1024;

export interface PdfInputInfo {
  path: string;
  file_name: string;
  size_bytes: number;
  page_count: number;
}

export interface PdfInspectIssue {
  path: string;
  reason: string;
}

export interface PdfInspectResult {
  accepted: PdfInputInfo[];
  rejected: PdfInspectIssue[];
}

export interface PdfMergeResult {
  output_path: string;
  total_pages: number;
  output_bytes: number;
  duration_ms: number;
}

export type PdfMergeProgress =
  | { type: "reading"; completed_files: number; total_files: number; file_name: string }
  | {
      type: "merging";
      completed_files: number;
      total_files: number;
      pages_processed: number;
    }
  | { type: "writing"; total_pages: number }
  | { type: "done"; duration_ms: number }
  | { type: "cancelled" };

export function pdfMergeInspectFiles(input: {
  operationId: string;
  paths: string[];
  onProgress: (progress: PdfMergeProgress) => void;
}): Promise<PdfInspectResult> {
  const channel = new Channel<PdfMergeProgress>();
  channel.onmessage = input.onProgress;
  return invoke<PdfInspectResult>("pdfmerge_inspect_files", {
    operationId: input.operationId,
    paths: input.paths,
    onProgress: channel,
  });
}

export function pdfMergeFiles(input: {
  operationId: string;
  inputPaths: string[];
  outputPath: string;
  onProgress: (progress: PdfMergeProgress) => void;
}): Promise<PdfMergeResult> {
  const channel = new Channel<PdfMergeProgress>();
  channel.onmessage = input.onProgress;
  return invoke<PdfMergeResult>("pdfmerge_merge_files", {
    operationId: input.operationId,
    inputPaths: input.inputPaths,
    outputPath: input.outputPath,
    onProgress: channel,
  });
}

export function cancelPdfMergeOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
