//! インポートのコアロジック (`data-model.md` §12.3 / §12.4)。
//!
//! 部分成功方式: プロジェクトと item をそれぞれ独立トランザクションで投入し、衝突
//! (ID 重複) は **skip + 計上**、validate / upgrade_payload 失敗は **failed + 計上**
//! として `ImportSummary` に積む。他の行は継続。
//!
//! ## 1 item あたりの処理フロー (`data-model.md` §12.4)
//!
//! ```
//! 1. JSON ルートの schema_version を見てコンバータを通す  ← 本 PR では 1 のみ受理 (将来拡張点)
//! 2. item の module_id をモジュールレジストリで解決
//! 3. ID 衝突チェック (StorageService::import_item 内部)
//! 4. payload を現行 payload_schema_version までアップグレード
//! 5. アップグレード後 payload を validate_payload() で検証
//! 6. アップグレード後 payload に対して index_text() を実行し search_text を生成
//! 7. items に INSERT (1 トランザクション、FTS5 トリガが連動)
//! ```

use std::collections::HashMap;
use std::sync::Arc;

use crate::error::AppError;
use crate::exchange::{
    ExportData, ExportScope, ImportFailure, ImportSummary, ItemExport, ProjectWithItems,
    CURRENT_EXPORT_SCHEMA_VERSION,
};
use crate::module::ModuleBackend;
use crate::storage::{ImportOutcome, Project, StorageService};

/// JSON テキストを `ExportData` にパースしつつ、トップレベルの schema_version 等
/// プリチェックを行う (`data-model.md` §12.4 step 1)。
pub fn parse_export_json(json: &str) -> Result<ExportData, AppError> {
    let data: ExportData = serde_json::from_str(json).map_err(|e| AppError::Validation {
        module_id: "core.import".into(),
        reason: format!("JSON parse error: {e}"),
    })?;
    if data.schema_version != CURRENT_EXPORT_SCHEMA_VERSION {
        return Err(AppError::Validation {
            module_id: "core.import".into(),
            reason: format!(
                "unsupported export schema_version: {} (this build accepts {})",
                data.schema_version, CURRENT_EXPORT_SCHEMA_VERSION
            ),
        });
    }
    if !matches!(data.scope, ExportScope::App) {
        // Phase 1 では project スコープのインポートを受け付けない (`data-model.md` §12.1)
        return Err(AppError::Validation {
            module_id: "core.import".into(),
            reason: "only `scope: \"app\"` is supported in Phase 1".into(),
        });
    }
    Ok(data)
}

