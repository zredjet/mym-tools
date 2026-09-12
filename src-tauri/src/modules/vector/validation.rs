use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use quick_xml::{
    events::{BytesStart, Event},
    name::ResolveResult,
    NsReader,
};
use serde::Deserialize;
use std::sync::LazyLock;

pub const MAX_SVG_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
const SVG_NS: &[u8] = b"http://www.w3.org/2000/svg";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    elements: Vec<String>,
    css_properties: Vec<String>,
}
static POLICY: LazyLock<Policy> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../scripts/svgedit/policy.json"))
        .expect("checked-in SVG policy")
});
pub fn error(reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: "vector".into(),
        reason: reason.into(),
    }
}

pub fn validate_svg(svg: &str) -> Result<String, AppError> {
    if svg.trim().is_empty() || svg.len() > MAX_SVG_BYTES {
        return Err(error("SVGは空でなく20MiB以下にしてください。"));
    }
    let mut reader = NsReader::from_str(svg);
    let mut stack: Vec<bool> = vec![];
    let mut roots = 0;
    let mut declarations = 0;
    let mut parts = Vec::new();
    let mut text = String::new();
    loop {
        let (namespace, event) = reader
            .read_resolved_event()
            .map_err(|e| error(format!("SVGのXMLが不正です: {e}")))?;
        let svg_namespace =
            matches!(namespace, ResolveResult::Bound(ref ns) if ns.as_ref() == SVG_NS);
        match event {
            Event::Start(ref element) | Event::Empty(ref element) => {
                flush(&mut text, &mut parts);
                let local = element.local_name();
                let name = std::str::from_utf8(local.as_ref())
                    .map_err(|_| error("SVGはUTF-8にしてください。"))?;
                if !svg_namespace || !POLICY.elements.iter().any(|allowed| allowed == name) {
                    return Err(error(format!("未対応のSVG要素です: {name}")));
                }
                if stack.is_empty() {
                    roots += 1;
                    if roots != 1 || name != "svg" {
                        return Err(error("SVGルートは1つだけ必要です。"));
                    }
                }
                inspect_attributes(&reader, element, name)?;
                if matches!(event, Event::Start(_)) {
                    stack.push(
                        stack.last().copied().unwrap_or(false)
                            || ["text", "title", "desc"].contains(&name),
                    );
                }
            }
            Event::End(_) => {
                flush(&mut text, &mut parts);
                if stack.pop().is_none() {
                    return Err(error("SVGの閉じタグが不正です。"));
                }
            }
            Event::Text(value) => {
                let value = value.xml_content().map_err(|e| error(e.to_string()))?;
                if stack.is_empty() && !value.trim().is_empty() {
                    return Err(error("SVGルート外にテキストがあります。"));
                }
                if stack.last() == Some(&true) {
                    text.push_str(&value);
                }
            }
            Event::CData(value) => {
                flush(&mut text, &mut parts);
                if stack.is_empty() {
                    return Err(error("SVGルート外のCDATAは使用できません。"));
                }
                if stack.last() == Some(&true) {
                    text.push_str(&value.decode().map_err(|e| error(e.to_string()))?);
                    flush(&mut text, &mut parts);
                }
            }
            Event::GeneralRef(value) => {
                let entity = value.decode().map_err(|e| error(e.to_string()))?;
                let decoded = quick_xml::escape::unescape(&format!("&{entity};"))
                    .map_err(|e| error(e.to_string()))?
                    .into_owned();
                if stack.is_empty() {
                    return Err(error("SVGルート外の実体参照は使用できません。"));
                }
                if stack.last() == Some(&true) {
                    text.push_str(&decoded);
                }
            }
            Event::DocType(_) | Event::PI(_) => {
                return Err(error("DTD・実体宣言・処理命令は使用できません。"))
            }
            Event::Decl(declaration) => {
                declarations += 1;
                if roots != 0 || declarations > 1 {
                    return Err(error("XML宣言の位置が不正です。"));
                }
                if let Some(encoding) = declaration.encoding() {
                    if !encoding
                        .map_err(|e| error(e.to_string()))?
                        .eq_ignore_ascii_case(b"utf-8")
                    {
                        return Err(error("SVGはUTF-8にしてください。"));
                    }
                }
            }
            Event::Eof => break,
            Event::Comment(_) => flush(&mut text, &mut parts),
        }
    }
    if roots != 1 || !stack.is_empty() {
        return Err(error("SVGのルートまたは閉じタグが不正です。"));
    }
    let text = parts
        .join(" ")
        .split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if text.len() > MAX_TEXT_BYTES {
        return Err(error("検索用テキストは1MiB以下にしてください。"));
    }
    Ok(text)
}
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn flush(text: &mut String, parts: &mut Vec<String>) {
    if !text.is_empty() {
        parts.push(std::mem::take(text));
    }
}

