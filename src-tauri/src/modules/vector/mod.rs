//! キャンバス (ADR-0026)。payload v2 はシーン形式 (`docs/canvas-editor-design.md` §3)。
//! 保存・JSON 取込・Eager-on-Read のどの経路も、この `VectorModule` の検証を通る。
pub mod commands;
mod drawio_import;
mod scene;
mod upgrade;
mod validation;

use crate::module::{ModuleBackend, ModuleError};
use serde_json::Value;
pub use validation::{validate_svg, MAX_SVG_BYTES, MAX_TEXT_BYTES};

/// v1 は `{ svg, text }` (ADR-0021)、v2 は `{ pages, nodes, assets, text }` (ADR-0026)。
const CURRENT_PAYLOAD_VERSION: u32 = 2;

pub struct VectorModule;
impl ModuleBackend for VectorModule {
    fn id(&self) -> &'static str {
        "vector"
    }
    fn search_preview_field(&self) -> Option<&'static str> {
        Some("text")
    }
    fn current_payload_version(&self) -> u32 {
        CURRENT_PAYLOAD_VERSION
    }
    /// v1 の SVG を編集できない埋め込み SVG 1 個の文書に包む (§3.7)。変換結果が v2 の検証を
    /// 通らなければ `UpgradeFailed` を返し、呼び出し側 (Eager-on-Read) は v1 の行を書き換えない。
    fn upgrade_payload(&self, from_version: u32, payload: Value) -> Result<Value, ModuleError> {
        match from_version {
            1 => upgrade::upgrade_v1(&payload),
            other => Err(ModuleError::UnknownPayloadVersion(other)),
        }
    }
    fn validate_payload(&self, payload: &Value) -> Result<(), ModuleError> {
        scene::validate(payload)
    }
    /// 検索用テキスト `text` (§3.6)。`validate_payload` が文書から求め直した値と一致することを確かめている。
    fn index_text(&self, payload: &Value) -> String {
        payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }
}
