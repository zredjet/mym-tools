//! エクスポートのコアロジック (`data-model.md` §12.1 / §12.2)。
//!
//! 高レベル StorageService API を介して全 stateful モジュール × 全プロジェクトの
//! items を集め、`ExportData` を構築する。Eager-on-Read は読込み時に発火するため、
//! 出力上の `payload_schema_version` は各モジュールの現行版に揃う (`data-model.md`
//! §12.2)。

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::AppError;
use crate::exchange::{
    ExportData, ExportScope, ItemExport, ProjectExport, ProjectWithItems,
    CURRENT_EXPORT_SCHEMA_VERSION,
};
use crate::module::ModuleBackend;
use crate::storage::{Project, ProjectId, StorageService};
use crate::time::now_jst_iso8601;

/// list_items のページ取得サイズ。個人ツール規模では 1 度で取り切れる想定だが、
/// 万一桁が増えても OOM しないようにページングする。
const PAGE_SIZE: u32 = 500;

/// 全プロジェクト + 全 stateful モジュール item をエクスポート用 `ExportData` に
/// 集約する (`data-model.md` §12)。
///
/// - `app_version` は呼び出し側 (Tauri command) から渡す (`env!("CARGO_PKG_VERSION")` を
///   command 側で確定するため、本関数は環境変数に依存しない)
/// - `now_jst_iso8601` を `exported_at` に入れる
/// - **stateless モジュール** (`is_stateless() == true`、例: `hash`) は `module_versions` /
///   items 双方から除外する (`module-contract.md` §9.2)
/// - Eager-on-Read は `get_item_eager` 経由で発火させる: `list_items` は eager しないため、
///   list で id を集めて 1 件ずつ取り直す
pub fn build_export_data(
    storage: &Arc<dyn StorageService>,
    modules: &[Arc<dyn ModuleBackend>],
    app_version: &str,
) -> Result<ExportData, AppError> {
    let projects = storage.list_projects()?;
    build_for_projects(storage, modules, app_version, ExportScope::App, projects)
}

/// 指定した1プロジェクトだけを `scope: "project"` で書き出す。
pub fn build_project_export_data(
    storage: &Arc<dyn StorageService>,
    modules: &[Arc<dyn ModuleBackend>],
    app_version: &str,
    project_id: &ProjectId,
) -> Result<ExportData, AppError> {
    let project = storage.get_project(project_id)?;
    build_for_projects(
        storage,
        modules,
        app_version,
        ExportScope::Project,
        vec![project],
    )
}

