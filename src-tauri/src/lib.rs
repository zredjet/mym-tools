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
//! - 各モジュール本実装 (M-Hash file hash / M-Color / M-LinkMemo / M-Prompt)

pub mod backup;
pub mod commands;
pub mod error;
pub mod exchange;
pub mod module;
pub mod modules;
pub mod operations;
pub mod state;
pub mod storage;
pub mod time;

use std::sync::Arc;

use tauri::Manager;

use crate::backup::{BackupKind, BackupService, LocalBackupService};
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

            // SQLite を開いて schema 整合性チェック (`data-model.md` §4 / §13)
            let storage: Arc<dyn StorageService> = Arc::new(
                SqliteStorage::open(&db_path)
                    .map_err(|e| format!("failed to open SQLite at {}: {e}", db_path.display()))?,
            );

            // バックアップサービス (ADR-0007)
            let backup: Arc<dyn BackupService> =
                Arc::new(LocalBackupService::new(backups_root, Arc::clone(&storage)));

            // 起動時 auto バックアップ判定 (`data-model.md` §13.3): 24h 経過 + revision 変化
            // 取得は短時間 (~数百 ms) のため起動 setup 内で同期実行。失敗してもアプリは
            // 起動し、エラーは tracing で残す (UI には次回起動時に再判定で再試行される)
            try_take_auto_backup(backup.as_ref());

            // モジュールレジストリ + storage + backup → AppState (`module-contract.md` §2)
            let backends = modules::registry::module_backends();
            let app_state = AppState::build(backends, storage, backup)
                .map_err(|e| format!("AppState::build failed: {e}"))?;
            app.manage(app_state);
            Ok(())
        });
    let builder = modules::registry::register_invoke_handler(builder);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
