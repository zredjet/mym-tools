//! `settings.json` の永続化境界 (`docs/data-model.md` §11)。
//!
//! - 未作成時は schema v1 の既定文書を返す
//! - 未知キーは `serde_json::Value` のまま保持する
//! - 保存は `settings.json.tmp` へ書いて flush / sync 後に原子的に置換する

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value as JsonValue};

use crate::error::AppError;

pub const CURRENT_SETTINGS_SCHEMA_VERSION: u64 = 1;

/// Tauri の managed state。ファイルI/O境界をテスト可能な型として分離する。
pub struct SettingsState {
    pub service: LocalSettingsService,
}

impl SettingsState {
    pub fn new(path: PathBuf) -> Self {
        Self {
            service: LocalSettingsService::new(path),
        }
    }
}

/// ローカル `settings.json` の読み書きサービス。
pub struct LocalSettingsService {
    path: PathBuf,
    writer: Mutex<()>,
}

impl LocalSettingsService {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            writer: Mutex::new(()),
        }
    }

    pub fn load(&self) -> Result<JsonValue, AppError> {
        if !self.path.exists() {
            return Ok(default_settings_document());
        }
        let bytes = fs::read(&self.path)?;
        let document: JsonValue =
            serde_json::from_slice(&bytes).map_err(|e| AppError::Validation {
                module_id: "core.settings".into(),
                reason: format!("settings.json parse error: {e}"),
            })?;
        validate_document(&document)?;
        Ok(document)
    }

    pub fn save(&self, document: &JsonValue) -> Result<(), AppError> {
        validate_document(document)?;
        let _guard = self
            .writer
            .lock()
            .map_err(|_| AppError::Internal("settings writer mutex poisoned".into()))?;
        let parent = self.path.parent().ok_or_else(|| {
            AppError::Io(format!(
                "settings path has no parent: {}",
                self.path.display()
            ))
        })?;
        fs::create_dir_all(parent)?;

        let temp_path = temp_path_for(&self.path);
        let result = (|| -> Result<(), AppError> {
            let mut file = File::create(&temp_path)?;
            serde_json::to_writer_pretty(&mut file, document)
                .map_err(|e| AppError::Io(format!("settings serialization failed: {e}")))?;
            file.write_all(b"\n")?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            replace_atomically(&temp_path, &self.path)?;
            sync_parent_directory(parent)?;
            Ok(())
        })();

        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        result
    }
}

pub fn default_settings_document() -> JsonValue {
    json!({
        "schema_version": CURRENT_SETTINGS_SCHEMA_VERSION,
        "core": {
            "theme": "system",
            "default_project_id": null,
            "last_opened_project_id": null,
            "last_opened_module_id": null,
            "search": { "default_scope": "project" },
            "log_level": "info",
            "sidebar_width": 240,
            "ui_scale": 1.0,
            "row_density": "compact",
            "module_enabled": {}
        },
        "modules": {}
    })
}

fn validate_document(document: &JsonValue) -> Result<(), AppError> {
    let object = document.as_object().ok_or_else(|| AppError::Validation {
        module_id: "core.settings".into(),
        reason: "settings root must be a JSON object".into(),
    })?;
    let version = object
        .get("schema_version")
        .and_then(JsonValue::as_u64)
        .ok_or_else(|| AppError::Validation {
            module_id: "core.settings".into(),
            reason: "settings.schema_version must be an integer".into(),
        })?;
    if version != CURRENT_SETTINGS_SCHEMA_VERSION {
        return Err(AppError::Validation {
            module_id: "core.settings".into(),
            reason: format!(
                "unsupported settings schema_version: {version} (this build accepts {CURRENT_SETTINGS_SCHEMA_VERSION})"
            ),
        });
    }
    if object.get("core").is_some_and(|value| !value.is_object()) {
        return Err(AppError::Validation {
            module_id: "core.settings".into(),
            reason: "settings.core must be an object".into(),
        });
    }
    if object
        .get("modules")
        .is_some_and(|value| !value.is_object())
    {
        return Err(AppError::Validation {
            module_id: "core.settings".into(),
            reason: "settings.modules must be an object".into(),
        });
    }
    Ok(())
}

fn temp_path_for(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(not(windows))]
fn replace_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        return fs::rename(source, destination);
    }
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: 両パスは終端NUL付きで、この呼び出し中はバッファが生存している。
    let success = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            source_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn load_missing_file_returns_default_document() {
        let dir = tempfile::tempdir().unwrap();
        let service = LocalSettingsService::new(dir.path().join("settings.json"));

        let loaded = service.load().unwrap();

        assert_eq!(loaded["schema_version"], 1);
        assert_eq!(loaded["core"]["theme"], "system");
        assert_eq!(
            loaded["core"]["last_opened_project_id"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn save_then_load_round_trips_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let service = LocalSettingsService::new(path.clone());
        let document = json!({
            "schema_version": 1,
            "core": { "theme": "dark", "future_core_key": 42 },
            "modules": { "future-module": { "custom": true } },
            "future_root_key": { "keep": "me" }
        });

        service.save(&document).unwrap();

        assert_eq!(service.load().unwrap(), document);
        assert!(!temp_path_for(&path).exists());
    }

    #[test]
    fn load_rejects_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{broken").unwrap();
        let service = LocalSettingsService::new(path);

        let error = service.load().unwrap_err();

        assert!(matches!(error, crate::error::AppError::Validation { .. }));
    }

    #[test]
    fn load_rejects_future_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schema_version": 2,
                "core": {},
                "modules": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let service = LocalSettingsService::new(path);

        let error = service.load().unwrap_err();

        assert!(matches!(error, crate::error::AppError::Validation { .. }));
    }
}
