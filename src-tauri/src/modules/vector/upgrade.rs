//! payload v1 (`{ svg, text }`) から v2 (シーン形式) への変換 (ADR-0026、
//! `docs/canvas-editor-design.md` §3.7)。v1 の SVG を編集できない埋め込み SVG 1 個の文書に包む。
//!
//! 切替 PR までは `VectorModule::upgrade_payload` から呼ばれず、テストからだけ使う。
// 切替 PR で外す (ADR-0026)。
#![cfg_attr(not(test), allow(dead_code))]

use super::scene::{search_text, LIMITS};
use crate::module::ModuleError;
use quick_xml::{events::Event, Reader, XmlVersion};
use serde_json::{json, Value};

/// 大きさが読み取れないときの既定値 (§3.7)。
const FALLBACK_SIZE: (f64, f64) = (640.0, 480.0);

fn failed(reason: impl Into<String>) -> ModuleError {
    ModuleError::UpgradeFailed {
        reason: reason.into(),
    }
}

/// v1 の payload を v2 にする。結果は入力だけで決まる。`VectorModule::upgrade_payload(1, ..)` から呼ぶ形。
///
/// `text` は §3.6 の規則で変換後の文書から求める。v1 の `text` は SVG から抽出した時点で空白が
/// 正規化されているので通常は v1 の `text` と同じになる。違いが出るのは v1 の空白の集合
/// (`js_whitespace`) に無く `char::is_whitespace` にある U+0085 を含むときだけで、
/// v1 の `text` をそのまま入れると変換結果が v2 の検証を通らなくなるため、求め直した値を使う。
pub fn upgrade_v1(payload: &Value) -> Result<Value, ModuleError> {
    let svg = payload
        .get("svg")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("v1 の svg が文字列ではありません。"))?;
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("v1 の text が文字列ではありません。"))?;
    let (width, height) = svg_size(svg).unwrap_or(FALLBACK_SIZE);
    let max = LIMITS.max_size;
    let (width, height) = (
        number(width.clamp(1.0, max)),
        number(height.clamp(1.0, max)),
    );
    let mut document = json!({
        "pages": [{ "id": "page1", "name": "ページ 1", "children": ["legacy"], "guides": [] }],
        "nodes": {
            "legacy": {
                "id": "legacy",
                "name": "SVG",
                "visible": true,
                "locked": false,
                "opacity": 1,
                "x": 0,
                "y": 0,
                "width": width,
                "height": height,
                "type": "svg",
                "assetId": "legacy"
            }
        },
        "assets": {
            "legacy": {
                "kind": "svg",
                "svg": svg,
                "text": text,
                "width": width,
                "height": height
            }
        },
        "text": ""
    });
    document["text"] = Value::String(search_text(&document));
    Ok(document)
}

/// 整数の値は JSON の整数で書く (契約データの `640` と同じ表現にする)。
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// ルート要素から大きさを読む。`width` / `height` が両方とも正ならその値、なければ `viewBox` の
/// 幅と高さ (両方とも正のとき)。どちらも無ければ `None`。
fn svg_size(svg: &str) -> Option<(f64, f64)> {
    let mut reader = Reader::from_str(svg);
    let root = loop {
        match reader.read_event().ok()? {
            Event::Start(element) | Event::Empty(element) => break element,
            Event::Eof => return None,
            _ => {}
        }
    };
    let (mut width, mut height, mut view_box) = (None, None, None);
    for attr in root.attributes().flatten() {
        let Ok(value) = attr.normalized_value(XmlVersion::Implicit1_0) else {
            continue;
        };
        match attr.key.as_ref() {
            b"width" => width = length(&value),
            b"height" => height = length(&value),
            b"viewBox" => view_box = view_box_size(&value),
            _ => {}
        }
    }
    match (width, height) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => view_box,
    }
}