/// `ExportData` をストレージに取り込む。Phase 1 の部分成功方式 (`data-model.md` §12.3 /
/// §12.4) を実装する。
///
/// - pre-op バックアップは **本関数では取らない** (呼び出し側 = Tauri command の責務)
/// - 各プロジェクトと各 item は独立トランザクションで処理し、失敗は `ImportSummary` に
///   集計する
/// - プロジェクト投入が **`Inserted` または `Skipped`** のいずれの場合も、配下 items の
///   投入は試みる (既存プロジェクトに新規 item が増える状況も想定: e.g. 同名構成の
///   別マシンから差分エクスポートを取り込むケース)
/// - 一方、プロジェクト投入が **Err** で失敗した場合は、その配下 items は全て skip 計上
///   する (親が存在しないため FK エラーで失敗するのは明らかなので前段で打ち切る、
///   `data-model.md` §12.4 トランザクション粒度)
pub fn apply_import(
    storage: &Arc<dyn StorageService>,
    modules_by_id: &HashMap<String, Arc<dyn ModuleBackend>>,
    data: &ExportData,
) -> ImportSummary {
    let mut summary = ImportSummary::new();

    // step 1-8: project + item を順に投入する。step 9 (position 補正) のために
    // 「投入を試みたスコープ」を記録しておく
    let mut touched_scopes: std::collections::BTreeSet<(String, String)> =
        std::collections::BTreeSet::new();

    for pw in &data.projects {
        match import_one_project(storage, &mut summary, pw) {
            Ok(parent_present) if parent_present => {
                // 親が DB に存在する (新規 INSERT または既存) → 配下 items を試す
                for item in &pw.items {
                    let inserted = import_one_item(
                        storage,
                        modules_by_id,
                        &mut summary,
                        &pw.project.id.0,
                        item,
                    );
                    // codex PR-Y P1: **新規 INSERT が実際に発生したスコープのみ** を追跡する。
                    // skip / failed のみのスコープを normalize すると、無駄に position を書き換え
                    // data_revision +1 が発生する (= 再 import を no-op として扱う冪等性が崩れる)。
                    if inserted {
                        touched_scopes.insert((pw.project.id.0.clone(), item.module_id.clone()));
                    }
                }
            }
            Ok(_) => {
                // 親が用意できなかった (実質起きないが安全側): items を全件 skip 扱い
                for item in &pw.items {
                    summary.items_skipped += 1;
                    record_skipped_orphan(&mut summary, item);
                }
            }
            Err(_) => {
                // 親 INSERT 自体が失敗 (バリデーション等) → 配下 items を全件 failed 扱い
                for item in &pw.items {
                    summary.items_failed += 1;
                    summary.failures.push(ImportFailure {
                        entity: "item".into(),
                        id: item.id.0.clone(),
                        module_id: Some(item.module_id.clone()),
                        reason: "parent project failed to import".into(),
                    });
                }
            }
        }
    }

    // step 9 (`data-model.md` §12.4): 投入された (project_id, module_id) スコープに対し
    // ROW_NUMBER で position を 0..N-1 に詰め直す。元 position 順 → created_at 順 → id 順で
    // タイブレーカー。エラーは ImportFailure に積むだけで止めない (部分成功方式)
    for (pid, mid) in &touched_scopes {
        let project_id = crate::storage::ProjectId::new(pid.clone());
        if let Err(e) = storage.normalize_item_positions(&project_id, mid) {
            summary.failures.push(ImportFailure {
                entity: "item".into(),
                id: format!("{pid}/{mid}"),
                module_id: Some(mid.clone()),
                reason: format!("normalize_item_positions failed: {e}"),
            });
        }
    }

    summary
}

/// プロジェクトを 1 件投入する。Ok(parent_present): 親が DB 上に存在するか
/// (= 配下 items の投入を試みてよいか)。Err: バリデーション等の真のエラー (この
/// 場合 items は全件 failed 計上にする)。
fn import_one_project(
    storage: &Arc<dyn StorageService>,
    summary: &mut ImportSummary,
    pw: &ProjectWithItems,
) -> Result<bool, AppError> {
    let project: Project = pw.project.clone().into();
    match storage.import_project(&project) {
        Ok(ImportOutcome::Inserted) => {
            summary.projects_inserted += 1;
            Ok(true)
        }
        Ok(ImportOutcome::Skipped) => {
            summary.projects_skipped += 1;
            Ok(true)
        }
        Err(e) => {
            summary.projects_failed += 1;
            summary.failures.push(ImportFailure {
                entity: "project".into(),
                id: pw.project.id.0.clone(),
                module_id: None,
                reason: format!("{e}"),
            });
            Err(e)
        }
    }
}

