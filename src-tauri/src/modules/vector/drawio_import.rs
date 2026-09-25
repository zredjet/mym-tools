//! draw.io が書き出した SVG を、ベクター描画で取り込める形へ変換する (ADR-0021)。
//!
//! draw.io の SVG は、ラベルを HTML (`<switch><foreignObject>`) で描き、ダークモード用に
//! `light-dark()` / CSS 変数 / `<style>` を使い、末尾に外部リンク付きの注意書きを置く。
//! これらは Vector の SVG ポリシーで拒否されるため、取り込み時に限って次のとおり変換し、
//! 行った変換を `notices` として利用者に示す (黙って除去して成功扱いにはしない)。
//!
//! - `<switch>` 内の HTML ラベルは、draw.io 自身が用意している代替の `<text>` に置き換える
//!   (太字などの書式は失われる)
//! - 外部リンク付きの注意書き (`Text is not SVG - cannot display`) を削除する
//! - `<style>` (ダークモード用の定義) を削除する
//! - `light-dark(明, 暗)` は明るい側の値、`var(--x, 既定値)` は既定値に置き換える
//! - ルートの `background` / `background-color` / `color-scheme` を削除する
//!
//! draw.io 以外の SVG は変換せず、従来どおり検証だけを行う。

use quick_xml::events::attributes::Attribute;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, Writer};

use super::validation::error;
use crate::error::AppError;

const EXTENSIBILITY_FEATURE: &str = "http://www.w3.org/TR/SVG11/feature#Extensibility";
/// Vector のポリシーに無く、取り込み時に削除する CSS プロパティ。
const DROPPED_CSS_PROPERTIES: [&str; 3] = ["background", "background-color", "color-scheme"];

#[derive(Debug, PartialEq, Eq)]
pub struct ConvertedSvg {
    pub svg: String,
    pub notices: Vec<String>,
}

/// draw.io の SVG なら変換結果を返す。draw.io 以外は `None`。
pub fn convert_drawio_svg(svg: &str) -> Result<Option<ConvertedSvg>, AppError> {
    if !is_drawio_svg(svg) {
        return Ok(None);
    }
    let mut stats = Stats::default();
    let structural = rewrite_structure(svg, &mut stats)?;
    let svg = rewrite_attributes(&structural, &mut stats)?;
    Ok(Some(ConvertedSvg {
        svg,
        notices: stats.notices(),
    }))
}

fn is_drawio_svg(svg: &str) -> bool {
    svg.contains("id=\"ge-svg-")
        || svg.contains(EXTENSIBILITY_FEATURE)
        || svg.contains("&lt;mxfile")
}

#[derive(Default)]
struct Stats {
    html_labels: usize,
    removed_warnings: usize,
    removed_styles: usize,
    resolved_colors: usize,
    removed_properties: usize,
}

impl Stats {
    fn notices(&self) -> Vec<String> {
        let mut notices = vec!["draw.io の SVG を取り込み用に変換しました。".to_string()];
        if self.html_labels > 0 {
            notices.push(format!(
                "HTML のラベル {} 件を通常のテキストに置き換えました (太字などの書式は失われます)。",
                self.html_labels
            ));
        }
        if self.resolved_colors > 0 {
            notices.push(format!(
                "ダークモード用の色指定 {} 件を通常の色に置き換えました。",
                self.resolved_colors
            ));
        }
        if self.removed_styles > 0 || self.removed_properties > 0 {
            notices.push("背景指定とスタイル定義を削除しました。".to_string());
        }
        if self.removed_warnings > 0 {
            notices.push("外部リンク付きの注意書きを削除しました。".to_string());
        }
        notices
    }
}

type OwnedEvent = Event<'static>;

/// `<switch>` と `<style>` を処理する (1 パス目)。
fn rewrite_structure(svg: &str, stats: &mut Stats) -> Result<String, AppError> {
    let mut reader = Reader::from_str(svg);
    let mut writer = Writer::new(Vec::new());
    loop {
        let event = reader.read_event().map_err(xml_error)?;
        match event {
            Event::Start(ref element) if local_name(element) == "style" => {
                skip_subtree(&mut reader)?;
                stats.removed_styles += 1;
            }
            Event::Empty(ref element) if local_name(element) == "style" => {
                stats.removed_styles += 1;
            }
            Event::Start(ref element) if local_name(element) == "switch" => {
                let children = collect_children(&mut reader)?;
                for event in resolve_switch(children, stats) {
                    writer.write_event(event).map_err(xml_error)?;
                }
            }
            Event::Empty(ref element) if local_name(element) == "switch" => {}
            Event::Eof => break,
            other => writer.write_event(other).map_err(xml_error)?,
        }
    }
    String::from_utf8(writer.into_inner()).map_err(|_| error("SVGはUTF-8にしてください。"))
}

/// 開始タグを読んだ直後から、対応する終了タグまでを読み飛ばす。
fn skip_subtree(reader: &mut Reader<&[u8]>) -> Result<(), AppError> {
    let mut depth = 1_usize;
    loop {
        match reader.read_event().map_err(xml_error)? {
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    return Ok(());
                }
            }
            Event::Eof => return Err(error("SVGの閉じタグが不正です。")),
            _ => {}
        }
    }
}

