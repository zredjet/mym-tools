//! items CRUD の Tauri コマンド (`core_*`、`module-contract.md` §6.2)。
//!
//! `module_id` をフロントから受け取って `state.modules` から `Arc<dyn ModuleBackend>` を引き、
//! `state.storage.scoped_for(module)` で `ScopedStorage` を生成して呼ぶ。
//!
//! `core_get_item` は Eager-on-Read (ADR-0006) を発火する。`core_list_items` は
//! 発火しない (`data-model.md` §7.2)。

use serde_json::Value as JsonValue;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;
use crate::storage::types::{Item, ItemId, ProjectId};

/// プロジェクト内の `module_id` 配下 items を `updated_at DESC, id DESC` 順で取得
/// (`StorageService::list_items`)。Eager-on-Read は発火させない。
#[tauri::command]
pub fn core_list_items(
    state: State<'_, AppState>,
    module_id: String,
    project_id: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<Item>, AppError> {
    let module = state
        .module(&module_id)
        .ok_or_else(|| AppError::ModuleNotFound {
            module_id: module_id.clone(),
        })?;
    let scoped = state.storage.clone().scoped_for(module);
    scoped.list_items(&ProjectId::new(project_id), limit, offset)
}

/// item を 1 件取得 (Eager-on-Read 経由、ADR-0006 / `data-model.md` §7.2)。
#[tauri::command]
pub fn core_get_item(
    state: State<'_, AppState>,
    module_id: String,
    item_id: String,
) -> Result<Item, AppError> {
    let module = state
        .module(&module_id)
        .ok_or_else(|| AppError::ModuleNotFound {
            module_id: module_id.clone(),
        })?;
    let scoped = state.storage.clone().scoped_for(module);
    scoped.get_item(&ItemId::new(item_id))
}

/// 新規 item を作成。`payload` はモジュール固有の JSON でフロントから送られる。
/// `validate_payload` / `index_text` / `current_payload_version` はモジュール側が決める
/// (`ScopedStorage::create_item` 内で実行)。
#[tauri::command]
pub fn core_create_item(
    state: State<'_, AppState>,
    module_id: String,
    project_id: String,
    title: String,
    tags: Vec<String>,
    payload: JsonValue,
) -> Result<ItemId, AppError> {
    let module = state
        .module(&module_id)
        .ok_or_else(|| AppError::ModuleNotFound {
            module_id: module_id.clone(),
        })?;
    let scoped = state.storage.clone().scoped_for(module);
    scoped.create_item(&ProjectId::new(project_id), &title, &tags, payload)
}

/// item を更新 (ユーザー編集)。`data_revision` を **+1**。
#[tauri::command]
pub fn core_update_item(
    state: State<'_, AppState>,
    module_id: String,
    item_id: String,
    title: String,
    tags: Vec<String>,
    payload: JsonValue,
) -> Result<(), AppError> {
    let module = state
        .module(&module_id)
        .ok_or_else(|| AppError::ModuleNotFound {
            module_id: module_id.clone(),
        })?;
    let scoped = state.storage.clone().scoped_for(module);
    scoped.update_item(&ItemId::new(item_id), &title, &tags, payload)
}

/// item を物理削除。
#[tauri::command]
pub fn core_delete_item(
    state: State<'_, AppState>,
    module_id: String,
    item_id: String,
) -> Result<(), AppError> {
    let module = state
        .module(&module_id)
        .ok_or_else(|| AppError::ModuleNotFound {
            module_id: module_id.clone(),
        })?;
    let scoped = state.storage.clone().scoped_for(module);
    scoped.delete_item(&ItemId::new(item_id))
}
