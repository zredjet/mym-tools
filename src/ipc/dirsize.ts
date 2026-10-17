import { Channel, invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/** 基準ごとに返す項目の数 (Rust の `scan::TOP_K` と同じ) */
export const DIRSIZE_TOP_LIMIT = 10_000;
/** 走査するフォルダの上限 (Rust の `scan::MAX_DIRS` と同じ) */
export const DIRSIZE_MAX_DIRS = 1_000_000;

export type DirSizeNodeKind = "dir" | "file";

export interface DirSizeNode {
  id: number;
  /** ルートだけ null */
  parent_id: number | null;
  /** ルートは指定されたパスそのもの */
  name: string;
  kind: DirSizeNodeKind;
  /** ファイル内容のバイト数 (フォルダは配下の合計) */
  logical: number;
  /** ディスク上で確保された領域 (フォルダは配下の合計) */
  allocated: number;
  file_count: number;
  dir_count: number;
  /** 結果に含めなかった直下の項目 */
  other_count: number;
  other_logical: number;
  other_allocated: number;
  unreadable: boolean;
  lossy_name: boolean;
}

export interface DirSizeScanResult {
  root_path: string;
  separator: string;
  /** `id` は配列の添字と同じ。親は子より前に並ぶ */
  nodes: DirSizeNode[];
  total_files: number;
  total_dirs: number;
  unreadable: { count: number; paths: string[] };
  skipped: { links: number; other_volumes: number; hard_links: number; entries: number };
  /** Windows でドライブ直下を走査した時だけ */
  volume: { total_bytes: number; used_bytes: number } | null;
  limit_reached: boolean;
  top_limit: number;
  duration_ms: number;
}

export type DirSizeProgress =
  | { type: "started" }
  | { type: "scanning"; files: number; dirs: number; logical_bytes: number; current_dir: string }
  | { type: "done"; duration_ms: number }
  | { type: "cancelled" };

export function dirSizeScan(input: {
  operationId: string;
  rootPath: string;
  onProgress: (progress: DirSizeProgress) => void;
}): Promise<DirSizeScanResult> {
  const channel = new Channel<DirSizeProgress>();
  channel.onmessage = input.onProgress;
  return invoke<DirSizeScanResult>("dirsize_scan", {
    operationId: input.operationId,
    rootPath: input.rootPath,
    onProgress: channel,
  });
}

export function cancelDirSizeOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}

/** Finder / エクスプローラーで項目を選んだ状態で開く (`opener:default` の reveal) */
export function revealDirSizePath(path: string): Promise<void> {
  return revealItemInDir(path);
}
