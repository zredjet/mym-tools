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

pub mod commands;
pub mod error;
pub mod module;
pub mod modules;
pub mod operations;
pub mod state;
pub mod storage;
pub mod time;

use std::sync::Arc;

use tauri::Manager;

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
        .setup(|app| {
            // ユーザーデータディレクトリ解決 (`architecture.md` §8 / `data-model.md` §2)
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app_data_dir: {e}"))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("failed to create data dir {}: {e}", data_dir.display()))?;
            let db_path = data_dir.join("data.sqlite");

            // SQLite を開いて schema 整合性チェック (`data-model.md` §4 / §13)
            let storage: Arc<dyn StorageService> = Arc::new(
                SqliteStorage::open(&db_path)
                    .map_err(|e| format!("failed to open SQLite at {}: {e}", db_path.display()))?,
            );

            // モジュールレジストリ + storage → AppState (`module-contract.md` §2)
            let backends = modules::registry::module_backends();
            let app_state = AppState::build(backends, storage)
                .map_err(|e| format!("AppState::build failed: {e}"))?;
            app.manage(app_state);
            Ok(())
        });
    let builder = modules::registry::register_invoke_handler(builder);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
