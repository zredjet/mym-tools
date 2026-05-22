/**
 * M-Hash IPC ラッパー (`src-tauri/src/modules/hash/commands.rs`)。
 *
 * - `hashComputeText`: テキストハッシュ (同期、即時返却)
 * - `hashComputeFile`: ファイルハッシュ (`tauri::ipc::Channel<HashFileProgress>` で進捗、
 *   キャンセル機構付き、ADR-0009)
 * - `cancelOperation`: 進行中の長時間処理を中断 (`core_cancel_operation`)
 *
 * ## キャンセル設計 (ADR-0009 §2)
 *
 * フロントが `operation_id` (UUID v4) を発行し、`hashComputeFile` 呼び出しと
 * `cancelOperation(operationId)` で同じ ID を共有する。バックエンドは
 * `OperationRegistry` で token を引き当て、チャンク境界 (1 MB ごと) で
 * `is_cancelled()` を確認する。
 */
import { Channel, invoke } from "@tauri-apps/api/core";

export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512";

/**
 * バックエンドの `HashFileProgress` enum (`progress.rs`) と shape を一致させた discriminated
 * union。`switch (event.type)` で網羅性チェックできる。
 */
export type HashFileProgress =
  | { type: "progress"; bytes_processed: number; total_bytes: number }
  | { type: "done"; duration_ms: number }
  | { type: "cancelled" };

export function hashComputeText(input: {
  text: string;
  algorithm: HashAlgorithm;
}): Promise<string> {
  return invoke<string>("hash_compute_text", {
    text: input.text,
    algorithm: input.algorithm,
  });
}

/**
 * ファイルハッシュ計算 (ADR-0009 §2.1)。
 *
 * - `operationId`: フロント発行 UUID v4。同じ ID を `cancelOperation` に渡して中断
 * - `path`: 絶対パス (Tauri webview の `onDragDropEvent` から取得)
 * - `onProgress`: `Channel.onmessage` 経由でフロントが進捗を受け取る
 *
 * 戻り値: ハッシュ値の hex 小文字文字列。キャンセル時は `AppError::Cancelled` が
 * reject される (= Promise reject)。
 */
export function hashComputeFile(input: {
  operationId: string;
  path: string;
  algorithm: HashAlgorithm;
  onProgress: (p: HashFileProgress) => void;
}): Promise<string> {
  const channel = new Channel<HashFileProgress>();
  channel.onmessage = input.onProgress;
  return invoke<string>("hash_compute_file", {
    operationId: input.operationId,
    path: input.path,
    algorithm: input.algorithm,
    onProgress: channel,
  });
}

/**
 * 進行中の操作をキャンセル (ADR-0009 §2)。
 *
 * `operationId` が `OperationRegistry` に未登録 (= 完了済 / 未開始 / 重複 cancel)
 * の場合は `Ok(())` を返す (= no-op、idempotent)。
 */
export function cancelOperation(operationId: string): Promise<void> {
  return invoke<void>("core_cancel_operation", { operationId });
}
