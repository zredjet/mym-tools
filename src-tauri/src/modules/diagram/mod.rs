//! M-Diagram: draw.io XML を完全オフラインで編集・保存するモジュール。
//!
//! payload v1 は `{ "xml": string, "text": string }`。`text` は draw.io embed protocol
//! から取得した全ページの検索用テキストで、XML本体とは分離して保持する。

pub mod commands;
pub mod protocol;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::Value as JsonValue;

use crate::module::{ModuleBackend, ModuleError};

pub const MAX_DIAGRAM_BYTES: usize = 1024 * 1024;

pub struct DiagramModule;

impl ModuleBackend for DiagramModule {
    fn id(&self) -> &'static str {
        "diagram"
    }

    fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
        let xml = payload
            .get("xml")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| validation("diagram payload must have `xml` string"))?;
        let text = payload
            .get("text")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| validation("diagram payload must have `text` string"))?;
        validate_diagram_xml(xml)?;
        if text.len() > MAX_DIAGRAM_BYTES {
            return Err(validation("diagram text index must be 1 MiB or smaller"));
        }
        Ok(())
    }

    fn index_text(&self, payload: &JsonValue) -> String {
        payload
            .get("text")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string()
    }
}

pub(crate) fn validate_diagram_xml(xml: &str) -> Result<(), ModuleError> {
    if xml.trim().is_empty() {
        return Err(validation("diagram XML must not be empty"));
    }
    if xml.len() > MAX_DIAGRAM_BYTES {
        return Err(validation("diagram XML must be 1 MiB or smaller"));
    }
    let lowercase = xml.to_ascii_lowercase();
    if lowercase.contains("<!doctype") || lowercase.contains("<!entity") {
        return Err(validation(
            "diagram XML must not contain DTD or entity declarations",
        ));
    }

    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut root: Option<Vec<u8>> = None;
    let mut depth = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                if depth == 0 {
                    if root.is_some() {
                        return Err(validation("diagram XML must have exactly one root"));
                    }
                    root = Some(element.name().as_ref().to_vec());
                }
                depth += 1;
            }
            Ok(Event::Empty(element)) if depth == 0 => {
                if root.is_some() {
                    return Err(validation("diagram XML must have exactly one root"));
                }
                root = Some(element.name().as_ref().to_vec());
            }
            Ok(Event::End(_)) => {
                if depth == 0 {
                    return Err(validation("diagram XML has an unmatched closing element"));
                }
                depth -= 1;
            }
            Ok(Event::DocType(_)) => {
                return Err(validation("diagram XML must not contain a DTD"));
            }
            Ok(Event::Eof) if depth == 0 => break,
            Ok(Event::Eof) => return Err(validation("diagram XML has an unclosed element")),
            Ok(_) => {}
            Err(error) => return Err(validation(format!("invalid diagram XML: {error}"))),
        }
    }

    match root.as_deref() {
        Some(b"mxfile") | Some(b"mxGraphModel") => Ok(()),
        Some(other) => Err(validation(format!(
            "diagram XML root must be mxfile or mxGraphModel, got {}",
            String::from_utf8_lossy(other)
        ))),
        None => Err(validation("diagram XML has no root element")),
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

    const XML: &str = r#"<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>"#;

    #[test]
    fn validates_both_supported_roots_and_indexes_text() {
        DiagramModule
            .validate_payload(&json!({"xml": XML, "text": "開始 終了"}))
            .unwrap();
        DiagramModule
            .validate_payload(&json!({"xml": "<mxGraphModel><root/></mxGraphModel>", "text": ""}))
            .unwrap();
        assert_eq!(
            DiagramModule.index_text(&json!({"xml": XML, "text": "開始 終了"})),
            "開始 終了"
        );
    }

    #[test]
    fn rejects_wrong_root_malformed_xml_and_dtd() {
        assert!(validate_diagram_xml("<svg/>").is_err());
        assert!(validate_diagram_xml("<mxfile>").is_err());
        assert!(validate_diagram_xml("<!DOCTYPE mxfile><mxfile/>").is_err());
        assert!(validate_diagram_xml("<!ENTITY x SYSTEM 'file:///tmp/x'><mxfile/>").is_err());
    }

    #[test]
    fn rejects_oversized_payload_fields() {
        assert!(DiagramModule
            .validate_payload(&json!({"xml": "x".repeat(MAX_DIAGRAM_BYTES + 1), "text": ""}))
            .is_err());
        assert!(DiagramModule
            .validate_payload(&json!({"xml": XML, "text": "x".repeat(MAX_DIAGRAM_BYTES + 1)}))
            .is_err());
    }
}
