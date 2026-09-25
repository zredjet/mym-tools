//! Export / Import の Tauri コマンド (`core_export_*` / `core_import_*`)。
//!
//! `module-contract.md` §6.2 に従い `core_*` 命名。Settings 画面 (C-7) からのみ
//! 呼ばれる想定で、モジュール UI からは呼ばない。
//!
//! ## ファイル I/O
//!
//! ファイル選択 (save / open ダイアログ) はフロント側 (`@tauri-apps/plugin-dialog`)
//! の責務。本コマンドは **絶対パス文字列を受け取り**、その path で読み書きする。
//! 不正な path (空文字 / 存在しない親 dir 等) は `AppError::Validation` で返す。
//!
//! ## pre-op バックアップ
//!
//! インポートは破壊的操作のため、`core_import_json` が `take_pre_op_backup` を
//! **先に呼んでから** apply_import を実行する (`data-model.md` §12.5)。
//! バックアップ取得失敗時はインポートを中止する (戻り先が無い状態で書き込む方が危険)。

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::backup::BackupKind;
use crate::commands::{run_storage, LockMode};
use crate::error::AppError;
use crate::exchange::{
    apply_import, build_export_data, build_project_export_data, parse_export_json, ExportScope,
    ExportSummary, ImportSummary,
};
use crate::module::ModuleBackend;
use crate::modules::image_export::write_atomically_with;
use crate::state::AppState;

/// 全 stateful モジュール + 全プロジェクトの items を `path` に JSON で書き出す。
///
/// - 既存ファイルは上書き (ユーザー意図を信頼。フロント側でダイアログ確認済の想定)。
///   同じディレクトリの一時ファイルに書いてから置換するので、失敗時は既存ファイルが残る
/// - `app_version` は `env!("CARGO_PKG_VERSION")` を埋める
/// - pre-op バックアップは取らない (read-only のため、`data-model.md` §12.2 末尾)
///
/// 返却値は **集計値のみ** (`ExportSummary`)。フル `ExportData` は IPC で送り返さない
/// (codex PR-Z P2 対応): フロントは件数 / メタデータしか UI 表示しないため、全アイテム
/// payload を再シリアライズして転送するのは無駄。`bytes_written` を含めることでファイル
/// サイズの感触もユーザーに伝える。
#[tauri::command]
pub async fn core_export_json(
    state: State<'_, AppState>,
    path: String,
    scope: ExportScope,
    project_id: Option<String>,
) -> Result<ExportSummary, AppError> {
    let path_buf = validate_output_path(&path)?;
    let project_id = match (scope, project_id) {
        (ExportScope::App, Some(_)) => {
            return Err(AppError::Validation {
                module_id: "core.export".into(),
                reason: "project_id must be omitted for app scope".into(),
            });
        }
        (ExportScope::App, None) => None,
        (ExportScope::Project, id) => {
            Some(id.filter(|value| !value.trim().is_empty()).ok_or_else(|| {
                AppError::Validation {
                    module_id: "core.export".into(),
                    reason: "project_id is required for project scope".into(),
                }
            })?)
        }
    };

    // module list は AppState の HashMap から取り出して順序を id ソートで安定化
    let modules = collect_modules_sorted(&state);
    let storage = Arc::clone(&state.storage);

    // ページングで全件を読む間に item が更新されて取りこぼし / 重複が出ないよう Exclusive
    run_storage(&state, LockMode::Exclusive, move || {
        let data = match project_id {
            None => build_export_data(&storage, &modules, env!("CARGO_PKG_VERSION"))?,
            Some(id) => build_project_export_data(
                &storage,
                &modules,
                env!("CARGO_PKG_VERSION"),
                &crate::storage::ProjectId::new(id),
            )?,
        };

        // serde_json で書き出し (pretty 出力で diff しやすく)。一時ファイルに書いてから置換する
        // ので、途中失敗 (ディスクフル等) でも既存ファイルを壊さない
        write_atomically_with(&path_buf, |file| {
            let mut writer = std::io::BufWriter::new(file);
            serde_json::to_writer_pretty(&mut writer, &data)
                .map_err(|e| AppError::Storage(format!("serialize export: {e}")))?;
            writer.flush()?;
            Ok(())
        })
        .map_err(|e| AppError::Storage(format!("write {}: {e}", path_buf.display())))?;
        let bytes_written = std::fs::metadata(&path_buf)
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        let mut summary = ExportSummary::summarize(&data);
        summary.bytes_written = bytes_written;
        Ok(summary)
    })
    .await
}

