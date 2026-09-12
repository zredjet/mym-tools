//! Project-owned SVG documents. Every persistence entry point uses this policy.
pub mod commands;
pub mod protocol;
mod validation;

use crate::module::{ModuleBackend, ModuleError};
use serde_json::Value;
pub use validation::{validate_svg, MAX_SVG_BYTES, MAX_TEXT_BYTES};

pub struct VectorModule;
impl ModuleBackend for VectorModule {
    fn id(&self) -> &'static str {
        "vector"
    }
    fn search_preview_field(&self) -> Option<&'static str> {
        Some("text")
    }
    fn validate_payload(&self, payload: &Value) -> Result<(), ModuleError> {
        let svg = payload
            .get("svg")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("svg must be a string"))?;
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("text must be a string"))?;
        if text.len() > MAX_TEXT_BYTES {
            return Err(invalid("検索用テキストは1MiB以下にしてください。"));
        }
        let actual = validate_svg(svg).map_err(|e| invalid(e.to_string()))?;
        if actual != text {
            return Err(invalid("検索用テキストがSVGと一致しません。"));
        }
        Ok(())
    }
    fn index_text(&self, payload: &Value) -> String {
        payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }
}
fn invalid(reason: impl Into<String>) -> ModuleError {
    ModuleError::ValidationFailed {
        reason: reason.into(),
    }
}
