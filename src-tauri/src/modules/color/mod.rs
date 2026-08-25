//! M-Color: 色管理モジュール (`requirements.md` §2.2 / `data-model.md` §10.4 /
//! `module-contract.md` §12.4)。
//!
//! ## payload (version 1)
//! ```jsonc
//! { "hex": "#RRGGBB" or "#RRGGBBAA" }
//! ```
//!
//! - `title` (共通カラム): 色の名前 (例: "アクセント1", "primary"、CLAUDE.md にある通り
//!   `name` フィールドは持たず `title` を使う)
//! - `hex`: `#RRGGBB` または `#RRGGBBAA` の HEX 表現。ASCII 大文字/小文字は両方受理する
//!   (フロント側で正規化、バリデータは形式のみ確認)
//! - 固有 IPC コマンド: なし (RGB/HSL 変換は全てフロント JS 上)
//!
//! ## search_text 生成 (`data-model.md` §10.4)
//! `title + " " + hex`

use serde_json::Value as JsonValue;

use crate::module::{ModuleBackend, ModuleError};

/// M-Color の `ModuleBackend` 実装。
pub struct ColorModule;

impl ModuleBackend for ColorModule {
    fn id(&self) -> &'static str {
        "color"
    }

    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
        let hex = payload.get("hex").and_then(|v| v.as_str()).ok_or_else(|| {
            ModuleError::ValidationFailed {
                reason: "color payload must have `hex` string field".into(),
            }
        })?;
        if !is_valid_hex(hex) {
            return Err(ModuleError::ValidationFailed {
                reason: format!("invalid hex format: {hex} (expected #RRGGBB or #RRGGBBAA)"),
            });
        }
        Ok(())
    }

    fn index_text(&self, payload: &JsonValue) -> String {
        payload
            .get("hex")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }
}

/// `#RRGGBB` または `#RRGGBBAA` 形式かを判定 (大小文字どちらも許容)。
fn is_valid_hex(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'#') {
        return false;
    }
    let body = &bytes[1..];
    if body.len() != 6 && body.len() != 8 {
        return false;
    }
    body.iter().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_is_color() {
        assert_eq!(ColorModule.id(), "color");
    }

    #[test]
    fn is_stateless_is_false() {
        assert!(!ColorModule.is_stateless());
    }

    #[test]
    fn current_payload_version_is_1() {
        assert_eq!(ColorModule.current_payload_version(), 1);
    }

    #[test]
    fn validate_accepts_rrggbb_uppercase() {
        ColorModule
            .validate_payload(&json!({"hex": "#FF5733"}))
            .unwrap();
    }

    #[test]
    fn validate_accepts_rrggbb_lowercase() {
        // フロント正規化前の入力経路を考慮して大小文字どちらも受理 (data-model.md §10.4)
        ColorModule
            .validate_payload(&json!({"hex": "#ff5733"}))
            .unwrap();
    }

    #[test]
    fn validate_accepts_rrggbbaa_with_alpha() {
        ColorModule
            .validate_payload(&json!({"hex": "#FF5733AA"}))
            .unwrap();
    }

    #[test]
    fn validate_rejects_missing_hex() {
        let err = ColorModule
            .validate_payload(&json!({"name": "red"}))
            .unwrap_err();
        match err {
            ModuleError::ValidationFailed { reason } => {
                assert!(reason.contains("hex"));
            }
            other => panic!("expected ValidationFailed, got: {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_no_hash_prefix() {
        let err = ColorModule
            .validate_payload(&json!({"hex": "FF5733"}))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn validate_rejects_wrong_length() {
        // 3 桁ショートハンド (#FFF) は rejection (Phase 1 では正規化 6 桁のみ)
        ColorModule
            .validate_payload(&json!({"hex": "#FFF"}))
            .unwrap_err();
        // 7 桁
        ColorModule
            .validate_payload(&json!({"hex": "#1234567"}))
            .unwrap_err();
        // 9 桁
        ColorModule
            .validate_payload(&json!({"hex": "#123456789"}))
            .unwrap_err();
    }

    #[test]
    fn validate_rejects_non_hex_chars() {
        let err = ColorModule
            .validate_payload(&json!({"hex": "#GGHHII"}))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn validate_rejects_non_string_hex() {
        let err = ColorModule
            .validate_payload(&json!({"hex": 123456}))
            .unwrap_err();
        assert!(matches!(err, ModuleError::ValidationFailed { .. }));
    }

    #[test]
    fn index_text_returns_hex() {
        assert_eq!(
            ColorModule.index_text(&json!({"hex": "#FF5733"})),
            "#FF5733"
        );
    }

    #[test]
    fn index_text_returns_empty_when_missing() {
        assert_eq!(ColorModule.index_text(&json!({})), "");
    }
}
