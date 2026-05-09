//! バックアップの Tauri コマンド (`core_backup_*`、ADR-0007 / `data-model.md` §13)。
//!
//! `BackupService` の薄いラッパー。`module-contract.md` §6.2 に従い `core_*` 命名。
//! Settings 画面 (C-7 / C-8) からのみ呼ばれる想定で、モジュール UI からは呼ばない。
//!
//! ## 排他関係 (`data-model.md` §13.7 / ADR-0009 §1 表)
//!
//! - 取得 (`take_*`): 短時間 (~数百 ms) なので Phase 1 では同期実行 (キャンセル非対応)
//! - リストア: writer mutex 経由でアクティブ DB を上書き。完了後ユーザーがアプリを
//!   手動再起動する想定 (data-model.md §13.6 step 7)
//! - 削除 / 整合性検証: ファイルシステム操作のみ、writer mutex 不要

use std::path::PathBuf;

use tauri::State;

use crate::backup::{BackupKind, BackupRecord};
use crate::error::AppError;
use crate::state::AppState;

/// auto バックアップが必要か判定する (`data-model.md` §13.3):
/// `data_revision != last_backup_revision` AND 24h 経過 (or 未取得)。
#[tauri::command]
pub fn core_backup_should_take_auto(state: State<'_, AppState>) -> Result<bool, AppError> {
    state.backup.should_take_auto()
}

/// 全バックアップ (auto / pre-op / manual) を `created_at DESC` 順で返す (UI 一覧用)。
#[tauri::command]
pub fn core_backup_list(state: State<'_, AppState>) -> Result<Vec<BackupRecord>, AppError> {
    state.backup.list()
}

/// auto バックアップを取得する (`should_take_auto` が真のときに呼ぶ。10 件ローテ)。
#[tauri::command]
pub fn core_backup_take_auto(state: State<'_, AppState>) -> Result<BackupRecord, AppError> {
    state.backup.take(BackupKind::Auto)
}

/// manual バックアップを取得する (ローテーションなし、ユーザーが手動削除)。
#[tauri::command]
pub fn core_backup_take_manual(state: State<'_, AppState>) -> Result<BackupRecord, AppError> {
    state.backup.take(BackupKind::Manual)
}

/// 指定パスのバックアップを物理削除する。`backups_root` 配下でない場合は
/// `AppError::Validation` (path injection 防止)、不在は `AppError::NotFound`。
#[tauri::command]
pub fn core_backup_delete(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    state.backup.delete(&PathBuf::from(path))
}

/// バックアップファイルの整合性検証 (`PRAGMA integrity_check`、ADR-0007 §2.4.1)。
/// 不正な path / 破損ファイル / 不在は `AppError`。リストア前に必ず呼ぶ。
#[tauri::command]
pub fn core_backup_verify(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    state.backup.verify_integrity(&PathBuf::from(path))
}

/// バックアップを restore する (`data-model.md` §13.6 / ADR-0007 §2.4)。
///
/// 手順 (本コマンド内で実行):
/// 1. 整合性検証 (`verify_integrity`)
/// 2. **pre-restore バックアップ取得** (失敗したら restore 中止)
/// 3. アクティブ DB に書き戻し (`restore_from`)
///
/// 完了後の **アプリ再起動はユーザーに促す** (`data-model.md` §13.6 step 7)。
/// フロント側は本コマンドが Ok を返したら「再起動してください」モーダルを出す責務。
#[tauri::command]
pub fn core_backup_restore(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let src_path = PathBuf::from(path);
    // 1. 整合性チェック (失敗したら restore 中止)
    state.backup.verify_integrity(&src_path)?;
    // 2. pre-restore バックアップ取得 (失敗したら restore 中止)
    state.backup.take(BackupKind::PreOp {
        prefix: "pre-restore".into(),
    })?;
    // 3. アクティブ DB に書き戻し
    state.backup.restore_from(&src_path)?;
    Ok(())
}