/// `width` / `height` 属性の値。単位なしか `px` の正の数だけを受け付ける (`%` や `em` は読まない)。
fn length(value: &str) -> Option<f64> {
    let value = value.trim();
    let value = match value.len().checked_sub(2) {
        Some(end) if value.is_char_boundary(end) && value[end..].eq_ignore_ascii_case("px") => {
            &value[..end]
        }
        _ => value,
    };
    parse_number(value).filter(|n| *n > 0.0)
}

/// `viewBox` の幅と高さ。4 つの数を空白か、前後に空白を置いてよいカンマ 1 個で区切る。
fn view_box_size(value: &str) -> Option<(f64, f64)> {
    let mut numbers = Vec::with_capacity(4);
    for segment in value.trim().split(',') {
        let mut tokens = segment.split_ascii_whitespace().peekable();
        tokens.peek()?;
        for token in tokens {
            numbers.push(parse_number(token)?);
        }
    }
    match numbers[..] {
        [_, _, w, h] if w > 0.0 && h > 0.0 => Some((w, h)),
        _ => None,
    }
}

/// SVG の数の書式 (`[+-]? (数字+ (. 数字*)? | . 数字+) ([eE] [+-]? 数字+)?`) で、有限のものだけ。
fn parse_number(token: &str) -> Option<f64> {
    let bytes = token.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < bytes.len() && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let mut mantissa = digits(&mut i);
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        mantissa += digits(&mut i);
    }
    if mantissa == 0 {
        return None;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    token.parse::<f64>().ok().filter(|n| n.is_finite())
}

#[cfg(test)]
mod tests {
    use super::super::scene::validate;
    use super::*;

    fn contract() -> Value {
        serde_json::from_str(include_str!(
            "../../../../src/modules/vector/editor/model/fixtures/payload-v2.json"
        ))
        .unwrap()
    }

    fn upgrade_svg(svg: &str) -> Value {
        let text = super::super::validate_svg(svg).unwrap();
        let v2 = upgrade_v1(&json!({ "svg": svg, "text": text })).unwrap();
        validate(&v2).unwrap_or_else(|e| panic!("{svg}: {e}"));
        v2
    }

    fn size_of(svg: &str) -> (Value, Value) {
        let v2 = upgrade_svg(svg);
        let node = &v2["nodes"]["legacy"];
        assert_eq!(node["width"], v2["assets"]["legacy"]["width"]);
        assert_eq!(node["height"], v2["assets"]["legacy"]["height"]);
        (node["width"].clone(), node["height"].clone())
    }

    fn root(attributes: &str) -> String {
        format!("<svg xmlns=\"http://www.w3.org/2000/svg\" {attributes}/>")
    }

    #[test]
    fn contract_upgrade_cases() {
        let contract = contract();
        let cases = contract["upgrade"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let v2 = upgrade_v1(&case["v1"]).unwrap();
            assert_eq!(v2, case["v2"], "{}", case["name"]);
            validate(&v2).unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
        }
    }

    #[test]
    fn upgrade_is_deterministic() {
        let contract = contract();
        for case in contract["upgrade"].as_array().unwrap() {
            let first = upgrade_v1(&case["v1"]).unwrap();
            let second = upgrade_v1(&case["v1"].clone()).unwrap();
            assert_eq!(first, second);
            assert_eq!(
                serde_json::to_string(&first).unwrap(),
                serde_json::to_string(&second).unwrap()
            );
        }
    }

