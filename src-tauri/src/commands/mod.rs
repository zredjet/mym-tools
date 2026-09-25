//! コア共通の Tauri コマンド (`core_*` 命名規則)。
//!
//! `module-contract.md` §6.2 により、モジュール配下の UI から `core_*` を直接呼ぶことは
//! 禁止されている。Shell や共通フックからのみ呼ばれる想定。

pub mod about;
pub mod backup;
pub mod cancel;
pub mod items;
pub mod projects;
pub mod search;
pub mod settings;
pub mod transfer;

use std::sync::{Arc, PoisonError};

use crate::error::AppError;
use crate::state::AppState;
use crate::storage::scoped::ScopedStorage;

/// `AppState::data_lock` の取り方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LockMode {
    /// 単発の読み書き (item CRUD / 検索 / 一覧)。互いに並行してよい。
    Shared,
    /// 複数ステップの操作 (import / export / restore / バックアップ / project 削除)。
    Exclusive,
}

/// storage を触る処理をメインスレッド外 (`spawn_blocking`) で実行する。
///
/// Tauri 2 は `async` でないコマンドをメインスレッドで実行するため、SQLite / ファイル I/O や
/// 大きな payload (最大 20 MiB の SVG) の検証をそのまま書くと、その間 UI が固まる
/// (ADR-0009 §2.3 R-1)。
pub(crate) async fn run_storage<T, F>(
    state: &AppState,
    mode: LockMode,
    work: F,
) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    let lock = Arc::clone(&state.data_lock);
    tauri::async_runtime::spawn_blocking(move || {
        // 保護対象のデータを持たない lock なので、poison されていても続行してよい
        match mode {
            LockMode::Shared => {
                let _guard = lock.read().unwrap_or_else(PoisonError::into_inner);
                work()
            }
            LockMode::Exclusive => {
                let _guard = lock.write().unwrap_or_else(PoisonError::into_inner);
                work()
            }
        }
    })
    .await?
}

/// `module_id` の `ScopedStorage` を作る。未登録なら `AppError::ModuleNotFound`。
pub(crate) fn scoped_storage(state: &AppState, module_id: &str) -> Result<ScopedStorage, AppError> {
    let module = state
        .module(module_id)
        .ok_or_else(|| AppError::ModuleNotFound {
            module_id: module_id.to_string(),
        })?;
    Ok(Arc::clone(&state.storage).scoped_for(module))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{BackupService, LocalBackupService};
    use crate::storage::{SqliteStorage, StorageService};

    fn test_state() -> (tempfile::TempDir, AppState) {
        let temp = tempfile::tempdir().unwrap();
        let storage: Arc<dyn StorageService> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let backup: Arc<dyn BackupService> = Arc::new(LocalBackupService::new(
            temp.path().join("backups"),
            Arc::clone(&storage),
        ));
        let state = AppState::build(Vec::new(), storage, backup).unwrap();
        (temp, state)
    }

    #[test]
    fn exclusive_work_blocks_other_storage_access() {
        let (_temp, state) = test_state();
        let lock = Arc::clone(&state.data_lock);
        let others_blocked =
            tauri::async_runtime::block_on(run_storage(&state, LockMode::Exclusive, move || {
                Ok(lock.try_read().is_err())
            }))
            .unwrap();
        assert!(others_blocked);
    }

    #[test]
    fn shared_work_allows_readers_but_blocks_exclusive() {
        let (_temp, state) = test_state();
        let lock = Arc::clone(&state.data_lock);
        let (reader_ok, writer_blocked) =
            tauri::async_runtime::block_on(run_storage(&state, LockMode::Shared, move || {
                Ok((lock.try_read().is_ok(), lock.try_write().is_err()))
            }))
            .unwrap();
        assert!(reader_ok);
        assert!(writer_blocked);
    }

    #[test]
    fn run_storage_returns_the_work_error() {
        let (_temp, state) = test_state();
        let result: Result<(), AppError> =
            tauri::async_runtime::block_on(run_storage(&state, LockMode::Shared, || {
                Err(AppError::Storage("boom".into()))
            }));
        assert!(matches!(result, Err(AppError::Storage(message)) if message == "boom"));
    }
}
