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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::backup::{BackupKind, BackupRecord, BackupService};
use crate::commands::{run_storage, LockMode};
use crate::error::AppError;
use crate::module::ModuleBackend;
use crate::state::AppState;
use crate::storage::StorageService;

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

/// リストアの結果 (`core_backup_restore`)。リストアそのものが成功したときに返す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RestoreOutcome {
    /// 戻した DB の、新しい形式への変換の前のバックアップ (`pre-payload-<module_id>-v<N>`、ADR-0027)
    /// を取れなかった理由。取れた (か要らなかった) なら None。次の起動でもう一度取りにいく
    pub payload_backup_error: Option<String>,
}

/// バックアップを restore する (`data-model.md` §13.6 / ADR-0007 §2.4)。
///
/// 手順 (`restore_backup`):
/// 1. 整合性検証 (`verify_integrity`)
/// 2. **pre-restore バックアップ取得** (失敗したら restore 中止)
/// 3. アクティブ DB に書き戻し (`restore_from`)
/// 4. 戻した DB に、payload の版が古い行があり、その引き上げの前のバックアップの記録が無ければ、
///    起動時と同じく `pre-payload-<module_id>-v<N>` を取る (ADR-0027)。画面は再起動を促すだけで
///    読み込み直して使い続けられるので、次の起動を待たずにここで取る。DB はもう戻してあるので、
///    取れなくてもリストアは成功として返し、理由を `RestoreOutcome` で知らせる (記録は付かないので、
///    次の起動でもう一度取りにいく)
///
/// 完了後の **アプリ再起動はユーザーに促す** (`data-model.md` §13.6 step 7)。
/// フロント側は本コマンドが Ok を返したら「再起動してください」モーダルを出す責務。
#[tauri::command]
pub async fn core_backup_restore(
    state: State<'_, AppState>,
    path: String,
) -> Result<RestoreOutcome, AppError> {
    let backup = Arc::clone(&state.backup);
    let storage = Arc::clone(&state.storage);
    let mut modules: Vec<_> = state.modules.values().cloned().collect();
    modules.sort_by_key(|module| module.id());
    // 検証 → pre-restore 取得 → 書き戻し → 引き上げの前のバックアップを 1 つの Exclusive 区間で行い、
    // 途中に書込み (と Eager-on-Read) を挟ませない
    run_storage(&state, LockMode::Exclusive, move || {
        restore_backup(
            storage.as_ref(),
            backup.as_ref(),
            &modules,
            &PathBuf::from(path),
        )
    })
    .await
}