    #[test]
    fn size_from_width_and_height() {
        assert_eq!(
            size_of(&root(r#"width="100" height="50""#)),
            (json!(100), json!(50))
        );
        assert_eq!(
            size_of(&root(r#"width="100px" height="50PX""#)),
            (json!(100), json!(50))
        );
        assert_eq!(
            size_of(&root(r#"width=" 12.5 " height=".5e2""#)),
            (json!(12.5), json!(50))
        );
        assert_eq!(
            size_of(&root(r#"width="+3" height="4.""#)),
            (json!(3), json!(4))
        );
        // width / height の方が viewBox より優先
        assert_eq!(
            size_of(&root(r#"width="100" height="50" viewBox="0 0 300 150""#)),
            (json!(100), json!(50))
        );
    }

    #[test]
    fn size_falls_back_to_view_box() {
        let view_box = |attributes: &str| size_of(&root(attributes));
        let expected = (json!(300), json!(150));
        assert_eq!(view_box(r#"viewBox="0 0 300 150""#), expected);
        assert_eq!(view_box(r#"viewBox="0,0,300,150""#), expected);
        assert_eq!(view_box(r#"viewBox=" -10 , 5 300   150 ""#), expected);
        assert_eq!(view_box("viewBox=\"0\t0\n300 150\""), expected);
        assert_eq!(
            view_box(r#"viewBox="0 0 300.5 1e2""#),
            (json!(300.5), json!(100))
        );
        // width / height のどちらかが使えなければ viewBox
        for attributes in [
            r#"width="0" height="50" viewBox="0 0 300 150""#,
            r#"width="-100" height="50" viewBox="0 0 300 150""#,
            r#"width="100" viewBox="0 0 300 150""#,
            r#"width="100%" height="100%" viewBox="0 0 300 150""#,
            r#"width="10em" height="10em" viewBox="0 0 300 150""#,
            r#"width="1e999" height="5" viewBox="0 0 300 150""#,
            r#"width="NaN" height="inf" viewBox="0 0 300 150""#,
            r#"width="10 px" height="10" viewBox="0 0 300 150""#,
        ] {
            assert_eq!(view_box(attributes), expected, "{attributes}");
        }
    }

    #[test]
    fn size_falls_back_to_default() {
        let fallback = (json!(640), json!(480));
        for attributes in [
            "",
            r#"viewBox="0 0 0 150""#,
            r#"viewBox="0 0 300 -150""#,
            r#"viewBox="0 0 300""#,
            r#"viewBox="0 0 300 150 1""#,
            r#"viewBox="0,,0,300,150""#,
            r#"viewBox=",0 0 300 150""#,
            r#"viewBox="0 0 300 150,""#,
            r#"viewBox="0 0 a 150""#,
            r#"width="0" height="0""#,
        ] {
            assert_eq!(size_of(&root(attributes)), fallback, "{attributes}");
        }
    }

    #[test]
    fn size_is_clamped() {
        assert_eq!(
            size_of(&root(r#"width="0.25" height="200000""#)),
            (json!(1), json!(100_000))
        );
        assert_eq!(
            size_of(&root(r#"viewBox="0 0 1e9 0.5""#)),
            (json!(100_000), json!(1))
        );
    }

    #[test]
    fn root_attributes_only() {
        // 子要素の width / height は読まない
        assert_eq!(
            size_of(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!-- c --><svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"5\" height=\"5\"/></svg>"
            ),
            (json!(640), json!(480))
        );
    }

    #[test]
    fn text_is_rederived_from_the_document() {
        // v1 の text は SVG からの抽出で正規化済みなので通常はそのまま。U+0085 だけは v1 の空白に
        // 含まれず v2 では空白なので、v1 の text をそのまま入れると v2 の検証を通らない。
        // (U+0085 をそのまま書くと XML 1.1 の改行規則で改行になるので、文字参照で書く)
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>a&#x85;b</text></svg>";
        let v1_text = super::super::validate_svg(svg).unwrap();
        assert_eq!(v1_text, "a\u{85}b");
        let v2 = upgrade_svg(svg);
        assert_eq!(v2["assets"]["legacy"]["text"], json!("a\u{85}b"));
        assert_eq!(v2["text"], json!("a b"));
    }

    #[test]
    fn malformed_v1_is_an_upgrade_error() {
        for payload in [
            json!({}),
            json!({ "svg": 1, "text": "" }),
            json!({ "svg": "" }),
        ] {
            assert!(matches!(
                upgrade_v1(&payload),
                Err(ModuleError::UpgradeFailed { .. })
            ));
        }
    }
}