/// `path` の JSON を読み取り、現在 DB に **取り込みを試みる** (`data-model.md` §12.3-12.5)。
///
/// 部分成功方式: 個別の失敗は `ImportSummary` に集計され、全体 `Ok(ImportSummary)` で返る。
/// 「JSON ファイル自体が読めない / schema_version が未対応」など **バッチ全体が無効** な
/// ケースは `Err(AppError)` を返す (この場合 pre-op バックアップは取得済みなので戻れる)。
#[tauri::command]
pub async fn core_import_json(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportSummary, AppError> {
    let storage = Arc::clone(&state.storage);
    let backup = Arc::clone(&state.backup);
    let modules_by_id: HashMap<String, Arc<dyn ModuleBackend>> = state
        .modules
        .iter()
        .map(|(k, v)| ((*k).to_string(), Arc::clone(v)))
        .collect();

    // pre-import バックアップから取り込み完了までを 1 つの Exclusive 区間で行う
    run_storage(&state, LockMode::Exclusive, move || {
        let path_buf = PathBuf::from(&path);
        if !path_buf.exists() {
            return Err(AppError::NotFound {
                entity: "import file".into(),
                key: path,
            });
        }
        let json = std::fs::read_to_string(&path_buf)
            .map_err(|e| AppError::Storage(format!("read {}: {e}", path_buf.display())))?;

        // ファイルパース (`data-model.md` §12.4 step 1)。schema_version / scope の
        // バリデーションが含まれるため、不正な JSON はここで弾く
        let data = parse_export_json(&json)?;

        // pre-op バックアップ取得 (`data-model.md` §12.5)。失敗したら import を中止
        backup.take(BackupKind::PreOp {
            prefix: "pre-import".into(),
        })?;

        // apply_import は内部で部分成功させるため Result ではなく ImportSummary を返す
        Ok(apply_import(&storage, &modules_by_id, &data))
    })
    .await
}

/// 出力先パスの最低限のサニティチェック (空文字 / 親 dir 存在)。
/// 「上書き確認」「拡張子サジェスト」はフロント側ダイアログの責務 — ここでは
/// 「書き込めるはずの場所か」だけを見る。
fn validate_output_path(path: &str) -> Result<PathBuf, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::Validation {
            module_id: "core.export".into(),
            reason: "output path must not be empty".into(),
        });
    }
    let buf = PathBuf::from(path);
    if let Some(parent) = buf.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::Validation {
                module_id: "core.export".into(),
                reason: format!("parent directory does not exist: {}", parent.display()),
            });
        }
    }
    Ok(buf)
}

/// AppState.modules を `id` 昇順で配列化する (export の決定論的順序のため)。
fn collect_modules_sorted(state: &State<'_, AppState>) -> Vec<Arc<dyn ModuleBackend>> {
    let mut entries: Vec<(&&str, &Arc<dyn ModuleBackend>)> = state.modules.iter().collect();
    entries.sort_by_key(|(id, _)| **id);
    entries.into_iter().map(|(_, m)| Arc::clone(m)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn validate_output_path_rejects_empty() {
        let err = validate_output_path("").unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[test]
    fn validate_output_path_rejects_nonexistent_parent() {
        let err = validate_output_path("/nonexistent_xyz_abc/foo.json").unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[test]
    fn validate_output_path_accepts_existing_parent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("export.json");
        assert!(validate_output_path(target.to_str().unwrap()).is_ok());
        // 親が存在すれば未作成のターゲットファイルでも OK
        assert!(!target.exists());
        fs::write(&target, "x").unwrap();
        assert!(validate_output_path(target.to_str().unwrap()).is_ok());
    }
}