/// `<switch>` の子要素を、子ごとのイベント列として集める (終了タグは含めない)。
fn collect_children(reader: &mut Reader<&[u8]>) -> Result<Vec<Vec<OwnedEvent>>, AppError> {
    let mut children: Vec<Vec<OwnedEvent>> = Vec::new();
    let mut depth = 0_usize;
    loop {
        let event = reader.read_event().map_err(xml_error)?.into_owned();
        match &event {
            Event::Start(_) => {
                if depth == 0 {
                    children.push(Vec::new());
                }
                depth += 1;
                children.last_mut().expect("child started").push(event);
            }
            Event::Empty(_) => {
                if depth == 0 {
                    children.push(vec![event]);
                } else {
                    children.last_mut().expect("inside child").push(event);
                }
            }
            Event::End(_) => {
                if depth == 0 {
                    return Ok(children);
                }
                depth -= 1;
                children.last_mut().expect("inside child").push(event);
            }
            Event::Eof => return Err(error("SVGの閉じタグが不正です。")),
            _ => {
                if depth > 0 {
                    children.last_mut().expect("inside child").push(event);
                }
            }
        }
    }
}

/// `<switch>` を、取り込み後に残す子要素のイベント列へ置き換える。
fn resolve_switch(children: Vec<Vec<OwnedEvent>>, stats: &mut Stats) -> Vec<OwnedEvent> {
    let has_html = children
        .iter()
        .any(|child| first_element(child).is_some_and(|e| local_name(e) == "foreignObject"));
    let has_feature_test = children
        .iter()
        .any(|child| first_element(child).is_some_and(has_required_features));
    if has_html {
        stats.html_labels += 1;
        // draw.io は HTML ラベルの後ろに、同じ内容の <text> を代替として置く
        return children
            .into_iter()
            .filter(|child| {
                first_element(child)
                    .is_some_and(|e| local_name(e) != "foreignObject" && !has_required_features(e))
            })
            .flatten()
            .collect();
    }
    // 条件付きの子を除いた最初の子を使う (SVG の switch と同じく 1 つだけ描かれる)
    let chosen = children
        .into_iter()
        .find(|child| first_element(child).is_some_and(|e| !has_required_features(e)));
    match chosen {
        Some(child) if first_element(&child).is_some_and(is_external_link) => {
            stats.removed_warnings += 1;
            Vec::new()
        }
        Some(child) => {
            if has_feature_test {
                stats.removed_warnings += 1;
            }
            child
        }
        None => Vec::new(),
    }
}

fn first_element(events: &[OwnedEvent]) -> Option<&BytesStart<'static>> {
    match events.first()? {
        Event::Start(element) | Event::Empty(element) => Some(element),
        _ => None,
    }
}

fn has_required_features(element: &BytesStart<'_>) -> bool {
    element
        .attributes()
        .flatten()
        .any(|attr| attr.key.local_name().as_ref() == b"requiredFeatures")
}

fn is_external_link(element: &BytesStart<'_>) -> bool {
    local_name(element) == "a"
        && element
            .attributes()
            .flatten()
            .any(|attr| attr.key.local_name().as_ref() == b"href" && !attr.value.starts_with(b"#"))
}

fn local_name(element: &BytesStart<'_>) -> String {
    String::from_utf8_lossy(element.local_name().as_ref()).into_owned()
}

/// style 属性と CSS 関数を処理する (2 パス目)。
fn rewrite_attributes(svg: &str, stats: &mut Stats) -> Result<String, AppError> {
    let mut reader = Reader::from_str(svg);
    let mut writer = Writer::new(Vec::new());
    loop {
        match reader.read_event().map_err(xml_error)? {
            Event::Start(element) => {
                let element = rewrite_element(&element, stats)?;
                writer
                    .write_event(Event::Start(element))
                    .map_err(xml_error)?;
            }
            Event::Empty(element) => {
                let element = rewrite_element(&element, stats)?;
                writer
                    .write_event(Event::Empty(element))
                    .map_err(xml_error)?;
            }
            Event::Eof => break,
            other => writer.write_event(other).map_err(xml_error)?,
        }
    }
    String::from_utf8(writer.into_inner()).map_err(|_| error("SVGはUTF-8にしてください。"))
}

fn rewrite_element(
    element: &BytesStart<'_>,
    stats: &mut Stats,
) -> Result<BytesStart<'static>, AppError> {
    let name = String::from_utf8_lossy(element.name().as_ref()).into_owned();
    let mut rewritten = BytesStart::new(name);
    for attr in element.attributes().with_checks(false) {
        let attr = attr.map_err(|e| error(e.to_string()))?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let value = attr
            .unescape_value()
            .map_err(|e| error(e.to_string()))?
            .into_owned();
        if key == "style" {
            if let Some(style) = rewrite_style(&value, stats) {
                rewritten.push_attribute(("style", style.as_str()));
            }
        } else if value.contains("light-dark(") || value.contains("var(") {
            if let Some(resolved) = resolve_css_functions(&value, stats) {
                rewritten.push_attribute((key.as_str(), resolved.as_str()));
            }
        } else {
            rewritten.push_attribute(Attribute {
                key: attr.key,
                value: attr.value,
            });
        }
    }
    Ok(rewritten.into_owned())
}

