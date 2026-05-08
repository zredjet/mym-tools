//! 横断検索 Tauri コマンド (`StorageService::search`、`data-model.md` §8)。
//!
//! `core_search` の `scope` 引数は `SearchScope` (`{type: "project", project_id}` /
//! `{type: "global"}` の discriminated union)。`module_filter` は string 配列で渡され、
//! 空配列または `None` は全モジュール対象。

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;
use crate::storage::types::{Item, SearchScope};

/// 検索 API。3 文字未満は LIKE フォールバック (`data-model.md` §8.1)。
#[tauri::command]
pub fn core_search(
    state: State<'_, AppState>,
    scope: SearchScope,
    query: String,
    module_filter: Option<Vec<String>>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Item>, AppError> {
    state
        .storage
        .search(&scope, &query, module_filter.as_deref(), limit, offset)
}
