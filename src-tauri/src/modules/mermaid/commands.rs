//! Mermaidのサニタイズ済みプレビューをローカル画像へ書き出す。

use std::path::PathBuf;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::AppError;

use super::super::image_export::{decode_and_validate_image, write_atomically, ImageFormat};

#[tauri::command]
pub fn mermaid_write_file(path: String, format: String, data: String) -> Result<(), AppError> {
    let path = PathBuf::from(path);
    let (image_format, bytes) = decode_and_validate_image("mermaid", &path, &format, &data)?;
    if image_format == ImageFormat::Svg {
        validate_safe_mermaid_svg(&bytes)?;
    }
    write_atomically(&path, &bytes)
}

fn validate_safe_mermaid_svg(bytes: &[u8]) -> Result<(), AppError> {
    let svg =
        std::str::from_utf8(bytes).map_err(|_| validation("Mermaid SVG must be valid UTF-8"))?;
    let lowercase = svg.to_ascii_lowercase();
    if lowercase.contains("<!doctype") || lowercase.contains("<!entity") {
        return Err(validation("Mermaid SVG must not contain DTD or entities"));
    }

    let mut reader = Reader::from_str(svg);
    reader.config_mut().check_end_names = true;
    let mut in_style = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                reject_element(name)?;
                inspect_attributes(&element)?;
                in_style = name.eq_ignore_ascii_case(b"style");
            }
            Ok(Event::Empty(element)) => {
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                reject_element(name)?;
                inspect_attributes(&element)?;
            }
            Ok(Event::Text(text)) if in_style => {
                if contains_external_css_reference(&String::from_utf8_lossy(text.as_ref())) {
                    return Err(validation("Mermaid SVG must not contain external CSS"));
                }
            }
            Ok(Event::End(element)) => {
                if local_name(element.name().as_ref()).eq_ignore_ascii_case(b"style") {
                    in_style = false;
                }
            }
            Ok(Event::DocType(_)) => {
                return Err(validation("Mermaid SVG must not contain a DTD"));
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(validation(format!("invalid Mermaid SVG: {error}"))),
        }
    }
    Ok(())
}

fn inspect_attributes(element: &quick_xml::events::BytesStart<'_>) -> Result<(), AppError> {
    for attribute in element.attributes().with_checks(true) {
        let attribute =
            attribute.map_err(|error| validation(format!("invalid Mermaid SVG: {error}")))?;
        let name = String::from_utf8_lossy(attribute.key.as_ref()).to_ascii_lowercase();
        let value = String::from_utf8_lossy(attribute.value.as_ref());
        if name.starts_with("on") {
            return Err(validation("Mermaid SVG must not contain event handlers"));
        }
        if name == "src" || ((name == "href" || name == "xlink:href") && !value.starts_with('#')) {
            return Err(validation(
                "Mermaid SVG must not contain external resource references",
            ));
        }
        if name == "style" && contains_external_css_reference(&value) {
            return Err(validation("Mermaid SVG must not contain external CSS"));
        }
    }
    Ok(())
}

fn reject_element(name: &[u8]) -> Result<(), AppError> {
    if [b"script".as_slice(), b"foreignobject", b"iframe", b"object"]
        .iter()
        .any(|forbidden| name.eq_ignore_ascii_case(forbidden))
    {
        Err(validation("Mermaid SVG contains active content"))
    } else {
        Ok(())
    }
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn contains_external_css_reference(value: &str) -> bool {
    let lowercase = value.to_ascii_lowercase();
    lowercase.contains("@import")
        || (lowercase.contains("url(")
            && (lowercase.contains("http:")
                || lowercase.contains("https:")
                || lowercase.contains("//")))
}

fn validation(reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: "mermaid".into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

    #[test]
    fn writes_svg_and_png_and_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let svg = directory.path().join("diagram.svg");
        std::fs::write(&svg, "old").unwrap();
        mermaid_write_file(
            svg.display().to_string(),
            "svg".into(),
            r##"<svg xmlns="http://www.w3.org/2000/svg"><use href="#node"/></svg>"##.into(),
        )
        .unwrap();
        assert!(std::fs::read_to_string(svg).unwrap().starts_with("<svg"));

        let png = directory.path().join("diagram.png");
        mermaid_write_file(
            png.display().to_string(),
            "png".into(),
            format!("data:image/png;base64,{}", BASE64.encode(PNG)),
        )
        .unwrap();
        assert_eq!(std::fs::read(png).unwrap(), PNG);
    }

    #[test]
    fn rejects_active_content_external_references_and_wrong_extensions() {
        let directory = tempfile::tempdir().unwrap();
        for svg in [
            "<svg><script/></svg>",
            "<svg><foreignObject/></svg>",
            r#"<svg onload="bad()"/>"#,
            r#"<svg><image href="https://example.com/image.png"/></svg>"#,
            r#"<svg><style>@import "https://example.com/style.css"</style></svg>"#,
        ] {
            assert!(mermaid_write_file(
                directory.path().join("diagram.svg").display().to_string(),
                "svg".into(),
                svg.into(),
            )
            .is_err());
        }
        assert!(mermaid_write_file(
            directory.path().join("diagram.txt").display().to_string(),
            "svg".into(),
            "<svg/>".into(),
        )
        .is_err());
    }
}
