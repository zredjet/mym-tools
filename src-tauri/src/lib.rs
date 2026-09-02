//! MyMyTools のエントリポイント (`architecture.md` §2)。
//!
//! - Tauri `setup` フック内で `app_data_dir()` を解決し `data.sqlite` を開く
//!   (`architecture.md` §8 / `data-model.md` §2: ユーザーデータ物理分離)
//! - `modules::registry::module_backends()` + `SqliteStorage` から `AppState::build`
//! - `app.manage(state)` で共有状態として登録 (`module-contract.md` §5.1)
//! - `modules::registry::register_invoke_handler` が `generate_handler!` で各モジュールの
//!   `#[tauri::command]` を集中登録する (ADR-0004 §5.1)
//!
//! 後続フェーズで:
//! - items CRUD (ScopedStorage) + Eager-on-Read (ADR-0006)
//! - Backup 3 系統 (ADR-0007)
//! - 各モジュール本実装 (M-Hash file hash / M-Color / M-Link / M-Memo / M-Prompt)

pub mod backup;
pub mod commands;
pub mod error;
pub mod exchange;
pub mod module;
pub mod modules;
pub mod operations;
pub mod settings;
pub mod state;
pub mod storage;
pub mod time;

use std::sync::Arc;

use tauri::Manager;

use crate::backup::{BackupKind, BackupService, LocalBackupService};
use crate::error::AppError;
use crate::settings::SettingsState;
use crate::state::AppState;
use crate::storage::{SqliteStorage, StorageService};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// `tauri::generate_context!()` マクロがコンパイル時にスレッド生成プリミティブへ展開するため、
// clippy.toml の disallowed-methods (ADR-0009 R-2) が誤検知する。フレームワーク内部の
// スレッド生成でありユーザーコードの規約違反ではないため局所的に許可する。
// 直接スレッドを生成するユーザーコードは ADR-0010 §2.5 の grep fallback で検出される。
#[allow(clippy::disallowed_methods)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // ユーザーデータディレクトリ解決 (`architecture.md` §8 / `data-model.md` §2)
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app_data_dir: {e}"))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("failed to create data dir {}: {e}", data_dir.display()))?;
            let db_path = data_dir.join("data.sqlite");
            let backups_root = data_dir.join("backups");
            let settings_path = data_dir.join("settings.json");

            // DB schema migration を **SqliteStorage::open の外** で実行する
            // (ADR-0011 §2.4 bootstrap 経路 — `LocalBackupService` は完成済 storage を要求するため、
            // 鶏卵問題を回避するために独立ヘルパで pre-migration backup を取得 + 適用)。
            // 新規 DB / 既に最新版 / 未来版 (= unsupported) は no-op。失敗時は起動停止。
            storage::bootstrap::migrate_if_needed(&db_path, &backups_root).map_err(|e| {
                format!("DB schema migration failed for {}: {e}", db_path.display())
            })?;

            // SQLite を開いて schema 整合性チェック (`data-model.md` §4 / §13)
            // migration が走った後なので、`verify_schema_version` は CURRENT と一致する想定
            let sqlite_storage = Arc::new(
                SqliteStorage::open(&db_path)
                    .map_err(|e| format!("failed to open SQLite at {}: {e}", db_path.display()))?,
            );
            let storage: Arc<dyn StorageService> = sqlite_storage.clone();

            // バックアップサービス (ADR-0007)
            let backup: Arc<dyn BackupService> =
                Arc::new(LocalBackupService::new(backups_root, Arc::clone(&storage)));

            // Link / Memo 分離前の単独 Memo がある場合だけ pre-op backup を取得し、
            // 成功後に所属移行する。失敗は既存の setup 起動失敗経路へ返す。
            migrate_linkmemo_split_with_backup(sqlite_storage.as_ref(), || {
                backup
                    .take(BackupKind::PreOp {
                        prefix: "pre-split-linkmemo".into(),
                    })
                    .map(|_| ())
            })
            .map_err(|e| format!("Link / Memo data migration failed: {e}"))?;

            // 起動時 auto バックアップ判定 (`data-model.md` §13.3): 24h 経過 + revision 変化
            // 取得は短時間 (~数百 ms) のため起動 setup 内で同期実行。失敗してもアプリは
            // 起動し、エラーは tracing で残す (UI には次回起動時に再判定で再試行される)
            try_take_auto_backup(backup.as_ref());

            // モジュールレジストリ + storage + backup → AppState (`module-contract.md` §2)
            let backends = modules::registry::module_backends();
            let app_state = AppState::build(backends, storage, backup)
                .map_err(|e| format!("AppState::build failed: {e}"))?;
            app.manage(app_state);
            app.manage(SettingsState::new(settings_path));
            Ok(())
        });
    let builder = modules::registry::register_invoke_handler(builder);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn migrate_linkmemo_split_with_backup(
    storage: &SqliteStorage,
    take_backup: impl FnOnce() -> Result<(), AppError>,
) -> Result<usize, AppError> {
    let count = storage.legacy_linkmemo_memo_count()?;
    if count == 0 {
        return Ok(0);
    }
    take_backup()?;
    let moved = storage.migrate_legacy_linkmemo_memos()?;
    if moved != count {
        return Err(AppError::Storage(format!(
            "legacy memo count changed during startup migration: expected {count}, moved {moved}"
        )));
    }
    tracing::info!(moved, "legacy LinkMemo rows migrated to Memo module");
    Ok(moved)
}

/// 起動時の auto バックアップ判定 + 取得 (`data-model.md` §13.3 / ADR-0007 §2.3)。
///
/// ベストエフォート: いずれの段階で失敗してもアプリ起動は継続する (エラーは tracing
/// に記録するのみ)。次回起動時の判定で `data_revision != last_backup_revision` がまだ
/// 成り立つため自動的にリトライされる (ADR-0007 §4.2 「失敗時はトーストで通知 + ログ。
/// 再試行は次回起動時に自然に行われる」)。
fn try_take_auto_backup(backup: &dyn BackupService) {
    match backup.should_take_auto() {
        Ok(false) => {}
        Ok(true) => match backup.take(BackupKind::Auto) {
            Ok(record) => {
                tracing::info!(
                    path = %record.path.display(),
                    revision = record.data_revision,
                    "auto backup taken at startup"
                );
            }
            Err(e) => {
                tracing::error!(error = %e, "startup auto backup failed; will retry next launch");
            }
        },
        Err(e) => {
            tracing::error!(error = %e, "should_take_auto check failed");
        }
    }
}

#[cfg(test)]
mod startup_data_migration_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn backup_failure_prevents_linkmemo_split() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        let project = storage.create_project("Project", None).unwrap();
        storage
            .create_item(
                "linkmemo",
                &project.id,
                "Legacy",
                &[],
                1,
                &json!({"type":"memo","target":null,"body":"body"}),
                "Legacy body",
            )
            .unwrap();

        let result = migrate_linkmemo_split_with_backup(&storage, || {
            Err(AppError::Io("backup failed".into()))
        });
        assert!(matches!(result, Err(AppError::Io(_))));
        assert_eq!(storage.legacy_linkmemo_memo_count().unwrap(), 1);
        assert!(storage
            .list_items("memo", &project.id, 100, 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn no_legacy_rows_skip_backup() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        let called = std::cell::Cell::new(false);
        assert_eq!(
            migrate_linkmemo_split_with_backup(&storage, || {
                called.set(true);
                Ok(())
            })
            .unwrap(),
            0
        );
        assert!(!called.get());
    }
}
