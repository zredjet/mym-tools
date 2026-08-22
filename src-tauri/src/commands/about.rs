//! About 画面 (`docs/ui-design.md` §6.10 C-9) の補助 Tauri コマンド。
//!
//! - `core_module_versions`: 各 stateful モジュールの `id` と `current_payload_version`
//!   を返す。About 画面の「payload schema (現在認識)」表示で使う (`docs/ui-design.md`
//!   §6.10 末尾)。stateless モジュール (M-Hash) は payload を持たないため除外する
//!   (`module-contract.md` §9.2)。
//! - `core_module_ids`: stateless を含む全 backend ID を返す。Frontend registry と起動時に
//!   照合し、片側だけ登録されたビルドを停止する (`module-contract.md` §2)。
//!
//! 他の About 情報源:
//! - **アプリ version**: フロント `@tauri-apps/api/app::getVersion()` で `tauri.conf.json`
//!   から直接取得
//! - **OS / arch**: フロント `@tauri-apps/plugin-os::platform()` / `arch()` / `version()`
//! - **userdata dir path**: フロント `@tauri-apps/api/path::appDataDir()` で取得し、
//!   `@tauri-apps/plugin-opener::openPath()` で OS ファイラを起動
//!
//! いずれもフロント側で完結するため Tauri コマンドは不要。本ファイルは payload schema
//! 情報 (= バックエンドの ModuleRegistry が一次ソース) だけを返す薄いラッパに専念する。

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// About 画面の payload schema 表示用 1 行 (`docs/ui-design.md` §6.10)。
#[derive(Debug, Clone, Serialize)]
pub struct ModuleVersionInfo {
    /// モジュール ID (例: `"prompt"` / `"linkmemo"` / `"color"`)。stateless モジュール
    /// (例: `"hash"`) は payload を持たないため本リストには **含めない**。
    pub module_id: String,
    /// 現在のアプリビルドが書き込む payload バージョン (`current_payload_version()`)。
    pub current_payload_version: u32,
}

/// stateful モジュールの (id, current_payload_version) を **id 昇順** で返す。
///
/// 順序を昇順固定にしているのは UI 側の表示安定性のため (`HashMap` 反復だと順序が
/// build / runtime で変わる)。
#[tauri::command]
pub fn core_module_versions(
    state: State<'_, AppState>,
) -> Result<Vec<ModuleVersionInfo>, AppError> {
    Ok(collect_module_versions(&state.modules))
}

/// stateless を含む全 backend ID を **id 昇順**で返す。
#[tauri::command]
pub fn core_module_ids(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    Ok(collect_module_ids(&state.modules))
}

/// `core_module_versions` の内部ロジック (`tauri::State` を介さずユニットテスト可能な形)。
///
/// 公開コマンド本体は `tauri::State<'_, AppState>` を受けるためテストから直接呼べない。
/// 同じ手法は `commands/cancel.rs` の `core_cancel_operation` でも採られている。
fn collect_module_versions(
    modules: &std::collections::HashMap<
        &'static str,
        std::sync::Arc<dyn crate::module::ModuleBackend>,
    >,
) -> Vec<ModuleVersionInfo> {
    let mut entries: Vec<ModuleVersionInfo> = modules
        .values()
        .filter(|m| !m.is_stateless())
        .map(|m| ModuleVersionInfo {
            module_id: m.id().to_string(),
            current_payload_version: m.current_payload_version(),
        })
        .collect();
    entries.sort_by(|a, b| a.module_id.cmp(&b.module_id));
    entries
}

fn collect_module_ids(
    modules: &std::collections::HashMap<
        &'static str,
        std::sync::Arc<dyn crate::module::ModuleBackend>,
    >,
) -> Vec<String> {
    let mut ids: Vec<String> = modules.keys().map(|id| (*id).to_string()).collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::{ModuleBackend, ModuleError};
    use std::collections::HashMap;
    use std::sync::Arc;

    struct StubModule {
        id: &'static str,
        version: u32,
        stateless: bool,
    }
    impl ModuleBackend for StubModule {
        fn id(&self) -> &'static str {
            self.id
        }
        fn is_stateless(&self) -> bool {
            self.stateless
        }
        fn current_payload_version(&self) -> u32 {
            self.version
        }
        fn validate_payload(&self, _payload: &serde_json::Value) -> Result<(), ModuleError> {
            Ok(())
        }
    }

    fn map(
        modules: Vec<(&'static str, u32, bool)>,
    ) -> HashMap<&'static str, Arc<dyn ModuleBackend>> {
        modules
            .into_iter()
            .map(|(id, version, stateless)| {
                let m: Arc<dyn ModuleBackend> = Arc::new(StubModule {
                    id,
                    version,
                    stateless,
                });
                (id, m)
            })
            .collect()
    }

    #[test]
    fn returns_stateful_modules_only() {
        // hash は stateless なので除外される
        let modules = map(vec![
            ("prompt", 1, false),
            ("linkmemo", 2, false),
            ("hash", 1, true),
        ]);
        let entries = collect_module_versions(&modules);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.module_id != "hash"));
    }

    #[test]
    fn results_are_sorted_by_module_id_ascending() {
        // HashMap の反復順は非決定的だが、出力は常に id 昇順
        let modules = map(vec![
            ("zebra", 1, false),
            ("apple", 1, false),
            ("mango", 1, false),
        ]);
        let entries = collect_module_versions(&modules);
        assert_eq!(
            entries
                .iter()
                .map(|e| e.module_id.as_str())
                .collect::<Vec<_>>(),
            vec!["apple", "mango", "zebra"]
        );
    }

    #[test]
    fn preserves_current_payload_version_per_module() {
        let modules = map(vec![("prompt", 3, false), ("linkmemo", 7, false)]);
        let entries = collect_module_versions(&modules);
        let prompt = entries.iter().find(|e| e.module_id == "prompt").unwrap();
        let linkmemo = entries.iter().find(|e| e.module_id == "linkmemo").unwrap();
        assert_eq!(prompt.current_payload_version, 3);
        assert_eq!(linkmemo.current_payload_version, 7);
    }

    #[test]
    fn empty_module_map_returns_empty_list() {
        let modules: HashMap<&'static str, Arc<dyn ModuleBackend>> = HashMap::new();
        assert!(collect_module_versions(&modules).is_empty());
    }

    #[test]
    fn all_stateless_returns_empty_list() {
        let modules = map(vec![("hash", 1, true), ("hash2", 1, true)]);
        assert!(collect_module_versions(&modules).is_empty());
    }

    #[test]
    fn module_ids_include_stateless_modules_and_are_sorted() {
        let modules = map(vec![
            ("prompt", 1, false),
            ("hash", 1, true),
            ("color", 1, false),
        ]);

        assert_eq!(
            collect_module_ids(&modules),
            vec!["color", "hash", "prompt"]
        );
    }
}
