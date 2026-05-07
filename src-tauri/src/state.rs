//! `AppState` — Tauri コマンドが受け取る共有状態 (`module-contract.md` §5.1)。
//!
//! Phase 1 のレイヤ追加に応じて段階的に拡張する:
//! - **PR-B (本 PR)**: `modules: HashMap<&'static str, Arc<dyn ModuleBackend>>` のみ
//! - **PR-C**: `operations: Arc<OperationRegistry>` を追加 (ADR-0009 §2.2)
//! - **PR-D**: `storage: Arc<dyn StorageService>` を追加 (`module-contract.md` §5.1)
//!
//! `AppState` 自体は `Send + Sync` (中身が `Arc` で包まれているため)。`tauri::State<'_, AppState>`
//! を `#[tauri::command]` の引数に取る形でアクセスする。

use std::collections::HashMap;
use std::sync::Arc;

use crate::module::ModuleBackend;

/// アプリケーション全体の共有状態。
pub struct AppState {
    /// `module_id` → `ModuleBackend` の引き当て表。
    /// `modules::registry::module_backends()` を `id()` をキーに詰め直して構築する
    /// (`build()` 関数参照)。
    pub modules: HashMap<&'static str, Arc<dyn ModuleBackend>>,
}

impl std::fmt::Debug for AppState {
    /// `dyn ModuleBackend` は Debug を実装しないため、登録済 module_id のみを表示する。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut ids: Vec<&str> = self.modules.keys().copied().collect();
        ids.sort();
        f.debug_struct("AppState").field("modules", &ids).finish()
    }
}

impl AppState {
    /// `Arc<dyn ModuleBackend>` の Vec から `AppState` を構築する。
    /// 同 id が複数あったら起動を停止する (`module-contract.md` §2: 「不一致や重複があれば
    /// アプリは起動を停止する」)。
    pub fn build(backends: Vec<Arc<dyn ModuleBackend>>) -> Result<Self, BuildError> {
        let mut modules = HashMap::new();
        for backend in backends {
            let id = backend.id();
            validate_module_id(id)?;
            if modules.insert(id, backend).is_some() {
                return Err(BuildError::DuplicateId(id.to_string()));
            }
        }
        Ok(AppState { modules })
    }

    /// `module_id` で ModuleBackend を引く。見つからなければ None。
    /// 通常は Tauri command 内で `state.modules.get(module_id).cloned()` するための薄いラッパ。
    pub fn module(&self, id: &str) -> Option<Arc<dyn ModuleBackend>> {
        self.modules.get(id).cloned()
    }
}

/// `AppState::build` の失敗種別 (起動時のみ発生、ランタイム後は生じない)。
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("invalid module id: {0:?} — must be 3-32 lowercase ASCII letters/digits")]
    InvalidId(String),

    #[error("duplicate module id: {0:?}")]
    DuplicateId(String),
}

/// `module-contract.md` §3.2 `id()` の制約: 英小文字 / 数字のみ、3〜32 文字。
fn validate_module_id(id: &str) -> Result<(), BuildError> {
    if id.len() < 3 || id.len() > 32 {
        return Err(BuildError::InvalidId(id.to_string()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(BuildError::InvalidId(id.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as JsonValue;

    struct StubModule(&'static str);
    impl ModuleBackend for StubModule {
        fn id(&self) -> &'static str {
            self.0
        }
        fn validate_payload(&self, _payload: &JsonValue) -> Result<(), crate::module::ModuleError> {
            Ok(())
        }
    }

    fn stub(id: &'static str) -> Arc<dyn ModuleBackend> {
        Arc::new(StubModule(id))
    }

    #[test]
    fn build_with_unique_ids_succeeds() {
        let state = AppState::build(vec![stub("hash"), stub("prompt"), stub("color")]).unwrap();
        assert_eq!(state.modules.len(), 3);
        assert!(state.module("hash").is_some());
        assert!(state.module("prompt").is_some());
        assert!(state.module("color").is_some());
        assert!(state.module("nope").is_none());
    }

    #[test]
    fn build_rejects_duplicate_ids() {
        let err = AppState::build(vec![stub("hash"), stub("hash")]).unwrap_err();
        match err {
            BuildError::DuplicateId(id) => assert_eq!(id, "hash"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn build_rejects_too_short_id() {
        let err = AppState::build(vec![stub("hi")]).unwrap_err();
        assert!(matches!(err, BuildError::InvalidId(_)));
    }

    #[test]
    fn build_rejects_uppercase_id() {
        let err = AppState::build(vec![stub("Hash")]).unwrap_err();
        assert!(matches!(err, BuildError::InvalidId(_)));
    }

    #[test]
    fn build_rejects_id_with_hyphen() {
        let err = AppState::build(vec![stub("link-memo")]).unwrap_err();
        assert!(matches!(err, BuildError::InvalidId(_)));
    }

    #[test]
    fn build_rejects_id_with_underscore() {
        let err = AppState::build(vec![stub("link_memo")]).unwrap_err();
        assert!(matches!(err, BuildError::InvalidId(_)));
    }
}
