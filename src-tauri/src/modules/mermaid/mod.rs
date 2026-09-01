//! M-Mermaid: Mermaid source とプレビューをプロジェクト保存するモジュール。
//!
//! payload v1 は `{ "source": string }`。レンダリングと構文検査は固定した Mermaid
//! runtime の責任で、backend は保存境界として空文字と 1 MiB 超過を拒否する。

pub mod commands;

use serde_json::Value as JsonValue;

use crate::module::{ModuleBackend, ModuleError};

const MAX_SOURCE_BYTES: usize = 1024 * 1024;

pub struct MermaidModule;

impl ModuleBackend for MermaidModule {
    fn id(&self) -> &'static str {
        "mermaid"
    }

    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
        let source = payload
            .get("source")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| validation("mermaid payload must have `source` string"))?;
        if source.trim().is_empty() {
            return Err(validation("mermaid source must not be empty"));
        }
        if source.len() > MAX_SOURCE_BYTES {
            return Err(validation("mermaid source must be 1 MiB or smaller"));
        }
        Ok(())
    }

    fn index_text(&self, payload: &JsonValue) -> String {
        payload
            .get("source")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string()
    }
}

fn validation(reason: impl Into<String>) -> ModuleError {
    ModuleError::ValidationFailed {
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_and_indexes_source() {
        let payload = json!({"source": "flowchart TD\nA --> B"});
        MermaidModule.validate_payload(&payload).unwrap();
        assert_eq!(MermaidModule.index_text(&payload), "flowchart TD\nA --> B");
    }

    #[test]
    fn rejects_empty_and_oversized_source() {
        assert!(MermaidModule
            .validate_payload(&json!({"source": "  "}))
            .is_err());
        assert!(MermaidModule
            .validate_payload(&json!({"source": "x".repeat(MAX_SOURCE_BYTES + 1)}))
            .is_err());
    }
}
