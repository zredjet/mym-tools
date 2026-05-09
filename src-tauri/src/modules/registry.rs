//! モジュールの集中登録 (`architecture.md` §5.1 / `module-contract.md` §5.3 / Q-22 PoC)。
//!
//! - `MODULE_BACKENDS()` が `Arc<dyn ModuleBackend>` の配列を返す
//! - `register_invoke_handler()` が Tauri Builder に各モジュールの `#[tauri::command]` を
//!   一括登録する。`generate_handler!` マクロは展開上 1 か所に集約するのが安全
//!
//! ## 新モジュール追加時の編集箇所 (ADR-0004 §5.1: 「2 ファイル追加 + registry 1 行追記 × 2」)
//! 1. `MODULE_BACKENDS()` の Vec に `Arc::new(<NewModule>::new())` を追加 (1 行)
//! 2. `register_invoke_handler()` の `generate_handler!` リストに固有コマンドを列挙
//!    (固有コマンド数で行数が変わる)

use std::sync::Arc;

use crate::module::ModuleBackend;
use crate::modules::color::ColorModule;
use crate::modules::hash::HashModule;
use crate::modules::linkmemo::LinkMemoModule;
use crate::modules::prompt::PromptModule;

/// アプリで利用するすべての ModuleBackend を順序付きで返す。
///
/// 順序は AppState 構築時にこの配列をそのまま `HashMap<&'static str, Arc<dyn ModuleBackend>>`
/// に詰め直す前提なので意味を持たないが、UI のサイドバー表示順を制御したい場合に
/// 利用できる (Phase 1 後の検討)。
pub fn module_backends() -> Vec<Arc<dyn ModuleBackend>> {
    vec![
        Arc::new(HashModule),
        Arc::new(ColorModule),
        Arc::new(LinkMemoModule),
        Arc::new(PromptModule),
        // 新モジュールはここに 1 行追加する
    ]
}