/// style 属性の宣言を整理する。空になったら `None` (属性ごと削除)。
fn rewrite_style(style: &str, stats: &mut Stats) -> Option<String> {
    let mut declarations = Vec::new();
    for declaration in style.split(';') {
        let Some((property, value)) = declaration.split_once(':') else {
            continue;
        };
        let property = property.trim();
        if DROPPED_CSS_PROPERTIES.contains(&property.to_ascii_lowercase().as_str()) {
            stats.removed_properties += 1;
            continue;
        }
        if let Some(value) = resolve_css_functions(value.trim(), stats) {
            declarations.push(format!("{property}: {value}"));
        }
    }
    (!declarations.is_empty()).then(|| declarations.join("; "))
}

/// `light-dark(明, 暗)` を明るい側、`var(--x, 既定値)` を既定値に置き換える。
/// 既定値の無い `var()` は解決できないので `None` (その宣言を削除)。
fn resolve_css_functions(value: &str, stats: &mut Stats) -> Option<String> {
    let mut value = value.to_string();
    for _ in 0..32 {
        let Some((start, name)) = ["light-dark(", "var("]
            .iter()
            .filter_map(|name| value.find(name).map(|start| (start, *name)))
            .min_by_key(|(start, _)| *start)
        else {
            return Some(value);
        };
        let open = start + name.len();
        let close = matching_paren(&value, open)?;
        let arguments = split_top_level(&value[open..close]);
        let replacement = match name {
            "light-dark(" => arguments.first()?.trim().to_string(),
            _ => arguments.get(1)?.trim().to_string(),
        };
        stats.resolved_colors += 1;
        value.replace_range(start..=close, &replacement);
    }
    None
}

fn matching_paren(value: &str, open: usize) -> Option<usize> {
    let mut depth = 1_usize;
    for (index, c) in value[open..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + index);
                }
            }
            _ => {}
        }
    }
    None
}

/// 括弧の外側のカンマで分割する。`var(--a, rgb(0, 0, 0))` → [`--a`, ` rgb(0, 0, 0)`]
fn split_top_level(arguments: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0_usize;
    let mut start = 0;
    for (index, c) in arguments.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(&arguments[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&arguments[start..]);
    parts
}

fn xml_error(e: impl std::fmt::Display) -> AppError {
    error(format!("SVGのXMLが不正です: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::vector::validation::validate_svg;

    const DRAWIO_EXPORT: &str = include_str!("fixtures/drawio-export.svg");

    #[test]
    fn draw_io_export_is_rejected_as_is() {
        assert!(validate_svg(DRAWIO_EXPORT).is_err());
    }

    #[test]
    fn converted_draw_io_export_passes_the_vector_policy() {
        let converted = convert_drawio_svg(DRAWIO_EXPORT)
            .unwrap()
            .expect("draw.io export");
        let text = validate_svg(&converted.svg).expect("converted SVG must be valid");
        // HTML ラベルの代わりに代替テキストが残り、検索用テキストにもなる
        assert!(text.contains("開始"), "{text}");
        assert!(text.contains("処理太字"), "{text}");
        assert!(text.contains("plain"), "{text}");
        assert!(!text.contains("Text is not SVG"), "{text}");
        for removed in [
            "foreignObject",
            "<switch",
            "<style",
            "light-dark(",
            "var(",
            "background",
            "color-scheme",
            "drawio.com",
        ] {
            assert!(!converted.svg.contains(removed), "{removed} remains");
        }
        // 明るい側の色が使われる
        assert!(converted.svg.contains("fill: rgb(218, 232, 252)"));
        assert!(converted.svg.contains("fill: #ffffff"));
    }

    #[test]
    fn conversion_is_reported_to_the_user() {
        let converted = convert_drawio_svg(DRAWIO_EXPORT).unwrap().unwrap();
        let notices = converted.notices.join("\n");
        assert!(notices.contains("HTML のラベル 2 件"), "{notices}");
        assert!(notices.contains("ダークモード用の色指定"), "{notices}");
        assert!(notices.contains("外部リンク付きの注意書き"), "{notices}");
    }

    #[test]
    fn non_draw_io_svg_is_left_untouched() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>"#;
        assert_eq!(convert_drawio_svg(svg).unwrap(), None);
    }

    #[test]
    fn resolves_nested_css_functions() {
        let mut stats = Stats::default();
        assert_eq!(
            resolve_css_functions("var(--a, light-dark(rgb(1, 2, 3), #000))", &mut stats)
                .as_deref(),
            Some("rgb(1, 2, 3)")
        );
        assert_eq!(
            resolve_css_functions("var(--no-fallback)", &mut stats),
            None
        );
        assert_eq!(
            rewrite_style(
                "background: #fff; fill: red; color-scheme: light dark",
                &mut stats
            )
            .as_deref(),
            Some("fill: red")
        );
    }
}
