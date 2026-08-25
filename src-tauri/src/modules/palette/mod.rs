//! M-Palette: 5 色カラーパレット作成モジュール (`requirements.md` §2.2 /
//! `data-model.md` §10.6 / `module-contract.md` §12.6)。
//!
//! ## payload (version 1)
//! ```jsonc
//! {
//!   "colors": ["#2563EB", "#3B82F6", "#60A5FA", "#818CF8", "#A78BFA"],
//!   "harmony": "analogous",
//!   "base_index": 2
//! }
//! ```

use serde_json::Value as JsonValue;

use crate::module::{ModuleBackend, ModuleError};

const HARMONIES: [&str; 9] = [
    "custom",
    "analogous",
    "complementary",
    "split_complementary",
    "triad",
    "square",
    "compound",
    "shades",
    "monochromatic",
];

/// M-Palette の `ModuleBackend` 実装。
pub struct PaletteModule;

impl ModuleBackend for PaletteModule {
    fn id(&self) -> &'static str {
        "palette"
    }

    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
        let colors = payload
            .get("colors")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| validation("palette payload must have `colors` array field"))?;
        if colors.len() != 5 {
            return Err(validation(
                "palette `colors` must contain exactly 5 entries",
            ));
        }
        for (index, color) in colors.iter().enumerate() {
            let hex = color
                .as_str()
                .ok_or_else(|| validation(format!("palette color {index} must be a string")))?;
            if !is_valid_hex6(hex) {
                return Err(validation(format!(
                    "invalid palette color at index {index}: {hex} (expected #RRGGBB)"
                )));
            }
        }

        let harmony = payload
            .get("harmony")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| validation("palette payload must have `harmony` string field"))?;
        if !HARMONIES.contains(&harmony) {
            return Err(validation(format!("invalid palette harmony: {harmony}")));
        }

        let base_index = payload
            .get("base_index")
            .and_then(JsonValue::as_u64)
            .ok_or_else(|| validation("palette payload must have `base_index` integer field"))?;
        if base_index >= 5 {
            return Err(validation("palette `base_index` must be between 0 and 4"));
        }
        Ok(())
    }

    fn index_text(&self, payload: &JsonValue) -> String {
        let mut parts = payload
            .get("colors")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter_map(JsonValue::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if let Some(harmony) = payload.get("harmony").and_then(JsonValue::as_str) {
            parts.push(harmony.to_string());
        }
        parts.join(" ")
    }
}

fn validation(reason: impl Into<String>) -> ModuleError {
    ModuleError::ValidationFailed {
        reason: reason.into(),
    }
}

fn is_valid_hex6(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes.first() == Some(&b'#') && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_payload() -> JsonValue {
        json!({
            "colors": ["#2563EB", "#3B82F6", "#60A5FA", "#818CF8", "#A78BFA"],
            "harmony": "analogous",
            "base_index": 2
        })
    }

    #[test]
    fn declares_stateful_palette_v1() {
        assert_eq!(PaletteModule.id(), "palette");
        assert!(!PaletteModule.is_stateless());
        assert_eq!(PaletteModule.current_payload_version(), 1);
    }

    #[test]
    fn validates_supported_payload() {
        for harmony in HARMONIES {
            let mut payload = valid_payload();
            payload["harmony"] = json!(harmony);
            PaletteModule.validate_payload(&payload).unwrap();
        }
    }

    #[test]
    fn rejects_wrong_color_count_and_invalid_hex() {
        let mut short = valid_payload();
        short["colors"] = json!(["#000000"]);
        assert!(PaletteModule.validate_payload(&short).is_err());

        let mut invalid = valid_payload();
        invalid["colors"][3] = json!("#12345678");
        assert!(PaletteModule.validate_payload(&invalid).is_err());
    }

    #[test]
    fn rejects_unknown_harmony_and_base_index() {
        let mut harmony = valid_payload();
        harmony["harmony"] = json!("rainbow");
        assert!(PaletteModule.validate_payload(&harmony).is_err());

        let mut base = valid_payload();
        base["base_index"] = json!(5);
        assert!(PaletteModule.validate_payload(&base).is_err());
    }

    #[test]
    fn indexes_all_colors_and_harmony() {
        assert_eq!(
            PaletteModule.index_text(&valid_payload()),
            "#2563EB #3B82F6 #60A5FA #818CF8 #A78BFA analogous"
        );
    }
}
