//! M-Link: URL / Path 管理モジュール (`requirements.md` §2.2 / `data-model.md`
//! §10.2 / `module-contract.md` §12.2)。
//!
//! ## payload (version 1)
//! ```jsonc
//! {
//!   "type": "url" | "path",
//!   "target": "https://..." | "/Users/x/folder" | "\\\\server\\share\\dir",
//!   "body": "..."
//! }
//! ```
//!
//! ## バリデーション (`data-model.md` §10.2)
//! - `type=url`: `target` は `http://` または `https://` で始まる
//! - `type=path`: `target` は空文字でない
//! - `file://` で入力された URL は `linkmemo_normalize_target` で path に変換される前提。
//!   そのため `validate_payload` の段階で `type=url` & `target.starts_with("file://")` は
//!   形式違反として弾く
//!
//! ## search_text 生成 (`data-model.md` §10.2)
//! `title + " " + (target ?? "") + " " + body` の `target + body` 部分を本モジュールの
//! `index_text` で返す (title は StorageService が共通カラムから付ける)。

pub mod commands;
pub mod normalize;

use serde_json::Value as JsonValue;

use crate::module::{ModuleBackend, ModuleError};

/// 公開済み ID `linkmemo` を維持する M-Link の `ModuleBackend` 実装。
pub struct LinkMemoModule;

impl ModuleBackend for LinkMemoModule {
    fn id(&self) -> &'static str {
        "linkmemo"
    }

    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
        let type_ = payload
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ModuleError::ValidationFailed {
                reason: "linkmemo payload must have `type` field".into(),
            })?;
        let target = payload.get("target").and_then(|v| v.as_str());
        payload
            .get("body")
            .and_then(|value| value.as_str())
            .ok_or_else(|| ModuleError::ValidationFailed {
                reason: "linkmemo payload must have `body` string".into(),
            })?;
        match type_ {
            "url" => {
                let t = target.ok_or_else(|| ModuleError::ValidationFailed {
                    reason: "linkmemo type=url requires target string".into(),
                })?;
                if !(t.starts_with("http://") || t.starts_with("https://")) {
                    return Err(ModuleError::ValidationFailed {
                        reason: format!(
                            "linkmemo type=url target must start with http:// or https://: {t}"
                        ),
                    });
                }
            }
            "path" => {
                let t = target.ok_or_else(|| ModuleError::ValidationFailed {
                    reason: "linkmemo type=path requires target string".into(),
                })?;
                if t.is_empty() {
                    return Err(ModuleError::ValidationFailed {
                        reason: "linkmemo type=path target must not be empty".into(),
                    });
                }
            }
            other => {
                return Err(ModuleError::ValidationFailed {
                    reason: format!("invalid linkmemo type: {other}"),
                });
            }
        }
        Ok(())
    }

    fn index_text(&self, payload: &JsonValue) -> String {
        // `data-model.md` §10.2: search_text 生成は `target + " " + body`
        let target = payload.get("target").and_then(|v| v.as_str()).unwrap_or("");
        let body = payload.get("body").and_then(|v| v.as_str()).unwrap_or("");
        match (target.is_empty(), body.is_empty()) {
            (true, true) => String::new(),
            (true, false) => body.to_string(),
            (false, true) => target.to_string(),
            (false, false) => format!("{target} {body}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_is_linkmemo() {
        assert_eq!(LinkMemoModule.id(), "linkmemo");
    }

    #[test]
    fn is_stateless_is_false() {
        assert!(!LinkMemoModule.is_stateless());
    }

    // -------- validate: url --------

    #[test]
    fn validate_url_https_succeeds() {
        LinkMemoModule
            .validate_payload(&json!({
                "type": "url",
                "target": "https://example.com",
                "body": ""
            }))
            .unwrap();
    }

    #[test]
    fn validate_url_http_succeeds() {
        LinkMemoModule
            .validate_payload(&json!({
                "type": "url",
                "target": "http://example.com",
                "body": ""
            }))
            .unwrap();
    }

    #[test]
    fn validate_url_with_file_scheme_rejected() {
        // file:// は normalize_target で path に変換される前提。
        // validate 段階で type=url & file:// は形式違反として弾く。
        let err = LinkMemoModule
            .validate_payload(&json!({
                "type": "url",
                "target": "file:///Users/x",
                "body": ""
            }))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn validate_url_missing_target_rejected() {
        let err = LinkMemoModule
            .validate_payload(&json!({"type": "url", "body": ""}))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    // -------- validate: path --------

    #[test]
    fn validate_path_local_succeeds() {
        LinkMemoModule
            .validate_payload(&json!({
                "type": "path",
                "target": "/Users/redjet/folder",
                "body": ""
            }))
            .unwrap();
    }

    #[test]
    fn validate_path_unc_succeeds() {
        LinkMemoModule
            .validate_payload(&json!({
                "type": "path",
                "target": "\\\\server\\share\\dir",
                "body": ""
            }))
            .unwrap();
    }

    #[test]
    fn validate_missing_body_rejected() {
        let err = LinkMemoModule
            .validate_payload(&json!({
                "type": "path",
                "target": "/tmp"
            }))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn validate_path_empty_target_rejected() {
        let err = LinkMemoModule
            .validate_payload(&json!({
                "type": "path",
                "target": "",
                "body": ""
            }))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    // -------- validate: memo --------

    #[test]
    fn validate_memo_with_body_rejected_after_split() {
        let err = LinkMemoModule
            .validate_payload(&json!({
                "type": "memo",
                "target": null,
                "body": "メモ本文"
            }))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn validate_memo_empty_body_rejected() {
        let err = LinkMemoModule
            .validate_payload(&json!({
                "type": "memo",
                "target": null,
                "body": ""
            }))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    // -------- validate: 不正な type --------

    #[test]
    fn validate_unknown_type_rejected() {
        let err = LinkMemoModule
            .validate_payload(&json!({"type": "ftp", "target": "ftp://x", "body": ""}))
            .unwrap_err();
        match err {
            ModuleError::ValidationFailed { reason } => assert!(reason.contains("ftp")),
            other => panic!("expected ValidationFailed, got: {other:?}"),
        }
    }

    #[test]
    fn validate_missing_type_rejected() {
        let err = LinkMemoModule
            .validate_payload(&json!({"target": "https://example.com"}))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    // -------- index_text --------

    #[test]
    fn index_text_url_with_body() {
        let s = LinkMemoModule.index_text(&json!({
            "type": "url",
            "target": "https://example.com",
            "body": "公式サイト"
        }));
        assert_eq!(s, "https://example.com 公式サイト");
    }

    #[test]
    fn index_text_path_no_body() {
        let s = LinkMemoModule.index_text(&json!({
            "type": "path",
            "target": "/Users/x/folder",
            "body": ""
        }));
        assert_eq!(s, "/Users/x/folder");
    }

    #[test]
    fn index_text_empty_payload() {
        let s = LinkMemoModule.index_text(&json!({}));
        assert_eq!(s, "");
    }
}
