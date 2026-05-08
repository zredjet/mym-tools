//! プロジェクト CRUD の Tauri コマンド (`core_*` 命名規則)。
//!
//! `StorageService` の project メソッドをそのまま IPC 露出する薄いラッパー。
//! 重い処理はないため `#[tauri::command]` を `async` にせず同期で受ける
//! (`with_conn` の writer mutex は数 ms オーダ)。
//!
//! `module-contract.md` §6.2: `core_*` はモジュール UI からの直呼び禁止。Shell の
//! ProjectList / ProjectCreateDialog 等からのみ呼ばれる想定。

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;
use crate::storage::types::{Project, ProjectId};

/// 全プロジェクトを `position ASC, id DESC` 順で返す (`StorageService::list_projects`)。
#[tauri::command]
pub fn core_list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, AppError> {
    state.storage.list_projects()
}

/// プロジェクトを 1 件取得。`AppError::NotFound` の可能性あり。
#[tauri::command]
pub fn core_get_project(state: State<'_, AppState>, id: String) -> Result<Project, AppError> {
    state.storage.get_project(&ProjectId::new(id))
}

/// 新規プロジェクトを作成 (UUID v4 + position は末尾追加)。
#[tauri::command]
pub fn core_create_project(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> Result<Project, AppError> {
    state.storage.create_project(&name, description.as_deref())
}

/// プロジェクトの `name` / `description` を更新する。
#[tauri::command]
pub fn core_update_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
) -> Result<(), AppError> {
    state
        .storage
        .update_project(&ProjectId::new(id), &name, description.as_deref())
}

/// プロジェクトを物理削除する (配下 items は FK CASCADE で消える)。
#[tauri::command]
pub fn core_delete_project(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.storage.delete_project(&ProjectId::new(id))
}
