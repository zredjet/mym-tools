import { Channel, invoke } from "@tauri-apps/api/core";

/** `shotq --quality=70-85 --speed 11` と同じ既定値 (ADR-0023 §2.5) */
export const DEFAULT_QUALITY_MIN = 70;
export const DEFAULT_QUALITY_MAX = 85;
export const DEFAULT_SPEED = 11;
export const MAX_PNG_INPUT_BYTES = 128 * 1024 * 1024;
export const MAX_PNG_PIXELS = 40_000_000;
export const MAX_PNG_FOLDER_FILES = 10_000;

export type PngOptStatus = "optimized" | "quality_too_low" | "not_smaller" | "failed";
export type PngOptOutputMode = "separate" | "overwrite";

export interface PngOptSettings {
  qualityMin: number;
  qualityMax: number;
  speed: number;
}

export interface PngOptFileResult {
  output_path: string;
  status: PngOptStatus;
  input_bytes: number;
  output_bytes: number;
  width: number;
  height: number;
  duration_ms: number;
  detail: string;
}

export interface PngOptScanResult {
  file_count: number;
  input_bytes: number;
  conflict_count: number;
  skipped_count: number;
}

export interface PngOptFolderResult {
  total: number;
  optimized: number;
  quality_too_low: number;
  not_smaller: number;
  failed: number;
  input_bytes: number;
  output_bytes: number;
  duration_ms: number;
}

export type PngOptProgress =
  | { type: "started"; total: number }
  | {
      type: "file";
      index: number;
      total: number;
      name: string;
      status: PngOptStatus;
      input_bytes: number;
      output_bytes: number;
      detail: string;
    }
  | { type: "done"; duration_ms: number }
  | { type: "cancelled" };

export function pngOptOptimizeFile(input: {
  operationId: string;
  inputPath: string;
  outputPath: string;
  settings: PngOptSettings;
}): Promise<PngOptFileResult> {
  return invoke<PngOptFileResult>("pngopt_optimize_file", {
    operationId: input.operationId,
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    qualityMin: input.settings.qualityMin,
    qualityMax: input.settings.qualityMax,
    speed: input.settings.speed,
  });
}

export function pngOptScanFolder(input: {
  folderPath: string;
  outputMode: PngOptOutputMode;
  outputFolder: string | null;
}): Promise<PngOptScanResult> {
  return invoke<PngOptScanResult>("pngopt_scan_folder", {
    folderPath: input.folderPath,
    outputMode: input.outputMode,
    outputFolder: input.outputFolder,
  });
}

export function pngOptOptimizeFolder(input: {
  operationId: string;
  folderPath: string;
  outputMode: PngOptOutputMode;
  outputFolder: string | null;
  settings: PngOptSettings;
  onProgress: (progress: PngOptProgress) => void;
}): Promise<PngOptFolderResult> {
  const channel = new Channel<PngOptProgress>();
  channel.onmessage = input.onProgress;
  return invoke<PngOptFolderResult>("pngopt_optimize_folder", {
    operationId: input.operationId,
    folderPath: input.folderPath,
    outputMode: input.outputMode,
    outputFolder: input.outputFolder,
    qualityMin: input.settings.qualityMin,
    qualityMax: input.settings.qualityMax,
    speed: input.settings.speed,
    onProgress: channel,
  });
}

export function cancelPngOptOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
