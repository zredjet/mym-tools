/**
 * Backup Tauri コマンドの型付きラッパー (`src-tauri/src/commands/backup.rs`)。
 *
 * - 取得: `auto` / `manual` (`pre-op` はバックエンドの破壊操作直前で自動取得)
 * - 一覧: `list()` で全 kind を created_at DESC
 * - 削除: `delete(path)` (`backups_root` 配下のみ、type-to-confirm UI と組合せ)
 * - 整合性検証: `verify(path)` (リストア前必須)
 * - リストア: `restore(path)` (内部で verify + pre-restore + 書き戻しを実施)
 */
import { invoke } from "@tauri-apps/api/core";

/** バックアップ種別 (`backup/mod.rs::BackupKind`) */
export type BackupKind = { type: "auto" } | { type: "pre_op"; prefix: string } | { type: "manual" };

/** バックアップ 1 ファイルの情報 (`backup/mod.rs::BackupRecord`) */
export interface BackupRecord {
  path: string;
  kind: BackupKind;
  created_at: string; // JST_ISO8601
  data_revision: number;
  size_bytes: number;
}

export function shouldTakeAuto(): Promise<boolean> {
  return invoke<boolean>("core_backup_should_take_auto");
}

export function listBackups(): Promise<BackupRecord[]> {
  return invoke<BackupRecord[]>("core_backup_list");
}

export function takeAutoBackup(): Promise<BackupRecord> {
  return invoke<BackupRecord>("core_backup_take_auto");
}

export function takeManualBackup(): Promise<BackupRecord> {
  return invoke<BackupRecord>("core_backup_take_manual");
}

export function deleteBackup(path: string): Promise<void> {
  return invoke<void>("core_backup_delete", { path });
}

export function verifyBackup(path: string): Promise<void> {
  return invoke<void>("core_backup_verify", { path });
}

/**
 * バックアップから restore する (verify + pre-restore + 書き戻しを内部で実施)。
 * **戻り値が成功でも、フロントは「アプリを再起動してください」モーダルを表示する責務**
 * (`docs/data-model.md` §13.6 step 7)。
 */
export function restoreBackup(path: string): Promise<void> {
  return invoke<void>("core_backup_restore", { path });
}