fn build_for_projects(
    storage: &Arc<dyn StorageService>,
    modules: &[Arc<dyn ModuleBackend>],
    app_version: &str,
    scope: ExportScope,
    projects: Vec<Project>,
) -> Result<ExportData, AppError> {
    // module_versions: stateful なものだけ書き出す (`data-model.md` §12.2)
    let mut module_versions: BTreeMap<String, u32> = BTreeMap::new();
    let stateful: Vec<&Arc<dyn ModuleBackend>> =
        modules.iter().filter(|m| !m.is_stateless()).collect();
    for m in &stateful {
        module_versions.insert(m.id().to_string(), m.current_payload_version());
    }

    let mut projects_out: Vec<ProjectWithItems> = Vec::with_capacity(projects.len());
    for project in projects {
        let mut items_out: Vec<ItemExport> = Vec::new();
        for m in &stateful {
            // ページング + 1 件ずつ eager 取得
            let mut offset = 0u32;
            loop {
                let page = storage.list_items(m.id(), &project.id, PAGE_SIZE, offset)?;
                let count = page.len() as u32;
                for it in page {
                    // Eager-on-Read を踏ませて payload を最新化してから JSON 化する
                    // (`data-model.md` §12.2)
                    let eager = storage.get_item_eager(m.id(), &it.id, m.as_ref())?;
                    items_out.push(ItemExport::from_item(eager));
                }
                if count < PAGE_SIZE {
                    break;
                }
                offset = offset.saturating_add(count);
            }
        }
        projects_out.push(ProjectWithItems {
            project: ProjectExport::from(project),
            items: items_out,
        });
    }

    Ok(ExportData {
        schema_version: CURRENT_EXPORT_SCHEMA_VERSION,
        exported_at: now_jst_iso8601(),
        app_version: app_version.to_string(),
        scope,
        module_versions,
        projects: projects_out,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use crate::error::AppError;
    use crate::module::ModuleBackend;
    use crate::storage::{SqliteStorage, StorageService};

    use super::*;

    /// `current_payload_version` を可変にしたミニモジュール (テスト用)。
    struct TestModule {
        id: &'static str,
        version: u32,
    }
    impl ModuleBackend for TestModule {
        fn id(&self) -> &'static str {
            self.id
        }
        fn current_payload_version(&self) -> u32 {
            self.version
        }
        fn validate_payload(
            &self,
            _payload: &serde_json::Value,
        ) -> Result<(), crate::module::ModuleError> {
            Ok(())
        }
        fn index_text(&self, payload: &serde_json::Value) -> String {
            payload
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
    }

    /// stateless モジュール (M-Hash 相当)
    struct StatelessModule;
    impl ModuleBackend for StatelessModule {
        fn id(&self) -> &'static str {
            "hash"
        }
        fn is_stateless(&self) -> bool {
            true
        }
    }

    fn setup() -> (Arc<dyn StorageService>, Vec<Arc<dyn ModuleBackend>>) {
        let storage: Arc<dyn StorageService> =
            Arc::new(SqliteStorage::open(":memory:").expect("open"));
        let modules: Vec<Arc<dyn ModuleBackend>> = vec![
            Arc::new(TestModule {
                id: "prompt",
                version: 1,
            }),
            Arc::new(TestModule {
                id: "linkmemo",
                version: 1,
            }),
            Arc::new(StatelessModule),
        ];
        (storage, modules)
    }

    #[test]
    fn empty_db_exports_zero_projects_and_only_stateful_module_versions() {
        let (storage, modules) = setup();
        let data = build_export_data(&storage, &modules, "0.1.0").unwrap();
        assert_eq!(data.schema_version, CURRENT_EXPORT_SCHEMA_VERSION);
        assert_eq!(data.app_version, "0.1.0");
        assert!(matches!(data.scope, ExportScope::App));
        assert_eq!(data.projects.len(), 0);
        // hash (stateless) は含まれない
        assert!(data.module_versions.contains_key("prompt"));
        assert!(data.module_versions.contains_key("linkmemo"));
        assert!(!data.module_versions.contains_key("hash"));
    }

    #[test]
    fn exports_projects_with_items_nested_under_project() -> Result<(), AppError> {
        let (storage, modules) = setup();
        let p = storage.create_project("Project A", Some("desc"))?;
        let _id = storage.create_item(
            "prompt",
            &p.id,
            "Title 1",
            &["tagA".into()],
            1,
            &json!({ "body": "Hello" }),
            "Title 1 tagA Hello",
        )?;

        let data = build_export_data(&storage, &modules, "0.1.0")?;
        assert_eq!(data.projects.len(), 1);
        let pw = &data.projects[0];
        assert_eq!(pw.project.name, "Project A");
        assert_eq!(pw.items.len(), 1);
        assert_eq!(pw.items[0].title, "Title 1");
        assert_eq!(pw.items[0].module_id, "prompt");
        assert_eq!(pw.items[0].payload_schema_version, 1);
        Ok(())
    }

    #[test]
    fn project_scope_exports_only_the_requested_project() -> Result<(), AppError> {
        let (storage, modules) = setup();
        let first = storage.create_project("First", None)?;
        let second = storage.create_project("Second", None)?;
        storage.create_item(
            "prompt",
            &first.id,
            "First item",
            &[],
            1,
            &json!({"body": "one"}),
            "First item one",
        )?;
        storage.create_item(
            "prompt",
            &second.id,
            "Second item",
            &[],
            1,
            &json!({"body": "two"}),
            "Second item two",
        )?;

        let data = build_project_export_data(&storage, &modules, "0.1.0", &second.id)?;

        assert!(matches!(data.scope, ExportScope::Project));
        assert_eq!(data.projects.len(), 1);
        assert_eq!(data.projects[0].project.id, second.id);
        assert_eq!(data.projects[0].items[0].title, "Second item");
        Ok(())
    }

    #[test]
    fn stateless_module_items_are_not_exported() -> Result<(), AppError> {
        // hash は is_stateless = true なので、build_export_data はそもそも list_items を
        // 呼ばないことを stateful 件数のみで確認 (`module-contract.md` §9.2)
        let (storage, modules) = setup();
        let p = storage.create_project("P", None)?;
        storage.create_item(
            "prompt",
            &p.id,
            "Prompt 1",
            &[],
            1,
            &json!({"body": "x"}),
            "Prompt 1 x",
        )?;
        let data = build_export_data(&storage, &modules, "0.1.0")?;
        assert_eq!(data.projects[0].items.len(), 1);
        assert_eq!(data.projects[0].items[0].module_id, "prompt");
        Ok(())
    }
}
