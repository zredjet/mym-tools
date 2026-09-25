//! プロジェクト CRUD の Tauri コマンド (`core_*` 命名規則)。
//!
//! `StorageService` の project メソッドをそのまま IPC 露出する薄いラッパー。
//! 処理は短いが、import / restore 等の長い操作と `data_lock` で排他するため、
//! 他の core コマンドと同じく `async` + `run_storage` で実行する。
//!
//! `module-contract.md` §6.2: `core_*` はモジュール UI からの直呼び禁止。Shell の
//! ProjectList / ProjectCreateDialog 等からのみ呼ばれる想定。

use std::sync::Arc;

use tauri::State;

use crate::backup::{BackupKind, BackupService};
use crate::commands::{run_storage, LockMode};
use crate::error::AppError;
use crate::state::AppState;
use crate::storage::types::{Project, ProjectId};
use crate::storage::StorageService;

/// 全プロジェクトを `position ASC, id DESC` 順で返す (`StorageService::list_projects`)。
#[tauri::command]
pub async fn core_list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, AppError> {
    let storage = Arc::clone(&state.storage);
    run_storage(&state, LockMode::Shared, move || storage.list_projects()).await
}

/// プロジェクトを 1 件取得。`AppError::NotFound` の可能性あり。
#[tauri::command]
pub async fn core_get_project(state: State<'_, AppState>, id: String) -> Result<Project, AppError> {
    let storage = Arc::clone(&state.storage);
    run_storage(&state, LockMode::Shared, move || {
        storage.get_project(&ProjectId::new(id))
    })
    .await
}

/// 新規プロジェクトを作成 (UUID v4 + position は末尾追加)。
#[tauri::command]
pub async fn core_create_project(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> Result<Project, AppError> {
    let storage = Arc::clone(&state.storage);
    run_storage(&state, LockMode::Shared, move || {
        storage.create_project(&name, description.as_deref())
    })
    .await
}

/// プロジェクトの `name` / `description` を更新する。
#[tauri::command]
pub async fn core_update_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    run_storage(&state, LockMode::Shared, move || {
        storage.update_project(&ProjectId::new(id), &name, description.as_deref())
    })
    .await
}

/// プロジェクトを物理削除する (配下 items は FK CASCADE で消える)。
///
/// 削除前に `pre-delete-project-<id>` の pre-op バックアップを **必ず** 取る
/// (`data-model.md` §13.4)。バックアップに失敗したら削除しない。
#[tauri::command]
pub async fn core_delete_project(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    let backup = Arc::clone(&state.backup);
    // pre-delete バックアップ取得から削除までを 1 つの Exclusive 区間で行う
    run_storage(&state, LockMode::Exclusive, move || {
        delete_project_with_backup(storage.as_ref(), backup.as_ref(), &ProjectId::new(id))
    })
    .await
}

fn delete_project_with_backup(
    storage: &dyn StorageService,
    backup: &dyn BackupService,
    id: &ProjectId,
) -> Result<(), AppError> {
    // 不在 ID でバックアップだけが増えないよう、存在確認を先に行う
    storage.get_project(id)?;
    backup.take(BackupKind::PreOp {
        prefix: pre_delete_project_prefix(id),
    })?;
    storage.delete_project(id)
}

/// `pre-delete-project-<projectId>` を作る。ID は import 由来の任意文字列もあり得るため、
/// ファイル名に安全な文字 (`[A-Za-z0-9_-]`) 以外は `_` に置き換え、長さも抑える。
fn pre_delete_project_prefix(id: &ProjectId) -> String {
    let safe: String = id
        .as_str()
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("pre-delete-project-{safe}")
}

/// プロジェクトの表示順 (`position`) を `ordered_ids` の順序で再付番する (D&D 並び替え)。
///
/// `ordered_ids` には **既存全プロジェクトの ID が過不足なく含まれている** 必要がある
/// (欠損 / 余分 / 未知 / 重複は `AppError::Validation`)。これにより stale state からの
/// 偶発的 reorder を弾き、安全性を担保する (`StorageService::reorder_projects` 参照)。
#[tauri::command]
pub async fn core_reorder_projects(
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    run_storage(&state, LockMode::Shared, move || {
        let ids: Vec<ProjectId> = ordered_ids.into_iter().map(ProjectId::new).collect();
        storage.reorder_projects(&ids)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::backup::LocalBackupService;
    use crate::storage::sqlite::SqliteStorage;

    fn setup() -> (
        tempfile::TempDir,
        Arc<dyn StorageService>,
        LocalBackupService,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let storage: Arc<dyn StorageService> =
            Arc::new(SqliteStorage::open(temp.path().join("data.sqlite")).unwrap());
        let backup = LocalBackupService::new(temp.path().join("backups"), Arc::clone(&storage));
        (temp, storage, backup)
    }

    #[test]
    fn delete_project_takes_pre_delete_backup_first() {
        let (_temp, storage, backup) = setup();
        let project = storage.create_project("To Delete", None).unwrap();

        delete_project_with_backup(storage.as_ref(), &backup, &project.id).unwrap();

        assert!(matches!(
            storage.get_project(&project.id),
            Err(AppError::NotFound { .. })
        ));
        let records = backup.list().unwrap();
        let expected = format!("pre-delete-project-{}", project.id.as_str());
        let record = records
            .iter()
            .find(|r| {
                r.kind
                    == BackupKind::PreOp {
                        prefix: expected.clone(),
                    }
            })
            .expect("pre-delete-project backup should be listed");
        // バックアップには削除前のプロジェクトが残っている
        let conn = rusqlite::Connection::open(&record.path).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id = ?",
                [project.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn delete_missing_project_takes_no_backup() {
        let (_temp, storage, backup) = setup();
        let result = delete_project_with_backup(
            storage.as_ref(),
            &backup,
            &ProjectId::new("missing".to_string()),
        );
        assert!(matches!(result, Err(AppError::NotFound { .. })));
        assert!(backup.list().unwrap().is_empty());
    }

    #[test]
    fn pre_delete_prefix_sanitizes_unsafe_ids() {
        assert_eq!(
            pre_delete_project_prefix(&ProjectId::new("../a/b c".to_string())),
            "pre-delete-project-___a_b_c"
        );
    }
}
