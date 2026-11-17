//! キャンバス (ADR-0026、ADR-0028)。payload v2 / v3 はシーン形式 (`docs/canvas-editor-design.md` §3、§8.3)。
//! 保存・JSON 取込・Eager-on-Read のどの経路も、この `VectorModule` の検証を通る。
pub mod commands;
mod drawio_import;
mod scene;
mod upgrade;
mod validation;

#[cfg(test)]
mod contract_v3_tests;
#[cfg(test)]
pub(crate) mod testing;

use crate::module::{ModuleBackend, ModuleError};
use serde_json::Value;
pub use validation::{validate_svg, MAX_SVG_BYTES, MAX_TEXT_BYTES};

/// v1 は `{ svg, text }` (ADR-0021)、v2 は `{ pages, nodes, assets, text }` (ADR-0026)、v3 は v2 に
/// 回転・線の端と角と破線・パス・ブーリアンを足したもの (ADR-0028)。
///
/// この定数を 3 にするだけで、`upgrade_payload` が v1 / v2 を v3 へ変換し、`validate_payload` が v3 を
/// 検証し、起動時に `pre-payload-vector-v3` のバックアップを取るようになる (C1 が変える。§8.15)。
const CURRENT_PAYLOAD_VERSION: u32 = 2;

/// `version` の文書を検証する。2 は凍結した v2 の規則、3 は v3 の規則。
fn validate_as(version: u32, payload: &Value) -> Result<(), ModuleError> {
    match version {
        2 => scene::validate(payload),
        3 => scene::validate_v3(payload),
        other => Err(ModuleError::UnknownPayloadVersion(other)),
    }
}

/// 今の版が `current` のときの `upgrade_payload`。`from` の文書を 1 つ上の版にする。
/// 各段は自分の結果をその版の検証で確かめる (v1 → v2 は v2、v2 → v3 は v3。§8.3.3)。
/// 今の版より上の版へは変換しない。
fn upgrade_from(current: u32, from_version: u32, payload: &Value) -> Result<Value, ModuleError> {
    match from_version {
        1 if current >= 2 => upgrade::upgrade_v1(payload),
        2 if current >= 3 => upgrade::upgrade_v2(payload),
        other => Err(ModuleError::UnknownPayloadVersion(other)),
    }
}

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
    /// v1 の SVG を編集できない埋め込み SVG 1 個の文書に包む (§3.7)。v2 に回転 0 と線の既定値を足す
    /// (§8.3.3)。変換結果がその版の検証を通らなければ `UpgradeFailed` を返し、呼び出し側
    /// (Eager-on-Read) は古い行を書き換えない。
    fn upgrade_payload(&self, from_version: u32, payload: Value) -> Result<Value, ModuleError> {
        upgrade_from(CURRENT_PAYLOAD_VERSION, from_version, &payload)
    }
    fn validate_payload(&self, payload: &Value) -> Result<(), ModuleError> {
        validate_as(CURRENT_PAYLOAD_VERSION, payload)
    }
    /// 検索用テキスト `text` (§3.6)。`validate_payload` が文書から求め直した値と一致することを確かめている。
    fn index_text(&self, payload: &Value) -> String {
        index_text(payload)
    }
}

fn index_text(payload: &Value) -> String {
    payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
