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
use crate::modules::a11y::A11yModule;
use crate::modules::codec::CodecModule;
use crate::modules::color::ColorModule;
use crate::modules::cron::CronModule;
use crate::modules::datetime::DateTimeModule;
use crate::modules::diagram::DiagramModule;
use crate::modules::hash::HashModule;
use crate::modules::http::HttpModule;
use crate::modules::idgen::IdGeneratorModule;
use crate::modules::jwt::JwtModule;
use crate::modules::linkmemo::LinkMemoModule;
use crate::modules::memo::MemoModule;
use crate::modules::mermaid::MermaidModule;
use crate::modules::nrbf::NrbfModule;
use crate::modules::palette::PaletteModule;
use crate::modules::pdfmerge::PdfMergeModule;
use crate::modules::prompt::PromptModule;
use crate::modules::regex::RegexModule;
use crate::modules::secretgen::SecretGeneratorModule;
use crate::modules::textdiff::TextDiffModule;
use crate::modules::urlquery::UrlQueryModule;

/// アプリで利用するすべての ModuleBackend を順序付きで返す。
///
/// AppState 構築時に `HashMap<&'static str, Arc<dyn ModuleBackend>>` へ詰め直すため、
/// この順序は UI 表示順を表さない。Frontend の表示順は `src/modules/registry.ts` が正典。
pub fn module_backends() -> Vec<Arc<dyn ModuleBackend>> {
    vec![
        Arc::new(HashModule),
        Arc::new(ColorModule),
        Arc::new(LinkMemoModule),
        Arc::new(MemoModule),
        Arc::new(MermaidModule),
        Arc::new(DiagramModule),
        Arc::new(PromptModule),
        Arc::new(PaletteModule),
        Arc::new(PdfMergeModule),
        Arc::new(NrbfModule),
        Arc::new(CodecModule),
        Arc::new(UrlQueryModule),
        Arc::new(DateTimeModule),
        Arc::new(IdGeneratorModule),
        Arc::new(SecretGeneratorModule),
        Arc::new(RegexModule),
        Arc::new(TextDiffModule),
        Arc::new(JwtModule),
        Arc::new(CronModule),
        Arc::new(A11yModule),
        Arc::new(HttpModule),
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
pub fn register_invoke_handler(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
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
        crate::commands::items::core_reorder_items,
        // Core: 横断検索 (FTS5 trigram + LIKE フォールバック、data-model.md §8)
        crate::commands::search::core_search,
        // Core: settings.json (data-model.md §11)
        crate::commands::settings::core_get_settings,
        crate::commands::settings::core_update_settings,
        // Core: Backup (ADR-0007 / data-model.md §13)
        crate::commands::backup::core_backup_should_take_auto,
        crate::commands::backup::core_backup_list,
        crate::commands::backup::core_backup_take_auto,
        crate::commands::backup::core_backup_take_manual,
        crate::commands::backup::core_backup_delete,
        crate::commands::backup::core_backup_verify,
        crate::commands::backup::core_backup_restore,
        // Core: Export / Import JSON (D-05 / data-model.md §12)
        crate::commands::transfer::core_export_json,
        crate::commands::transfer::core_import_json,
        // Core: About 画面補助 (`ui-design.md §6.10`)
        crate::commands::about::core_module_versions,
        // Core: frontend/backend registry の起動時照合 (`module-contract.md` §2)
        crate::commands::about::core_module_ids,
        // M-Hash
        crate::modules::hash::commands::hash_compute_text,
        crate::modules::hash::commands::hash_compute_file,
        // M-HTTP
        crate::modules::http::commands::http_send_request,
        // M-Link (公開済みIDは linkmemo)
        crate::modules::linkmemo::commands::linkmemo_normalize_target,
        crate::modules::linkmemo::commands::linkmemo_open,
        // M-Diagram: user-selected local files only
        crate::modules::diagram::protocol::diagram_editor_url,
        crate::modules::diagram::commands::diagram_read_file,
        crate::modules::diagram::commands::diagram_write_file,
        // M-Mermaid: user-selected local SVG / PNG files only
        crate::modules::mermaid::commands::mermaid_write_file,
        // M-PDF Merge: user-selected local PDF files only
        crate::modules::pdfmerge::commands::pdfmerge_inspect_files,
        crate::modules::pdfmerge::commands::pdfmerge_merge_files,
        // M-NRBF: BinaryFormatter NRBFインスペクター
        crate::modules::nrbf::commands::nrbf_inspect_file,
        // M-Prompt
        crate::modules::prompt::commands::prompt_render_template,
        // M-Color / M-Palette はフロントだけで完結 (固有 IPC コマンドなし)
        // 新モジュールの固有コマンドはここに追加する
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::storage::{SqliteStorage, StorageService};
    use serde_json::json;

    /// 全実モジュールを `AppState::build` に通せる
    /// ことを保証する。`module-contract.md` §3.2 の id 規約 (英小文字 + 数字 / 3〜32 文字 /
    /// 重複なし) が全モジュールで満たされていることもこれで担保される。
    #[test]
    fn module_backends_build_into_app_state() {
        let storage: Arc<dyn StorageService> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let backends = module_backends();
        assert_eq!(backends.len(), 21);
        let dir = tempfile::tempdir().unwrap();
        let backup: Arc<dyn crate::backup::BackupService> = Arc::new(
            crate::backup::LocalBackupService::new(dir.path().to_path_buf(), Arc::clone(&storage)),
        );
        let state = AppState::build(backends, storage, backup).unwrap();
        assert!(state.module("hash").is_some());
        assert!(state.module("color").is_some());
        assert!(state.module("linkmemo").is_some());
        assert!(state.module("memo").is_some());
        assert!(state.module("mermaid").is_some());
        assert!(state.module("diagram").is_some());
        assert!(state.module("prompt").is_some());
        assert!(state.module("palette").is_some());
        assert!(state.module("pdfmerge").is_some());
        for id in [
            "codec",
            "urlquery",
            "datetime",
            "idgen",
            "secretgen",
            "regex",
            "textdiff",
            "jwt",
            "cron",
            "a11y",
            "http",
            "nrbf",
        ] {
            assert!(state.module(id).is_some(), "missing backend: {id}");
        }
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

    #[test]
    fn end_to_end_palette_crud_and_search_by_color() {
        let storage: Arc<SqliteStorage> = Arc::new(SqliteStorage::open(":memory:").unwrap());
        let project = storage.create_project("Project", None).unwrap();

        let dyn_storage: Arc<dyn StorageService> = Arc::clone(&storage) as Arc<dyn StorageService>;
        let scoped =
            Arc::clone(&dyn_storage).scoped_for(Arc::new(crate::modules::palette::PaletteModule));
        let id = scoped
            .create_item(
                &project.id,
                "Ocean Theme",
                &["brand".into()],
                json!({
                    "colors": ["#123ABC", "#2563EB", "#3B82F6", "#60A5FA", "#93C5FD"],
                    "harmony": "analogous",
                    "base_index": 2
                }),
            )
            .unwrap();

        let fetched = scoped.get_item(&id).unwrap();
        assert_eq!(fetched.module_id, "palette");
        assert_eq!(fetched.payload["colors"][0], "#123ABC");

        let results = dyn_storage
            .search(
                &crate::storage::SearchScope::Project {
                    project_id: project.id,
                },
                "123ABC",
                Some(&["palette".to_string()]),
                100,
                0,
            )
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, id);

        scoped.delete_item(&id).unwrap();
        assert!(scoped.get_item(&id).is_err());
    }
}