/// `core_backup_restore` の本体 (テストから同じ経路を通すために分けてある)。
pub(crate) fn restore_backup(
    storage: &dyn StorageService,
    backup: &dyn BackupService,
    modules: &[Arc<dyn ModuleBackend>],
    src_path: &Path,
) -> Result<RestoreOutcome, AppError> {
    // 1. 整合性チェック (失敗したら restore 中止)
    backup.verify_integrity(src_path)?;
    // 2. pre-restore バックアップ取得 (失敗したら restore 中止)
    backup.take(BackupKind::PreOp {
        prefix: "pre-restore".into(),
    })?;
    // 3. アクティブ DB に書き戻し
    backup.restore_from(src_path)?;
    // 4. 引き上げの前のバックアップ (ADR-0027)。失敗はリストアの失敗にしない
    let payload_backup_error = crate::take_payload_upgrade_backups_with(storage, backup, modules)
        .err()
        .map(|error| {
            tracing::error!(error = %error, "backup before payload upgrade failed after restore");
            error.to_string()
        });
    Ok(RestoreOutcome {
        payload_backup_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::LocalBackupService;
    use crate::modules::vector::testing::{module_backends_at, pre_payload_prefix, versions};
    use crate::storage::SqliteStorage;
    use serde_json::json;

    /// 版 `version` の引き上げの前のバックアップの数。版は vector の版の定数か、版が 3 のときの経路を
    /// 確かめる 3 (`versions()`)。
    fn pre_payload_count(root: &Path, version: u32) -> usize {
        let prefix = format!("{}-", pre_payload_prefix(version));
        std::fs::read_dir(root.join("pre-op"))
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                    .filter(|name| name.starts_with(&prefix))
                    .count()
            })
            .unwrap_or(0)
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
        storage: Arc<dyn StorageService>,
        backup: LocalBackupService,
        modules: Vec<Arc<dyn ModuleBackend>>,
        /// 記録の無い (切替前の版で取った) バックアップの代わり。v1 の作品が 1 つある
        old_backup: std::path::PathBuf,
        version: u32,
    }

    fn fixture(version: u32) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backups");
        let storage: Arc<dyn StorageService> =
            Arc::new(SqliteStorage::open(dir.path().join("data.sqlite")).unwrap());
        let backup = LocalBackupService::new(root.clone(), Arc::clone(&storage));
        let project = storage.create_project("P", None).unwrap();
        let v1 = json!({ "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "text": "" });
        storage
            .create_item("vector", &project.id, "古い作品", &[], 1, &v1, "古い作品")
            .unwrap();
        let old_backup = backup.take(BackupKind::Manual).unwrap().path;
        // 新しい版での起動の後 (記録が付いている)
        let modules = module_backends_at(version);
        crate::take_payload_upgrade_backups_with(storage.as_ref(), &backup, &modules).unwrap();
        assert_eq!(pre_payload_count(&root, version), 1);
        Fixture {
            _dir: dir,
            root,
            storage,
            backup,
            modules,
            old_backup,
            version,
        }
    }

    /// 記録の無いバックアップを `core_backup_restore` の本体で戻すと、その場でもう一度取る (ADR-0027)。
    #[test]
    fn restoring_a_backup_without_the_record_takes_the_payload_backup_again() {
        for version in versions() {
            let f = fixture(version);
            std::thread::sleep(std::time::Duration::from_millis(5));
            let outcome =
                restore_backup(f.storage.as_ref(), &f.backup, &f.modules, &f.old_backup).unwrap();
            assert_eq!(outcome.payload_backup_error, None);
            assert_eq!(pre_payload_count(&f.root, f.version), 2);
            assert_eq!(
                f.storage.payload_upgrade_backup_version("vector").unwrap(),
                f.version
            );
        }
    }

    /// 引き上げの前のバックアップを取れなくても、リストアは成功として返し、理由を知らせる。
    /// 記録は付かないので、次の起動でもう一度取りにいく。
    #[test]
    fn restore_succeeds_even_if_the_payload_backup_fails() {
        for version in versions() {
            check_restore_succeeds_even_if_the_payload_backup_fails(fixture(version));
        }
    }

    fn check_restore_succeeds_even_if_the_payload_backup_fails(f: Fixture) {
        // pre-restore は取れて、pre-payload だけが失敗するバックアップサービス
        #[derive(Debug)]
        struct FailingBackup<'a>(&'a LocalBackupService);
        impl BackupService for FailingBackup<'_> {
            fn take(&self, kind: BackupKind) -> Result<BackupRecord, AppError> {
                match &kind {
                    BackupKind::PreOp { prefix } if prefix.starts_with("pre-payload-") => {
                        Err(AppError::Io("disk full".into()))
                    }
                    _ => self.0.take(kind),
                }
            }
            fn should_take_auto(&self) -> Result<bool, AppError> {
                self.0.should_take_auto()
            }
            fn list(&self) -> Result<Vec<BackupRecord>, AppError> {
                self.0.list()
            }
            fn delete(&self, path: &Path) -> Result<(), AppError> {
                self.0.delete(path)
            }
            fn verify_integrity(&self, path: &Path) -> Result<(), AppError> {
                self.0.verify_integrity(path)
            }
            fn restore_from(&self, path: &Path) -> Result<(), AppError> {
                self.0.restore_from(path)
            }
        }
        let outcome = restore_backup(
            f.storage.as_ref(),
            &FailingBackup(&f.backup),
            &f.modules,
            &f.old_backup,
        )
        .unwrap();
        assert!(outcome.payload_backup_error.unwrap().contains("disk full"));
        // DB は戻した中身。記録は付かない
        assert_eq!(
            f.storage.payload_upgrade_backup_version("vector").unwrap(),
            0
        );
        assert!(f.storage.has_items_older_than("vector", f.version).unwrap());
    }
}