/// アイテムを 1 件投入する。失敗カテゴリ:
/// - module 未登録 → failed (`unknown module_id`)
/// - payload upgrade 失敗 → failed
/// - validate 失敗 → failed
/// - import_item の真のエラー → failed
/// - import_item の Skipped → skipped 計上
///
/// 戻り値: **新規 INSERT が成功した場合のみ** `true`。skip / failed は `false`。
/// 呼び出し側は `true` のときだけ `touched_scopes` に追加する (codex PR-Y P1)。
fn import_one_item(
    storage: &Arc<dyn StorageService>,
    modules_by_id: &HashMap<String, Arc<dyn ModuleBackend>>,
    summary: &mut ImportSummary,
    parent_project_id: &str,
    item: &ItemExport,
) -> bool {
    let module = match modules_by_id.get(&item.module_id) {
        Some(m) => m,
        None => {
            summary.items_failed += 1;
            summary.failures.push(ImportFailure {
                entity: "item".into(),
                id: item.id.0.clone(),
                module_id: Some(item.module_id.clone()),
                reason: format!("unknown module_id: {}", item.module_id),
            });
            return false;
        }
    };

    // stateless モジュールに対する item があったら無視 (`module-contract.md` §9.2)。
    // 通常はエクスポート側で除外されるので、ファイル改ざん or 古い互換性問題のみが該当。
    if module.is_stateless() {
        summary.items_failed += 1;
        summary.failures.push(ImportFailure {
            entity: "item".into(),
            id: item.id.0.clone(),
            module_id: Some(item.module_id.clone()),
            reason: format!(
                "module {} is stateless and cannot accept items",
                item.module_id
            ),
        });
        return false;
    }

    // payload を現行版までアップグレード (`data-model.md` §12.4 step 4)
    let current = module.current_payload_version();
    let mut payload = item.payload.clone();
    let mut from = item.payload_schema_version;
    while from < current {
        match module.upgrade_payload(from, payload) {
            Ok(next) => {
                payload = next;
                from += 1;
            }
            Err(e) => {
                summary.items_failed += 1;
                summary.failures.push(ImportFailure {
                    entity: "item".into(),
                    id: item.id.0.clone(),
                    module_id: Some(item.module_id.clone()),
                    reason: format!("payload upgrade {} -> {} failed: {}", from, from + 1, e),
                });
                return false;
            }
        }
    }
    if from > current {
        // エクスポート側がこのビルドより新しい payload を書いていた場合
        summary.items_failed += 1;
        summary.failures.push(ImportFailure {
            entity: "item".into(),
            id: item.id.0.clone(),
            module_id: Some(item.module_id.clone()),
            reason: format!(
                "payload_schema_version {} is newer than this build supports ({})",
                from, current
            ),
        });
        return false;
    }

    // validate (`data-model.md` §12.4 step 5)
    if let Err(e) = module.validate_payload(&payload) {
        summary.items_failed += 1;
        summary.failures.push(ImportFailure {
            entity: "item".into(),
            id: item.id.0.clone(),
            module_id: Some(item.module_id.clone()),
            reason: format!("validate failed: {e}"),
        });
        return false;
    }

    // search_text 生成 (`data-model.md` §12.4 step 6)
    let module_text = module.index_text(&payload);
    let search_text = build_search_text(&item.title, &item.tags, &module_text);

    // INSERT
    // position は JSON の値をそのまま入れる (data-model.md §6.5)。投入後の補正は
    // `apply_import` 末尾の `normalize_item_positions` でスコープごとに ROW_NUMBER で詰め直す。
    let outcome = storage.import_item(
        &item.id,
        &crate::storage::ProjectId::new(parent_project_id.to_string()),
        &item.module_id,
        &item.title,
        &item.tags,
        current,
        &payload,
        &search_text,
        item.position,
        &item.created_at,
        &item.updated_at,
    );
    match outcome {
        Ok(ImportOutcome::Inserted) => {
            summary.items_inserted += 1;
            true
        }
        Ok(ImportOutcome::Skipped) => {
            summary.items_skipped += 1;
            false
        }
        Err(e) => {
            summary.items_failed += 1;
            summary.failures.push(ImportFailure {
                entity: "item".into(),
                id: item.id.0.clone(),
                module_id: Some(item.module_id.clone()),
                reason: format!("insert failed: {e}"),
            });
            false
        }
    }
}

fn record_skipped_orphan(summary: &mut ImportSummary, item: &ItemExport) {
    summary.failures.push(ImportFailure {
        entity: "item".into(),
        id: item.id.0.clone(),
        module_id: Some(item.module_id.clone()),
        reason: "parent project was neither inserted nor preexisting".into(),
    });
}