/// 各モジュールの Tauri コマンドを集中登録する。
///
/// `tauri::generate_handler!` の制約で、すべてのコマンドを 1 か所に列挙する必要がある
/// (`module-contract.md` §5.3)。新モジュール追加時はこの `generate_handler!` リストに
/// 固有コマンドを追記する。
///
/// `core_*` コマンドもここで登録する (Tauri 制約: invoke_handler は 1 度しか呼べない)。
pub fn register_invoke_handler<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        // Core (ADR-0009 §2 / `module-contract.md` §6.2)
        crate::commands::cancel::core_cancel_operation,
        // Core: Project CRUD (`module-contract.md` §6.2: モジュールからは呼ばない)
        crate::commands::projects::core_list_projects,
        crate::commands::projects::core_get_project,
        crate::commands::projects::core_create_project,
        crate::commands::projects::core_update_project,
        crate::commands::projects::core_delete_project,
        crate::commands::projects::core_reorder_projects,
        // Core: Items CRUD (ScopedStorage 経由、Eager-on-Read は get_item で発火)
        crate::commands::items::core_list_items,
        crate::commands::items::core_get_item,
        crate::commands::items::core_create_item,
        crate::commands::items::core_update_item,
        crate::commands::items::core_delete_item,
        // Core: 横断検索 (FTS5 trigram + LIKE フォールバック、data-model.md §8)
        crate::commands::search::core_search,
        // Core: Backup (ADR-0007 / data-model.md §13)
        crate::commands::backup::core_backup_should_take_auto,
        crate::commands::backup::core_backup_list,
        crate::commands::backup::core_backup_take_auto,
        crate::commands::backup::core_backup_take_manual,
        crate::commands::backup::core_backup_delete,
        crate::commands::backup::core_backup_verify,
        crate::commands::backup::core_backup_restore,
        // M-Hash
        crate::modules::hash::commands::hash_compute_text,
        crate::modules::hash::commands::hash_compute_file,
        // M-LinkMemo
        crate::modules::linkmemo::commands::linkmemo_normalize_target,
        crate::modules::linkmemo::commands::linkmemo_open,
        // M-Prompt
        crate::modules::prompt::commands::prompt_render_template,
        // M-Color はフロントだけで完結 (固有 IPC コマンドなし、`module-contract.md` §12.3)
        // 新モジュールの固有コマンドはここに追加する
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::storage::{SqliteStorage, StorageService};
    use serde_json::json;

    /// 実モジュール (Color / LinkMemo / Prompt / Hash) を `AppState::build` に通せる
    /// ことを保証する。`module-contract.md` §3.2 の id 規約 (英小文字 + 数字 / 3〜32 文字 /
    /// 重複なし) が全モジュールで満たされていることもこれで担保される。
    #[test]
    fn module_backends_build_into_app_state() {
        let storage: Arc<dyn StorageService> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let backends = module_backends();
        // Phase 1 では Hash / Color / LinkMemo / Prompt の 4 モジュール
        assert_eq!(backends.len(), 4);
        let dir = tempfile::tempdir().unwrap();
        let backup: Arc<dyn crate::backup::BackupService> = Arc::new(
            crate::backup::LocalBackupService::new(dir.path().to_path_buf(), Arc::clone(&storage)),
        );
        let state = AppState::build(backends, storage, backup).unwrap();
        assert!(state.module("hash").is_some());
        assert!(state.module("color").is_some());
        assert!(state.module("linkmemo").is_some());
        assert!(state.module("prompt").is_some());
    }

    /// 実モジュールを `ScopedStorage` 経由で CRUD できることを end-to-end で確認する
    /// (`module-contract.md` §5.1 の流れの統合テスト)。
    #[test]
    fn end_to_end_color_create_get_via_scoped_storage() {
        let storage: Arc<SqliteStorage> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let project = storage.create_project("Project", None).unwrap();

        let dyn_storage: Arc<dyn StorageService> = storage;
        let scoped = dyn_storage.scoped_for(Arc::new(crate::modules::color::ColorModule));
        let id = scoped
            .create_item(&project.id, "Brand Red", &[], json!({"hex": "#FF5733"}))
            .unwrap();
        let fetched = scoped.get_item(&id).unwrap();
        assert_eq!(fetched.module_id, "color");
        assert_eq!(fetched.title, "Brand Red");
        assert_eq!(fetched.payload["hex"], "#FF5733");
    }

    #[test]
    fn end_to_end_linkmemo_create_validates_url() {
        let storage: Arc<SqliteStorage> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let project = storage.create_project("Project", None).unwrap();

        let dyn_storage: Arc<dyn StorageService> = storage;
        let scoped = dyn_storage.scoped_for(Arc::new(crate::modules::linkmemo::LinkMemoModule));

        // url 正常系
        scoped
            .create_item(
                &project.id,
                "GitHub",
                &[],
                json!({
                    "type": "url",
                    "target": "https://github.com",
                    "body": ""
                }),
            )
            .unwrap();

        // url で http(s):// 以外は拒否 (validate_payload 経路)
        let err = scoped
            .create_item(
                &project.id,
                "Bad URL",
                &[],
                json!({"type": "url", "target": "ftp://example.com"}),
            )
            .unwrap_err();
        assert!(matches!(err, crate::error::AppError::Validation { .. }));
    }

    #[test]
    fn end_to_end_prompt_create_get_with_variables() {
        let storage: Arc<SqliteStorage> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let project = storage.create_project("Project", None).unwrap();

        let dyn_storage: Arc<dyn StorageService> = storage;
        let scoped = dyn_storage.scoped_for(Arc::new(crate::modules::prompt::PromptModule));
        let id = scoped
            .create_item(
                &project.id,
                "翻訳",
                &["util".into()],
                json!({"body": "Translate {{text}} to {{lang}}"}),
            )
            .unwrap();
        let fetched = scoped.get_item(&id).unwrap();
        assert_eq!(fetched.module_id, "prompt");
        assert_eq!(fetched.payload["body"], "Translate {{text}} to {{lang}}");
        // search_text には body が含まれる (StorageService が検索可能にしている)
    }

    #[test]
    fn end_to_end_search_finds_color_by_hex_substring() {
        let storage: Arc<SqliteStorage> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let project = storage.create_project("Project", None).unwrap();

        let dyn_storage: Arc<dyn StorageService> = Arc::clone(&storage) as Arc<dyn StorageService>;
        let scoped =
            Arc::clone(&dyn_storage).scoped_for(Arc::new(crate::modules::color::ColorModule));
        scoped
            .create_item(&project.id, "Red", &[], json!({"hex": "#FF0000"}))
            .unwrap();
        scoped
            .create_item(&project.id, "Blue", &[], json!({"hex": "#0000FF"}))
            .unwrap();

        // FTS 検索: "FF0000" (6 文字 ≥ 3 trigram) で "Red" のみヒット
        let results = dyn_storage
            .search(
                &crate::storage::SearchScope::Project {
                    project_id: project.id.clone(),
                },
                "FF0000",
                None,
                100,
                0,
            )
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Red");
    }
}
