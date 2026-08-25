//! M-Memo: Markdown メモ管理モジュール。
//!
//! payload v1 は `{ "body": string }`。本文は空文字を許可しない。

use serde_json::Value as JsonValue;

use crate::module::{ModuleBackend, ModuleError};

pub struct MemoModule;

impl ModuleBackend for MemoModule {
    fn id(&self) -> &'static str {
        "memo"
    }

    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
        let body = payload
            .get("body")
            .and_then(|value| value.as_str())
            .ok_or_else(|| ModuleError::ValidationFailed {
                reason: "memo payload must have `body` string".into(),
            })?;
        if body.trim().is_empty() {
            return Err(ModuleError::ValidationFailed {
                reason: "memo body must not be empty".into(),
            });
        }
        Ok(())
    }

    fn index_text(&self, payload: &JsonValue) -> String {
        payload
            .get("body")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_and_indexes_body() {
        MemoModule
            .validate_payload(&json!({"body": "# 見出し\n本文"}))
            .unwrap();
        assert_eq!(MemoModule.index_text(&json!({"body": "本文"})), "本文");
    }

    #[test]
    fn rejects_missing_or_empty_body() {
        assert!(MemoModule.validate_payload(&json!({})).is_err());
        assert!(MemoModule.validate_payload(&json!({"body": "  "})).is_err());
    }
}