fn inspect_attributes(
    reader: &NsReader<&[u8]>,
    element: &BytesStart<'_>,
    element_name: &str,
) -> Result<(), AppError> {
    for attr in element.attributes().with_checks(true) {
        let attr = attr.map_err(|e| error(e.to_string()))?;
        let qualified = String::from_utf8_lossy(attr.key.as_ref());
        if qualified == "xmlns" || qualified.starts_with("xmlns:") {
            continue;
        }
        let (namespace, local) = reader.resolver().resolve_attribute(attr.key);
        if matches!(namespace, ResolveResult::Unknown(_)) {
            return Err(error("属性の名前空間が不正です。"));
        }
        let name = String::from_utf8_lossy(local.as_ref()).to_ascii_lowercase();
        let value = attr
            .decode_and_unescape_value(reader.decoder())
            .map_err(|e| error(e.to_string()))?;
        let value = value.trim();
        if name.starts_with("on") || ["src", "base"].contains(&name.as_str()) {
            return Err(error(format!("使用できない属性です: {qualified}")));
        }
        if name == "href" {
            if matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() != b"http://www.w3.org/1999/xlink")
            {
                return Err(error("hrefの名前空間が不正です。"));
            }
            if !fragment(value) {
                if !["image", "feImage"].contains(&element_name) {
                    return Err(error("外部参照は使用できません。"));
                }
                validate_image_data(value)?;
            }
        } else if name == "style" {
            for declaration in value.split(';').filter(|v| !v.trim().is_empty()) {
                let (property, value) = declaration
                    .split_once(':')
                    .ok_or_else(|| error("CSS属性が不正です。"))?;
                if !POLICY
                    .css_properties
                    .contains(&property.trim().to_ascii_lowercase())
                {
                    return Err(error(format!("未対応のCSS属性です: {property}")));
                }
                validate_css(value)?;
            }
        } else if POLICY.css_properties.contains(&name) {
            validate_css(value)?;
        }
    }
    Ok(())
}
fn fragment(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|id| {
        !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c))
    })
}
fn validate_css(value: &str) -> Result<(), AppError> {
    let value = value.to_ascii_lowercase();
    if value.contains(['\\', '@', '<', '>']) || value.contains("/*") {
        return Err(error("外部CSS・エスケープ・コメントは使用できません。"));
    }
    let mut remaining = value.as_str();
    while let Some(start) = remaining.find("url") {
        let rest = remaining[start + 3..].trim_start();
        if let Some(rest) = rest.strip_prefix('(') {
            let end = rest.find(')').ok_or_else(|| error("CSS参照が不正です。"))?;
            let target = rest[..end].trim();
            let target = if target.len() >= 2
                && ((target.starts_with('\'') && target.ends_with('\''))
                    || (target.starts_with('"') && target.ends_with('"')))
            {
                &target[1..target.len() - 1]
            } else {
                target
            };
            if !fragment(target) {
                return Err(error("外部参照は使用できません。"));
            }
            remaining = &rest[end + 1..];
        } else {
            remaining = &remaining[start + 3..];
        }
    }
    if ["http:", "https:", "file:", "data:", "javascript:", "//"]
        .iter()
        .any(|s| value.contains(s))
    {
        return Err(error("外部参照は使用できません。"));
    }
    Ok(())
}
pub fn validate_image_data(value: &str) -> Result<(), AppError> {
    let (header, body) = value
        .split_once(',')
        .ok_or_else(|| error("埋め込み画像が不正です。"))?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|h| h.strip_suffix(";base64"))
        .ok_or_else(|| error("画像はbase64で埋め込んでください。"))?;
    let bytes = STANDARD
        .decode(body)
        .map_err(|_| error("画像のbase64が不正です。"))?;
    validate_image(&bytes, mime)
}
pub fn validate_image(bytes: &[u8], mime: &str) -> Result<(), AppError> {
    if bytes.len() > MAX_SVG_BYTES {
        return Err(error("画像は20MiB以下にしてください。"));
    }
    let valid = match mime {
        "image/png" => bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.len() >= 4 && bytes.starts_with(b"\xff\xd8\xff"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !valid {
        return Err(error("画像の形式と内容が一致しません。"));
    }
    if mime == "image/png" {
        let w = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width"));
        let h = u32::from_be_bytes(bytes[20..24].try_into().expect("PNG height"));
        if w == 0 || h == 0 || w > 16_384 || h > 16_384 || u64::from(w) * u64::from(h) > 16_777_216
        {
            return Err(error("画像の寸法が上限を超えています。"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_browser_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../scripts/svgedit/validation-fixtures.json"
        ))
        .unwrap();
        for case in fixtures.as_array().unwrap() {
            let result = validate_svg(case["svg"].as_str().unwrap());
            if case["valid"] == true {
                assert_eq!(
                    result.unwrap(),
                    case["text"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            } else {
                assert!(result.is_err(), "{}", case["name"]);
            }
        }
    }
    #[test]
    fn utf8_limits_are_inclusive() {
        let base = "<svg xmlns=\"http://www.w3.org/2000/svg\"><!-- --></svg>";
        let exact = base.replace(
            "<!-- -->",
            &format!("<!--{}-->", "a".repeat(MAX_SVG_BYTES - base.len() + 1)),
        );
        assert_eq!(exact.len(), MAX_SVG_BYTES);
        assert!(validate_svg(&exact).is_ok());
        assert!(validate_svg(&(exact + " ")).is_err());
        let text = "a".repeat(MAX_TEXT_BYTES);
        assert_eq!(
            validate_svg(&format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{text}</text></svg>"
            ))
            .unwrap()
            .len(),
            MAX_TEXT_BYTES
        );
        assert!(validate_svg(&format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{text}あ</text></svg>"
        ))
        .is_err());
    }
}
