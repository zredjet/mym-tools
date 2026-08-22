//! `settings.json` 用 Tauri コマンド (`docs/data-model.md` §11)。

use serde_json::Value as JsonValue;
use tauri::State;

use crate::error::AppError;
use crate::settings::SettingsState;

#[tauri::command]
pub fn core_get_settings(state: State<'_, SettingsState>) -> Result<JsonValue, AppError> {
    state.service.load()
}

#[tauri::command]
pub fn core_update_settings(
    state: State<'_, SettingsState>,
    settings: JsonValue,
) -> Result<(), AppError> {
    state.service.save(&settings)
}