/// `data-model.md` §6.2 / §8.2 トリガ参照: search_text は `title` / `tags JSON` /
/// `module.index_text(payload)` をスペース区切りで連結した形 (FTS5 が自前で
/// トークナイズする)。
fn build_search_text(title: &str, tags: &[String], module_text: &str) -> String {
    let tags_joined = tags.join(" ");
    format!("{title} {tags_joined} {module_text}")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};
    use std::sync::Arc;

    use serde_json::json;

    use crate::exchange::{
        ExportData, ExportScope, ItemExport, ProjectExport, ProjectWithItems,
        CURRENT_EXPORT_SCHEMA_VERSION,
    };
    use crate::module::{ModuleBackend, ModuleError};
    use crate::storage::{ItemId, ProjectId, SqliteStorage, StorageService};

    use super::*;

    /// title / body 仕様のテスト用モジュール。`current` で payload version を可変に。
    struct PromptLikeModule {
        current: u32,
    }
    impl ModuleBackend for PromptLikeModule {
        fn id(&self) -> &'static str {
            "prompt"
        }
        fn current_payload_version(&self) -> u32 {
            self.current
        }
        fn upgrade_payload(
            &self,
            from: u32,
            mut payload: serde_json::Value,
        ) -> Result<serde_json::Value, ModuleError> {
            // テスト用: 1 → 2 で `version_marker` を 2 に書き換える upgrade を仮定
            if from == 1 {
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("version_marker".into(), serde_json::Value::from(2));
                }
                Ok(payload)
            } else {
                Err(ModuleError::UnknownPayloadVersion(from))
            }
        }
        fn validate_payload(&self, payload: &serde_json::Value) -> Result<(), ModuleError> {
            if payload.get("body").is_some() {
                Ok(())
            } else {
                Err(ModuleError::ValidationFailed {
                    reason: "missing body".into(),
                })
            }
        }
        fn index_text(&self, payload: &serde_json::Value) -> String {
            payload
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
    }

    fn setup(
        current_payload_version: u32,
    ) -> (
        Arc<dyn StorageService>,
        HashMap<String, Arc<dyn ModuleBackend>>,
    ) {
        let storage: Arc<dyn StorageService> =
            Arc::new(SqliteStorage::open(":memory:").expect("open"));
        let module: Arc<dyn ModuleBackend> = Arc::new(PromptLikeModule {
            current: current_payload_version,
        });
        let mut map = HashMap::new();
        map.insert("prompt".to_string(), module);
        (storage, map)
    }

    fn data_with(projects: Vec<ProjectWithItems>) -> ExportData {
        ExportData {
            schema_version: CURRENT_EXPORT_SCHEMA_VERSION,
            exported_at: "2026-05-11T00:00:00.000+09:00".into(),
            app_version: "0.1.0".into(),
            scope: ExportScope::App,
            module_versions: BTreeMap::new(),
            projects,
        }
    }

    fn project(id: &str, name: &str) -> ProjectExport {
        ProjectExport {
            id: ProjectId::new(id),
            name: name.into(),
            description: None,
            position: 0,
            created_at: "2026-05-01T00:00:00.000+09:00".into(),
            updated_at: "2026-05-01T00:00:00.000+09:00".into(),
        }
    }

    fn item(id: &str, payload_schema_version: u32, payload: serde_json::Value) -> ItemExport {
        ItemExport {
            id: ItemId::new(id),
            module_id: "prompt".into(),
            title: format!("Title-{id}"),
            tags: vec!["t".into()],
            payload_schema_version,
            payload,
            position: 0,
            created_at: "2026-05-02T00:00:00.000+09:00".into(),
            updated_at: "2026-05-02T00:00:00.000+09:00".into(),
        }
    }

    #[test]
    fn parse_rejects_future_schema_version() {
        let json = r#"{
          "schema_version": 999,
          "exported_at": "2026-05-11T00:00:00.000+09:00",
          "app_version": "0.1.0",
          "scope": "app",
          "module_versions": {},
          "projects": []
        }"#;
        let err = parse_export_json(json).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("schema_version"));
    }

    #[test]
    fn parse_rejects_project_scope_in_phase1() {
        let json = r#"{
          "schema_version": 1,
          "exported_at": "2026-05-11T00:00:00.000+09:00",
          "app_version": "0.1.0",
          "scope": "project",
          "module_versions": {},
          "projects": []
        }"#;
        let err = parse_export_json(json).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("scope") || msg.contains("Phase 1"));
    }

    #[test]
    fn imports_fresh_project_and_items() {
        let (storage, modules) = setup(1);
        let data = data_with(vec![ProjectWithItems {
            project: project("p1", "Project 1"),
            items: vec![item("i1", 1, json!({"body": "hello"}))],
        }]);
        let s = apply_import(&storage, &modules, &data);
        assert_eq!(s.projects_inserted, 1);
        assert_eq!(s.items_inserted, 1);
        assert_eq!(s.failures.len(), 0);
        // 実 DB にも入った
        let p = storage.get_project(&ProjectId::new("p1")).unwrap();
        assert_eq!(p.name, "Project 1");
    }

    #[test]
    fn duplicate_project_id_is_skipped_but_new_items_under_it_still_proceed() {
        let (storage, modules) = setup(1);
        // 1 回目
        let data1 = data_with(vec![ProjectWithItems {
            project: project("p1", "Original"),
            items: vec![item("i1", 1, json!({"body": "a"}))],
        }]);
        apply_import(&storage, &modules, &data1);

        // 2 回目: 同 ID プロジェクト (skip 想定) に新規 item i2 がぶら下がる
        let data2 = data_with(vec![ProjectWithItems {
            project: project("p1", "Renamed (skipped)"),
            items: vec![item("i2", 1, json!({"body": "b"}))],
        }]);
        let s = apply_import(&storage, &modules, &data2);
        assert_eq!(s.projects_inserted, 0);
        assert_eq!(s.projects_skipped, 1);
        assert_eq!(s.items_inserted, 1); // 新規 i2 は入る
                                         // プロジェクト名は元のまま (上書きされない)
        let p = storage.get_project(&ProjectId::new("p1")).unwrap();
        assert_eq!(p.name, "Original");
    }

    #[test]
    fn upgrades_payload_before_insert_when_export_was_older() {
        let (storage, modules) = setup(2); // 現行版は 2
        let data = data_with(vec![ProjectWithItems {
            project: project("p1", "P"),
            items: vec![item("i1", 1, json!({"body": "x"}))], // version 1 で書かれている
        }]);
        let s = apply_import(&storage, &modules, &data);
        assert_eq!(s.items_inserted, 1);
        // 取り出して upgrade marker が乗っていることを確認
        let module: Arc<dyn ModuleBackend> = modules.get("prompt").cloned().unwrap();
        let got = storage
            .get_item_eager("prompt", &ItemId::new("i1"), module.as_ref())
            .unwrap();
        assert_eq!(got.payload_schema_version, 2);
        assert_eq!(
            got.payload.get("version_marker").and_then(|v| v.as_i64()),
            Some(2)
        );
    }

    #[test]
    fn future_payload_version_yields_item_failure_not_panic() {
        let (storage, modules) = setup(1); // current=1
        let data = data_with(vec![ProjectWithItems {
            project: project("p1", "P"),
            items: vec![item("i1", 99, json!({"body": "x"}))], // 未来版
        }]);
        let s = apply_import(&storage, &modules, &data);
        assert_eq!(s.projects_inserted, 1);
        assert_eq!(s.items_inserted, 0);
        assert_eq!(s.items_failed, 1);
        assert!(s.failures[0].reason.contains("newer"));
    }

    #[test]
    fn item_with_unknown_module_id_is_failed_not_aborted() {
        let (storage, modules) = setup(1);
        let bad_item = ItemExport {
            module_id: "no_such_module".into(),
            ..item("i1", 1, json!({"body": "x"}))
        };
        let good_item = item("i2", 1, json!({"body": "y"}));
        let data = data_with(vec![ProjectWithItems {
            project: project("p1", "P"),
            items: vec![bad_item, good_item],
        }]);
        let s = apply_import(&storage, &modules, &data);
        assert_eq!(s.items_inserted, 1);
        assert_eq!(s.items_failed, 1);
        assert!(s.failures[0].reason.contains("unknown module_id"));
    }

    #[test]
    fn item_failing_validate_is_recorded_but_others_continue() {
        let (storage, modules) = setup(1);
        let bad = item("i1", 1, json!({})); // body 無し → validate 失敗
        let good = item("i2", 1, json!({"body": "ok"}));
        let data = data_with(vec![ProjectWithItems {
            project: project("p1", "P"),
            items: vec![bad, good],
        }]);
        let s = apply_import(&storage, &modules, &data);
        assert_eq!(s.items_inserted, 1);
        assert_eq!(s.items_failed, 1);
        assert!(s.failures[0].reason.contains("validate"));
    }

    /// codex PR-Z P2 回帰: 衝突 ID + 空 name のレコードが来ても、id 衝突を
    /// 優先して **Skipped** として計上される。再インポート idempotency の根拠。
    #[test]
    fn project_with_duplicate_id_is_skipped_even_when_name_is_empty() {
        let (storage, modules) = setup(1);
        // 1 回目: 正常な name で投入
        apply_import(
            &storage,
            &modules,
            &data_with(vec![ProjectWithItems {
                project: project("p1", "Original"),
                items: vec![],
            }]),
        );

        // 2 回目: 同 ID で空 name (ファイル改ざん等)。validation_failed ではなく Skipped
        let bad_dup = ProjectExport {
            name: "".into(),
            ..project("p1", "ignored")
        };
        let s = apply_import(
            &storage,
            &modules,
            &data_with(vec![ProjectWithItems {
                project: bad_dup,
                items: vec![],
            }]),
        );
        assert_eq!(
            s.projects_skipped, 1,
            "duplicate id wins over empty-name validation"
        );
        assert_eq!(s.projects_failed, 0);
    }

    /// codex PR-Z P2 回帰 (item 版): 衝突 ID + 空 title でも Skipped で計上される。
    #[test]
    fn item_with_duplicate_id_is_skipped_even_when_title_is_empty() {
        let (storage, modules) = setup(1);
        // 1 回目: 正常な item を投入
        apply_import(
            &storage,
            &modules,
            &data_with(vec![ProjectWithItems {
                project: project("p1", "P"),
                items: vec![item("i1", 1, json!({"body": "ok"}))],
            }]),
        );

        // 2 回目: 同 ID + 空 title。items_failed ではなく items_skipped に計上
        let bad_dup = ItemExport {
            title: "".into(),
            ..item("i1", 1, json!({"body": "ok"}))
        };
        let s = apply_import(
            &storage,
            &modules,
            &data_with(vec![ProjectWithItems {
                project: project("p1", "P"),
                items: vec![bad_dup],
            }]),
        );
        assert_eq!(
            s.items_skipped, 1,
            "duplicate id wins over empty-title validation"
        );
        assert_eq!(s.items_failed, 0);
    }

    /// codex PR-Y P1 回帰: 全件 skip / failed のみ (新規 INSERT 0 件) のスコープでは
    /// `normalize_item_positions` が走らず、`data_revision` も増えない。再 import を
    /// no-op として扱う冪等性の根拠。
    #[test]
    fn second_import_with_only_skipped_items_does_not_normalize_or_bump_revision() {
        let (storage, modules) = setup(1);
        let data = data_with(vec![ProjectWithItems {
            project: project("p1", "P"),
            items: vec![
                item("i1", 1, json!({"body": "a"})),
                item("i2", 1, json!({"body": "b"})),
            ],
        }]);

        // 1 回目: 全件 INSERT (+ normalize で position を 0..1 に詰める)
        apply_import(&storage, &modules, &data);
        let revision_after_first = storage.data_revision().unwrap();

        // 2 回目: 同じ JSON → 全件 skip。normalize が走らないので data_revision は変化しない
        let summary2 = apply_import(&storage, &modules, &data);
        assert_eq!(summary2.items_inserted, 0);
        assert_eq!(summary2.items_skipped, 2);
        assert_eq!(summary2.items_failed, 0);
        assert_eq!(
            storage.data_revision().unwrap(),
            revision_after_first,
            "no-op re-import must not bump data_revision (codex PR-Y P1 idempotency)"
        );
    }
}
