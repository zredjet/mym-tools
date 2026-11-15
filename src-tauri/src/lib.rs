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
        .plugin(tauri_plugin_shell::init());
    // Tauri installs a default menu only on macOS. Keep Windows without a menu bar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            // The default macOS Quit action terminates without requesting a
            // window close. Route Cmd+Q through the same unsaved-document guard.
            if let Some(tauri::menu::MenuItemKind::Submenu(application)) = menu.items()?.first() {
                let count = application.items()?.len();
                if count > 0 {
                    application.remove_at(count - 1)?;
                    application.append(&tauri::menu::MenuItem::with_id(
                        app,
                        "mym-close",
                        "終了",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?)?;
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "mym-close" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
        });
    let builder = builder.setup(|app| {
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
        storage::bootstrap::migrate_if_needed(&db_path, &backups_root)
            .map_err(|e| format!("DB schema migration failed for {}: {e}", db_path.display()))?;

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

        // payload の版を上げたモジュールに古い版の行があれば、最初の変換 (Eager-on-Read) の前に
        // pre-op backup を 1 回取る (ADR-0027)。変換は戻せず、旧版のアプリは新しい版の行を読めない
        // ため。失敗したら pre-migration と同じく起動を止める
        let backends = modules::registry::module_backends();
        take_payload_upgrade_backups(sqlite_storage.as_ref(), &backends, |prefix| {
            backup
                .take(BackupKind::PreOp {
                    prefix: prefix.to_string(),
                })
                .map(|_| ())
        })
        .map_err(|e| format!("backup before payload upgrade failed: {e}"))?;

        // 起動時 auto バックアップ判定 (`data-model.md` §13.3): 24h 経過 + revision 変化
        // 取得は短時間 (~数百 ms) のため起動 setup 内で同期実行。失敗してもアプリは
        // 起動し、エラーは tracing で残す (UI には次回起動時に再判定で再試行される)
        try_take_auto_backup(backup.as_ref());

        // モジュールレジストリ + storage + backup → AppState (`module-contract.md` §2)
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

/// payload の引き上げ前のバックアップ (`pre-payload-<module_id>-v<版>`) のファイル名の prefix。
fn payload_upgrade_backup_prefix(module_id: &str, version: u32) -> String {
    format!("pre-payload-{module_id}-v{version}")
}

/// payload の版を上げたモジュールに古い版の行があり、その版への引き上げのためのバックアップを
/// まだ取っていなければ、pre-op backup を 1 回取って `meta` に記録する (ADR-0027)。
///
/// - 記録 (`meta.payload_upgrade_backup.<module_id>`) が今の版以上なら、行を調べずに飛ばす
/// - 古い版の行が無ければ取らない (記録もしない。後から古い行が入ることは、取込が変換してから
///   書くので無い。旧版のバックアップをリストアした後は、次の起動で取り直す)
/// - 変換できない行は古い版のまま残るので、記録が無いと起動のたびに取ることになる。そのための記録
/// - stateless モジュールは行を持たないので見ない
///
/// 戻り値は取ったバックアップの prefix。失敗は呼び出し側が起動の失敗にする。
fn take_payload_upgrade_backups(
    storage: &SqliteStorage,
    modules: &[Arc<dyn module::ModuleBackend>],
    mut take_backup: impl FnMut(&str) -> Result<(), AppError>,
) -> Result<Vec<String>, AppError> {
    let mut taken = Vec::new();
    for module in modules.iter().filter(|m| !m.is_stateless()) {
        let module_id = module.id();
        let current = module.current_payload_version();
        if storage.payload_upgrade_backup_version(module_id)? >= current {
            continue;
        }
        if !storage.has_items_older_than(module_id, current)? {
            continue;
        }
        let prefix = payload_upgrade_backup_prefix(module_id, current);
        take_backup(&prefix)?;
        storage.set_payload_upgrade_backup_version(module_id, current)?;
        tracing::info!(
            module_id,
            version = current,
            "backup taken before payload upgrade"
        );
        taken.push(prefix);
    }
    Ok(taken)
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

    /// 版だけを持つテスト用のモジュール
    struct Versioned(&'static str, u32);
    impl module::ModuleBackend for Versioned {
        fn id(&self) -> &'static str {
            self.0
        }
        fn current_payload_version(&self) -> u32 {
            self.1
        }
    }

    struct Stateless;
    impl module::ModuleBackend for Stateless {
        fn id(&self) -> &'static str {
            "hash"
        }
        fn is_stateless(&self) -> bool {
            true
        }
    }

    fn insert(storage: &SqliteStorage, module_id: &str, version: u32) {
        let project = storage.create_project("Project", None).unwrap();
        storage
            .create_item(
                module_id,
                &project.id,
                "Item",
                &[],
                version,
                &json!({}),
                "Item",
            )
            .unwrap();
    }

    #[test]
    fn backup_is_taken_once_before_the_first_payload_upgrade() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        insert(&storage, "vector", 1);
        insert(&storage, "memo", 1);
        let modules: Vec<Arc<dyn module::ModuleBackend>> = vec![
            Arc::new(Versioned("vector", 2)),
            Arc::new(Versioned("memo", 1)),
            Arc::new(Stateless),
        ];
        let revision = storage.data_revision().unwrap();
        let mut prefixes = Vec::new();
        let taken = take_payload_upgrade_backups(&storage, &modules, |prefix| {
            prefixes.push(prefix.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(taken, vec!["pre-payload-vector-v2".to_string()]);
        assert_eq!(prefixes, taken);
        assert_eq!(storage.payload_upgrade_backup_version("vector").unwrap(), 2);
        assert_eq!(storage.payload_upgrade_backup_version("memo").unwrap(), 0);
        // 記録は内容の変更ではない
        assert_eq!(storage.data_revision().unwrap(), revision);

        // 変換できない行が v1 のまま残っていても、2 回目からは取らない
        let taken = take_payload_upgrade_backups(&storage, &modules, |_| {
            panic!("backup must not be taken twice")
        })
        .unwrap();
        assert!(taken.is_empty());

        // 次に版を上げたときは、その版のためにもう一度取る
        let modules: Vec<Arc<dyn module::ModuleBackend>> = vec![Arc::new(Versioned("vector", 3))];
        let taken = take_payload_upgrade_backups(&storage, &modules, |_| Ok(())).unwrap();
        assert_eq!(taken, vec!["pre-payload-vector-v3".to_string()]);
        assert_eq!(storage.payload_upgrade_backup_version("vector").unwrap(), 3);
    }

    #[test]
    fn no_backup_without_rows_to_upgrade() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        insert(&storage, "vector", 2);
        insert(&storage, "color", 1);
        let modules: Vec<Arc<dyn module::ModuleBackend>> = vec![
            Arc::new(Versioned("vector", 2)),
            Arc::new(Versioned("prompt", 2)),
        ];
        let taken =
            take_payload_upgrade_backups(&storage, &modules, |_| panic!("nothing to upgrade"))
                .unwrap();
        assert!(taken.is_empty());
        assert_eq!(storage.payload_upgrade_backup_version("vector").unwrap(), 0);
        assert_eq!(storage.payload_upgrade_backup_version("prompt").unwrap(), 0);
    }

    #[test]
    fn failed_backup_is_not_recorded_and_stops_startup() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        insert(&storage, "vector", 1);
        let modules: Vec<Arc<dyn module::ModuleBackend>> = vec![Arc::new(Versioned("vector", 2))];
        let result = take_payload_upgrade_backups(&storage, &modules, |_| {
            Err(AppError::Io("disk full".into()))
        });
        assert!(matches!(result, Err(AppError::Io(_))));
        assert_eq!(storage.payload_upgrade_backup_version("vector").unwrap(), 0);
        // 次の起動でもう一度試す
        let taken = take_payload_upgrade_backups(&storage, &modules, |_| Ok(())).unwrap();
        assert_eq!(taken.len(), 1);
    }

    #[test]
    fn payload_upgrade_backup_reaches_the_backup_directory() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Arc::new(SqliteStorage::open(dir.path().join("data.sqlite")).unwrap());
        insert(storage.as_ref(), "vector", 1);
        let backup = LocalBackupService::new(
            dir.path().join("backups"),
            Arc::clone(&storage) as Arc<dyn StorageService>,
        );
        let modules: Vec<Arc<dyn module::ModuleBackend>> =
            vec![Arc::new(modules::vector::VectorModule)];
        take_payload_upgrade_backups(storage.as_ref(), &modules, |prefix| {
            backup
                .take(BackupKind::PreOp {
                    prefix: prefix.to_string(),
                })
                .map(|_| ())
        })
        .unwrap();
        let records = backup.list().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].kind,
            BackupKind::PreOp {
                prefix: "pre-payload-vector-v2".into()
            }
        );
        // バックアップの中の行は v1 のまま (変換の前の控え)
        let copy = SqliteStorage::open(&records[0].path).unwrap();
        assert!(copy.has_items_older_than("vector", 2).unwrap());
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
