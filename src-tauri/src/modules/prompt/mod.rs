//! M-Prompt: プロンプト管理モジュール (`requirements.md` §2.2 / `data-model.md` §10.1 /
//! `module-contract.md` §12.1)。
//!
//! ## payload (version 1)
//! ```jsonc
//! { "body": "Translate the following to {{language}}: {{text}}" }
//! ```
//!
//! - `title` (共通カラム): プロンプトのタイトル
//! - `body`: プロンプト本文 (Markdown レンダリングはフロント側 `react-markdown` で実施)
//! - 変数プレースホルダ (`{{name}}`) は **保存しない** (`data-model.md` §10.1)。
//!   読み込み時に `template::extract_variables()` で抽出して UI のフォーム生成に使う
//!
//! ## search_text 生成 (`data-model.md` §10.1)
//! `title + " " + body` の `body` 部分を `index_text` で返す。

pub mod commands;
pub mod template;

use serde_json::Value as JsonValue;

use crate::module::{ModuleBackend, ModuleError};

/// M-Prompt の `ModuleBackend` 実装。
pub struct PromptModule;

impl ModuleBackend for PromptModule {
    fn id(&self) -> &'static str {
        "prompt"
    }

    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
        let body = payload
            .get("body")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ModuleError::ValidationFailed {
                reason: "prompt payload must have `body` string field".into(),
            })?;
        if body.is_empty() {
            return Err(ModuleError::ValidationFailed {
                reason: "prompt body must not be empty".into(),
            });
        }
        Ok(())
    }

    fn index_text(&self, payload: &JsonValue) -> String {
        payload
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_is_prompt() {
        assert_eq!(PromptModule.id(), "prompt");
    }

    #[test]
    fn is_stateless_is_false() {
        assert!(!PromptModule.is_stateless());
    }

    #[test]
    fn current_payload_version_is_1() {
        assert_eq!(PromptModule.current_payload_version(), 1);
    }

    #[test]
    fn validate_with_body_succeeds() {
        PromptModule
            .validate_payload(&json!({"body": "Translate {{text}}"}))
            .unwrap();
    }

    #[test]
    fn validate_missing_body_rejected() {
        let err = PromptModule
            .validate_payload(&json!({"title": "x"}))
            .unwrap_err();
        match err {
            ModuleError::ValidationFailed { reason } => assert!(reason.contains("body")),
            other => panic!("expected ValidationFailed, got: {other:?}"),
        }
    }

    #[test]
    fn validate_empty_body_rejected() {
        let err = PromptModule
            .validate_payload(&json!({"body": ""}))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn validate_non_string_body_rejected() {
        let err = PromptModule
            .validate_payload(&json!({"body": 123}))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn index_text_returns_body() {
        assert_eq!(
            PromptModule.index_text(&json!({"body": "Translate {{text}}"})),
            "Translate {{text}}"
        );
    }

    #[test]
    fn index_text_empty_when_missing() {
        assert_eq!(PromptModule.index_text(&json!({})), "");
    }
}
