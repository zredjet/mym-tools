//! バックアップの Tauri コマンド (`core_backup_*`、ADR-0007 / `data-model.md` §13)。
//!
//! `BackupService` の薄いラッパー。`module-contract.md` §6.2 に従い `core_*` 命名。
//! Settings 画面 (C-7 / C-8) からのみ呼ばれる想定で、モジュール UI からは呼ばない。
//!
//! ## 排他関係 (`data-model.md` §13.7 / ADR-0009 §1 表)
//!
//! 全コマンド `async` で、実処理は `run_storage` (`spawn_blocking`) で実行する
//! (DB サイズ次第で数秒かかり、メインスレッドで動かすと UI が固まるため)。キャンセルは非対応。
//!
//! - 取得 (`take_*`) / リストア: `LockMode::Exclusive`。import 等の途中の DB を
//!   取得・上書きしない。リストア完了後はユーザーがアプリを手動再起動する想定
//!   (data-model.md §13.6 step 7)
//! - 一覧 / 削除 / 整合性検証 / auto 判定: `LockMode::Shared`

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::backup::{BackupKind, BackupRecord};
use crate::commands::{run_storage, LockMode};
use crate::error::AppError;
use crate::state::AppState;

/// auto バックアップが必要か判定する (`data-model.md` §13.3):
/// `data_revision != last_backup_revision` AND 24h 経過 (or 未取得)。
#[tauri::command]
pub async fn core_backup_should_take_auto(state: State<'_, AppState>) -> Result<bool, AppError> {
    let backup = Arc::clone(&state.backup);
    run_storage(&state, LockMode::Shared, move || backup.should_take_auto()).await
}

/// 全バックアップ (auto / pre-op / manual) を `created_at DESC` 順で返す (UI 一覧用)。
#[tauri::command]
pub async fn core_backup_list(state: State<'_, AppState>) -> Result<Vec<BackupRecord>, AppError> {
    let backup = Arc::clone(&state.backup);
    run_storage(&state, LockMode::Shared, move || backup.list()).await
}

/// auto バックアップを取得する (`should_take_auto` が真のときに呼ぶ。10 件ローテ)。
#[tauri::command]
pub async fn core_backup_take_auto(state: State<'_, AppState>) -> Result<BackupRecord, AppError> {
    let backup = Arc::clone(&state.backup);
    run_storage(&state, LockMode::Exclusive, move || {
        backup.take(BackupKind::Auto)
    })
    .await
}

/// manual バックアップを取得する (ローテーションなし、ユーザーが手動削除)。
#[tauri::command]
pub async fn core_backup_take_manual(state: State<'_, AppState>) -> Result<BackupRecord, AppError> {
    let backup = Arc::clone(&state.backup);
    run_storage(&state, LockMode::Exclusive, move || {
        backup.take(BackupKind::Manual)
    })
    .await
}

/// 指定パスのバックアップを物理削除する。`backups_root` 配下でない場合は
/// `AppError::Validation` (path injection 防止)、不在は `AppError::NotFound`。
#[tauri::command]
pub async fn core_backup_delete(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let backup = Arc::clone(&state.backup);
    run_storage(&state, LockMode::Shared, move || {
        backup.delete(&PathBuf::from(path))
    })
    .await
}

/// バックアップファイルの整合性検証 (`PRAGMA integrity_check`、ADR-0007 §2.4.1)。
/// 不正な path / 破損ファイル / 不在は `AppError`。リストア前に必ず呼ぶ。
#[tauri::command]
pub async fn core_backup_verify(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let backup = Arc::clone(&state.backup);
    run_storage(&state, LockMode::Shared, move || {
        backup.verify_integrity(&PathBuf::from(path))
    })
    .await
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
pub async fn core_backup_restore(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    let backup = Arc::clone(&state.backup);
    // 検証 → pre-restore 取得 → 書き戻しを 1 つの Exclusive 区間で行い、途中に書込みを挟ませない
    run_storage(&state, LockMode::Exclusive, move || {
        let src_path = PathBuf::from(path);
        // 1. 整合性チェック (失敗したら restore 中止)
        backup.verify_integrity(&src_path)?;
        // 2. pre-restore バックアップ取得 (失敗したら restore 中止)
        backup.take(BackupKind::PreOp {
            prefix: "pre-restore".into(),
        })?;
        // 3. アクティブ DB に書き戻し
        backup.restore_from(&src_path)
    })
    .await
}
