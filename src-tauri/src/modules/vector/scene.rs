//! payload v2 (キャンバスのシーン形式) の検証と検索用テキスト (ADR-0026)。
//!
//! 仕様の正典は `docs/canvas-editor-design.md` §3.3〜3.6、型は
//! `src/modules/vector/editor/model/types.ts`、上限と書式は `model/limits.json`。
//! 上限の値は Rust に書き写さず、`limits.json` を `include_str!` で読む。
//!
//! 切替 PR までは `VectorModule` から呼ばれず、テストからだけ使う。
// 切替 PR で外す (ADR-0026)。
#![cfg_attr(not(test), allow(dead_code))]

use super::validation::{validate_image, validate_svg};
use crate::error::AppError;
use crate::module::ModuleError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// `limits.json` の内容。値の意味は `docs/canvas-editor-design.md` §3.4〜3.6。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Limits {
    pub payload_bytes: usize,
    pub text_bytes: usize,
    pub max_nodes: usize,
    pub max_depth: usize,
    pub max_pages: usize,
    pub max_guides_per_page: usize,
    pub min_gradient_stops: usize,
    pub max_gradient_stops: usize,
    pub max_name_length: usize,
    pub max_text_length: usize,
    pub max_font_family_length: usize,
    pub max_coordinate: f64,
    pub max_size: f64,
    pub min_font_size: f64,
    pub max_font_size: f64,
    pub max_stroke_width: f64,
    pub max_radius: f64,
    pub max_shadow_offset: f64,
    pub max_shadow_blur: f64,
    pub max_letter_spacing: f64,
    pub max_line_height: f64,
    /// PNG の 1 辺の上限。判定は既存の `validate_image` が持ち、一致はテストで確かめる。
    pub max_image_side: u64,
    /// PNG の総画素数の上限。`max_image_side` と同じくテストで一致を確かめる。
    pub max_image_pixels: u64,
    /// 手書きの判定 (`is_id`) と同じ意味であることをテストで確かめる。
    pub id_pattern: String,
    /// 手書きの判定 (`is_color`) と同じ意味であることをテストで確かめる。
    pub color_pattern: String,
}

pub(crate) static LIMITS: LazyLock<Limits> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../src/modules/vector/editor/model/limits.json"
    ))
    .expect("checked-in canvas limits")
});

type Result<T> = std::result::Result<T, ModuleError>;

fn invalid(reason: impl Into<String>) -> ModuleError {
    ModuleError::ValidationFailed {
        reason: reason.into(),
    }
}

fn app_reason(error: AppError) -> String {
    match error {
        AppError::Validation { reason, .. } => reason,
        other => other.to_string(),
    }
}

/// `idPattern` (`^[A-Za-z0-9_-]{1,32}$`) と同じ判定。
pub(crate) fn is_id(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `colorPattern` (`^#[0-9A-Fa-f]{6}$`) と同じ判定。
pub(crate) fn is_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// 検索用テキスト (§3.6)
// ---------------------------------------------------------------------------

/// 拾った 1 つの文字列を、空白 (`char::is_whitespace`) で区切って空の要素を捨て、半角スペース 1 個でつなぐ。
fn normalize(value: &str) -> String {
    value
        .split(char::is_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn child_ids(value: &Value) -> impl DoubleEndedIterator<Item = &str> {
    value
        .get("children")
        .and_then(Value::as_array)
        .map(|children| children.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
}

/// 文書から検索用テキストを求める (§3.6)。
///
/// ページを配列の順に、各ページの `children` を深さ優先でたどり、frame の `name`、text の `text`、
/// svg ノードが指すアセットの `text` を拾う。検証前の文書に対しても止まる (同じノードは 1 回だけ
/// たどり、形の合わない部分は読み飛ばす) が、意味のある結果は検証を通る文書に対してだけ返す。
pub fn search_text(payload: &Value) -> String {
    let nodes = payload.get("nodes").and_then(Value::as_object);
    let assets = payload.get("assets").and_then(Value::as_object);
    let pages = payload
        .get("pages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut parts = Vec::new();
    let mut visited = HashSet::new();
    let mut pick = |value: Option<&Value>| {
        if let Some(text) = value.and_then(Value::as_str) {
            let text = normalize(text);
            if !text.is_empty() {
                parts.push(text);
            }
        }
    };
    for page in pages {
        let mut stack: Vec<&str> = child_ids(page).rev().collect();
        while let Some(id) = stack.pop() {
            if !visited.insert(id) {
                continue;
            }
            let Some(node) = nodes.and_then(|nodes| nodes.get(id)) else {
                continue;
            };
            match node.get("type").and_then(Value::as_str) {
                Some("frame") => {
                    pick(node.get("name"));
                    stack.extend(child_ids(node).rev());
                }
                Some("group") => stack.extend(child_ids(node).rev()),
                Some("text") => pick(node.get("text")),
                Some("svg") => pick(
                    node.get("assetId")
                        .and_then(Value::as_str)
                        .and_then(|asset| assets.and_then(|assets| assets.get(asset)))
                        .and_then(|asset| asset.get("text")),
                ),
                _ => {}
            }
        }
    }
    parts.join(" ")
}

// ---------------------------------------------------------------------------
// 検証 (§3.3〜3.6)
// ---------------------------------------------------------------------------

/// キーが過不足なくそろったオブジェクトと、利用者向けの場所の名前。
struct Fields<'a> {
    map: &'a Map<String, Value>,
    at: String,
}

impl<'a> Fields<'a> {
    fn new(value: &'a Value, at: impl Into<String>, keys: &[&str]) -> Result<Self> {
        let at = at.into();
        let map = value
            .as_object()
            .ok_or_else(|| invalid(format!("{at}はオブジェクトにしてください。")))?;
        if let Some(key) = keys.iter().find(|key| !map.contains_key(**key)) {
            return Err(invalid(format!("{at}に {key} がありません。")));
        }
        if let Some(key) = map.keys().find(|key| !keys.contains(&key.as_str())) {
            return Err(invalid(format!(
                "{at}に未知のフィールド {} があります。",
                clip(key)
            )));
        }
        Ok(Self { map, at })
    }
    fn get(&self, key: &str) -> &'a Value {
        &self.map[key]
    }
    fn fail(&self, key: &str, rule: impl std::fmt::Display) -> ModuleError {
        invalid(format!("{}の {key} は{rule}にしてください。", self.at))
    }
    fn sub(&self, key: &str) -> String {
        format!("{}の {key} ", self.at)
    }
    fn number(&self, key: &str) -> Result<f64> {
        // serde_json の Number は NaN / 無限大を持たないので、as_f64 の値は常に有限。
        self.get(key)
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| self.fail(key, "数値"))
    }
    fn range(&self, key: &str, min: f64, max: f64) -> Result<f64> {
        let n = self.number(key)?;
        if (min..=max).contains(&n) {
            Ok(n)
        } else {
            Err(self.fail(key, format!(" {min} 以上 {max} 以下")))
        }
    }
    fn positive(&self, key: &str, max: f64) -> Result<f64> {
        let n = self.number(key)?;
        if n > 0.0 && n <= max {
            Ok(n)
        } else {
            Err(self.fail(key, format!(" 0 より大きく {max} 以下")))
        }
    }
    fn magnitude(&self, key: &str, max: f64) -> Result<f64> {
        self.range(key, -max, max)
    }
    fn boolean(&self, key: &str) -> Result<bool> {
        self.get(key)
            .as_bool()
            .ok_or_else(|| self.fail(key, "真偽値"))
    }
    fn string(&self, key: &str) -> Result<&'a str> {
        self.get(key)
            .as_str()
            .ok_or_else(|| self.fail(key, "文字列"))
    }
    fn chars(&self, key: &str, max: usize) -> Result<&'a str> {
        let value = self.string(key)?;
        if value.chars().count() > max {
            return Err(self.fail(key, format!(" {max} 文字以下")));
        }
        Ok(value)
    }
    fn one_of(&self, key: &str, allowed: &[&str]) -> Result<&'a str> {
        let value = self.string(key)?;
        if allowed.contains(&value) {
            Ok(value)
        } else {
            Err(self.fail(key, format!(" {} のいずれか", allowed.join(" / "))))
        }
    }
    fn color(&self, key: &str) -> Result<()> {
        if is_color(self.string(key)?) {
            Ok(())
        } else {
            Err(self.fail(key, " #RRGGBB の形式"))
        }
    }
    fn opacity(&self) -> Result<f64> {
        self.range("opacity", 0.0, 1.0)
    }
    fn array(&self, key: &str) -> Result<&'a Vec<Value>> {
        self.get(key)
            .as_array()
            .ok_or_else(|| self.fail(key, "配列"))
    }
    fn ids(&self, key: &str) -> Result<Vec<&'a str>> {
        self.array(key)?
            .iter()
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| self.fail(key, "ID の文字列の配列"))
            })
            .collect()
    }
    fn nullable(&self, key: &str) -> Option<&'a Value> {
        Some(self.get(key)).filter(|v| !v.is_null())
    }
}

/// 利用者に見せる文字列を 32 文字までに切る (未検証の値を長いまま理由に入れない)。
fn clip(value: &str) -> String {
    let mut chars = value.chars();
    let head: String = chars.by_ref().take(32).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AssetKind {
    Image,
    Svg,
}

/// 木と参照の検査に使う、ノードから取り出した情報。
struct NodeInfo<'a> {
    /// frame / group だけが持つ
    children: Option<Vec<&'a str>>,
    asset: Option<(&'a str, AssetKind)>,
}

const COMMON: [&str; 6] = ["id", "name", "visible", "locked", "opacity", "type"];
const BOX: [&str; 4] = ["x", "y", "width", "height"];

fn node_keys(kind: &str) -> Option<Vec<&'static str>> {
    let (with_box, extra): (bool, &[&str]) = match kind {
        "frame" => (
            true,
            &["children", "clip", "fill", "stroke", "radius", "shadow"],
        ),
        "group" => (false, &["children"]),
        "rect" => (true, &["fill", "stroke", "radius", "shadow"]),
        "ellipse" => (true, &["fill", "stroke", "shadow"]),
        "line" => (false, &["x1", "y1", "x2", "y2", "stroke"]),
        "text" => (
            true,
            &[
                "text",
                "fontFamily",
                "fontSize",
                "fontWeight",
                "italic",
                "lineHeight",
                "letterSpacing",
                "align",
                "sizing",
                "fill",
                "shadow",
            ],
        ),
        "image" => (true, &["assetId", "radius", "shadow"]),
        "svg" => (true, &["assetId"]),
        _ => return None,
    };
    let mut keys = COMMON.to_vec();
    if with_box {
        keys.extend(BOX);
    }
    keys.extend(extra);
    Some(keys)
}

fn validate_box(f: &Fields<'_>, l: &Limits) -> Result<()> {
    f.magnitude("x", l.max_coordinate)?;
    f.magnitude("y", l.max_coordinate)?;
    f.range("width", 0.0, l.max_size)?;
    f.range("height", 0.0, l.max_size)?;
    Ok(())
}

fn validate_stroke(value: &Value, at: String, l: &Limits) -> Result<()> {
    let f = Fields::new(value, at, &["color", "opacity", "width"])?;
    f.color("color")?;
    f.opacity()?;
    f.positive("width", l.max_stroke_width)?;
    Ok(())
}

fn validate_shadow(value: &Value, at: String, l: &Limits) -> Result<()> {
    let f = Fields::new(value, at, &["x", "y", "blur", "color", "opacity"])?;
    f.magnitude("x", l.max_shadow_offset)?;
    f.magnitude("y", l.max_shadow_offset)?;
    f.range("blur", 0.0, l.max_shadow_blur)?;
    f.color("color")?;
    f.opacity()?;
    Ok(())
}

fn validate_point(value: &Value, at: String) -> Result<()> {
    let f = Fields::new(value, at, &["x", "y"])?;
    f.magnitude("x", 100.0)?;
    f.magnitude("y", 100.0)?;
    Ok(())
}

fn validate_paint(value: &Value, at: String, l: &Limits) -> Result<()> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let keys: &[&str] = match kind {
        "solid" => &["type", "color", "opacity"],
        "linear" => &["type", "stops", "from", "to"],
        "radial" => &["type", "stops", "center", "radius"],
        _ => {
            return Err(invalid(format!(
                "{at}の type は solid / linear / radial のいずれかにしてください。"
            )))
        }
    };
    let f = Fields::new(value, at, keys)?;
    if kind == "solid" {
        f.color("color")?;
        f.opacity()?;
        return Ok(());
    }
    let stops = f.array("stops")?;
    if !(l.min_gradient_stops..=l.max_gradient_stops).contains(&stops.len()) {
        return Err(f.fail(
            "stops",
            format!(" {}〜{} 個", l.min_gradient_stops, l.max_gradient_stops),
        ));
    }
    let mut previous = f64::NEG_INFINITY;
    for (index, stop) in stops.iter().enumerate() {
        let s = Fields::new(
            stop,
            format!("{}の停止点 {}", f.at, index + 1),
            &["offset", "color", "opacity"],
        )?;
        let offset = s.range("offset", 0.0, 1.0)?;
        if offset < previous {
            return Err(f.fail("stops", " offset の昇順"));
        }
        previous = offset;
        s.color("color")?;
        s.opacity()?;
    }
    if kind == "linear" {
        validate_point(f.get("from"), f.sub("from"))?;
        validate_point(f.get("to"), f.sub("to"))?;
    } else {
        validate_point(f.get("center"), f.sub("center"))?;
        f.positive("radius", 100.0)?;
    }
    Ok(())
}

fn optional<'a>(
    f: &Fields<'a>,
    key: &str,
    l: &Limits,
    check: fn(&Value, String, &Limits) -> Result<()>,
) -> Result<()> {
    match f.nullable(key) {
        Some(value) => check(value, f.sub(key), l),
        None => Ok(()),
    }
}

fn validate_node<'a>(id: &str, value: &'a Value, l: &Limits) -> Result<NodeInfo<'a>> {
    let at = format!("ノード「{id}」");
    let kind = value.get("type").and_then(Value::as_str);
    let keys = kind.and_then(node_keys).ok_or_else(|| {
        invalid(format!(
            "{at}の type は frame / group / rect / ellipse / line / text / image / svg のいずれかにしてください。"
        ))
    })?;
    let kind = kind.unwrap_or_default();
    let f = Fields::new(value, at, &keys)?;
    if f.string("id")? != id {
        return Err(invalid(format!(
            "{}の id が nodes のキーと一致しません。",
            f.at
        )));
    }
    f.chars("name", l.max_name_length)?;
    f.boolean("visible")?;
    f.boolean("locked")?;
    f.opacity()?;
    if keys.contains(&"x") {
        validate_box(&f, l)?;
    }
    if keys.contains(&"fill") {
        optional(&f, "fill", l, validate_paint)?;
    }
    if keys.contains(&"shadow") {
        optional(&f, "shadow", l, validate_shadow)?;
    }
    if keys.contains(&"radius") {
        f.range("radius", 0.0, l.max_radius)?;
    }
    if matches!(kind, "frame" | "rect" | "ellipse") {
        optional(&f, "stroke", l, validate_stroke)?;
    }
    let mut info = NodeInfo {
        children: None,
        asset: None,
    };
    match kind {
        "frame" | "group" => {
            if kind == "frame" {
                f.boolean("clip")?;
            }
            let children = f.ids("children")?;
            if kind == "group" && children.is_empty() {
                return Err(invalid(format!(
                    "{}の children は 1 個以上にしてください。",
                    f.at
                )));
            }
            info.children = Some(children);
        }
        "line" => {
            for key in ["x1", "y1", "x2", "y2"] {
                f.magnitude(key, l.max_coordinate)?;
            }
            validate_stroke(f.get("stroke"), f.sub("stroke"), l)?;
        }
        "text" => {
            f.chars("text", l.max_text_length)?;
            let family = f.chars("fontFamily", l.max_font_family_length)?;
            if family.is_empty() || family.chars().any(char::is_control) {
                return Err(f.fail(
                    "fontFamily",
                    format!(
                        " 1〜{} 文字で制御文字を含まない文字列",
                        l.max_font_family_length
                    ),
                ));
            }
            f.range("fontSize", l.min_font_size, l.max_font_size)?;
            let weight = f.number("fontWeight")?;
            if !(100.0..=900.0).contains(&weight) || weight % 100.0 != 0.0 {
                return Err(f.fail("fontWeight", " 100〜900 の 100 刻み"));
            }
            f.boolean("italic")?;
            if f.nullable("lineHeight").is_some() {
                f.positive("lineHeight", l.max_line_height)?;
            }
            f.magnitude("letterSpacing", l.max_letter_spacing)?;
            f.one_of("align", &["left", "center", "right"])?;
            f.one_of("sizing", &["auto-width", "auto-height", "fixed"])?;
        }
        "image" | "svg" => {
            let asset = f.string("assetId")?;
            if !is_id(asset) {
                return Err(f.fail("assetId", " ID の書式"));
            }
            let asset_kind = if kind == "image" {
                AssetKind::Image
            } else {
                AssetKind::Svg
            };
            info.asset = Some((asset, asset_kind));
        }
        _ => {}
    }
    Ok(info)
}

/// アセットの形を確かめ、種類と合計に数える長さを返す。中身 (画像・SVG) の検査は後で行う。
fn validate_asset_shape(id: &str, value: &Value, l: &Limits) -> Result<(AssetKind, usize)> {
    let at = format!("アセット「{id}」");
    let kind = match value.get("kind").and_then(Value::as_str) {
        Some("image") => AssetKind::Image,
        Some("svg") => AssetKind::Svg,
        _ => {
            return Err(invalid(format!(
                "{at}の kind は image / svg のいずれかにしてください。"
            )))
        }
    };
    let keys: &[&str] = match kind {
        AssetKind::Image => &["kind", "mime", "data", "width", "height"],
        AssetKind::Svg => &["kind", "svg", "text", "width", "height"],
    };
    let f = Fields::new(value, at, keys)?;
    f.range("width", 0.0, l.max_size)?;
    f.range("height", 0.0, l.max_size)?;
    let bytes = match kind {
        AssetKind::Image => {
            f.one_of("mime", &["image/png", "image/jpeg", "image/webp"])?;
            f.string("data")?.len()
        }
        AssetKind::Svg => {
            f.string("text")?;
            f.string("svg")?.len()
        }
    };
    Ok((kind, bytes))
}

fn validate_asset_content(id: &str, value: &Value) -> Result<()> {
    let at = format!("アセット「{id}」");
    let get = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default();
    if value.get("kind").and_then(Value::as_str) == Some("image") {
        let bytes = STANDARD
            .decode(get("data"))
            .map_err(|_| invalid(format!("{at}の画像の base64 が不正です。")))?;
        validate_image(&bytes, get("mime"))
            .map_err(|e| invalid(format!("{at}: {}", app_reason(e))))?;
    } else {
        let text =
            validate_svg(get("svg")).map_err(|e| invalid(format!("{at}: {}", app_reason(e))))?;
        if text != get("text") {
            return Err(invalid(format!(
                "{at}の検索用テキストがSVGと一致しません。"
            )));
        }
    }
    Ok(())
}

/// payload v2 を検証する (§3.3〜3.6)。`VectorModule::validate_payload` から呼ぶ形。
pub fn validate(payload: &Value) -> Result<()> {
    let l = &*LIMITS;
    let top = Fields::new(payload, "文書", &["pages", "nodes", "assets", "text"])?;
    let text = top.string("text")?;
    if text.len() > l.text_bytes {
        return Err(invalid("検索用テキストは1MiB以下にしてください。"));
    }

    // ページ
    let pages = top.array("pages")?;
    if pages.is_empty() || pages.len() > l.max_pages {
        return Err(invalid(format!(
            "ページは 1〜{} 個にしてください。",
            l.max_pages
        )));
    }
    let mut page_ids = HashSet::new();
    let mut roots = Vec::with_capacity(pages.len());
    for (index, page) in pages.iter().enumerate() {
        let f = Fields::new(
            page,
            format!("ページ {}", index + 1),
            &["id", "name", "children", "guides"],
        )?;
        let id = f.string("id")?;
        if !is_id(id) {
            return Err(f.fail("id", " ID の書式 (英数字・_・- の 1〜32 文字)"));
        }
        if !page_ids.insert(id) {
            return Err(invalid(format!("{}の id が重複しています。", f.at)));
        }
        f.chars("name", l.max_name_length)?;
        roots.push(f.ids("children")?);
        let guides = f.array("guides")?;
        if guides.len() > l.max_guides_per_page {
            return Err(f.fail("guides", format!(" {} 本以下", l.max_guides_per_page)));
        }
        for (guide_index, guide) in guides.iter().enumerate() {
            let g = Fields::new(
                guide,
                format!("{}のガイド線 {}", f.at, guide_index + 1),
                &["axis", "position"],
            )?;
            g.one_of("axis", &["x", "y"])?;
            g.magnitude("position", l.max_coordinate)?;
        }
    }

    // ノード
    let nodes = top
        .get("nodes")
        .as_object()
        .ok_or_else(|| invalid("nodes はオブジェクトにしてください。"))?;
    if nodes.len() > l.max_nodes {
        return Err(invalid(format!(
            "ノードは {} 個以下にしてください。",
            l.max_nodes
        )));
    }
    let mut infos = HashMap::with_capacity(nodes.len());
    for (id, node) in nodes {
        if !is_id(id) {
            return Err(invalid(format!(
                "ノードの ID「{}」は英数字・_・- の 1〜32 文字にしてください。",
                clip(id)
            )));
        }
        infos.insert(id.as_str(), validate_node(id, node, l)?);
    }

    // アセットの形
    let assets = top
        .get("assets")
        .as_object()
        .ok_or_else(|| invalid("assets はオブジェクトにしてください。"))?;
    let mut asset_kinds = HashMap::with_capacity(assets.len());
    let mut asset_bytes: usize = 0;
    for (id, asset) in assets {
        if !is_id(id) {
            return Err(invalid(format!(
                "アセットの ID「{}」は英数字・_・- の 1〜32 文字にしてください。",
                clip(id)
            )));
        }
        let (kind, bytes) = validate_asset_shape(id, asset, l)?;
        asset_kinds.insert(id.as_str(), kind);
        asset_bytes = asset_bytes.saturating_add(bytes);
    }

    // 木 (§3.3): ページから深さ優先でたどり、どのノードも 1 回だけ現れることを確かめる
    let mut seen: HashSet<&str> = HashSet::with_capacity(nodes.len());
    for children in &roots {
        let mut stack: Vec<(&str, usize)> = children.iter().rev().map(|id| (*id, 1)).collect();
        while let Some((id, depth)) = stack.pop() {
            let Some(info) = infos.get(id) else {
                return Err(invalid(format!(
                    "children が存在しないノード「{}」を指しています。",
                    clip(id)
                )));
            };
            if !seen.insert(id) {
                return Err(invalid(format!(
                    "ノード「{id}」が 2 か所以上の children に現れます。"
                )));
            }
            if depth > l.max_depth {
                return Err(invalid(format!(
                    "ノードの入れ子は {} 段以下にしてください。",
                    l.max_depth
                )));
            }
            if let Some(children) = &info.children {
                stack.extend(children.iter().rev().map(|child| (*child, depth + 1)));
            }
        }
    }
    if seen.len() != nodes.len() {
        let orphan = nodes
            .keys()
            .find(|id| !seen.contains(id.as_str()))
            .map(String::as_str)
            .unwrap_or_default();
        return Err(invalid(format!(
            "ノード「{orphan}」がどのページ・frame・group からも参照されていません。"
        )));
    }

    // アセットの参照 (§3.4 / §3.5)
    let mut referenced = HashSet::with_capacity(assets.len());
    for id in nodes.keys() {
        let Some((asset, kind)) = infos[id.as_str()].asset else {
            continue;
        };
        match asset_kinds.get(asset) {
            None => {
                return Err(invalid(format!(
                    "ノード「{id}」の assetId が存在しないアセットを指しています。"
                )))
            }
            Some(actual) if *actual != kind => {
                return Err(invalid(format!(
                    "ノード「{id}」の assetId が別の種類のアセットを指しています。"
                )))
            }
            Some(_) => {
                referenced.insert(asset);
            }
        }
    }
    if let Some(unused) = assets.keys().find(|id| !referenced.contains(id.as_str())) {
        return Err(invalid(format!(
            "アセット「{unused}」はどのノードからも参照されていません。"
        )));
    }
    if asset_bytes > l.payload_bytes {
        return Err(invalid("アセットの合計は20MiB以下にしてください。"));
    }
    for (id, asset) in assets {
        validate_asset_content(id, asset)?;
    }

    // 検索用テキスト (§3.6)
    if search_text(payload) != text {
        return Err(invalid("検索用テキストが文書と一致しません。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../../src/modules/vector/editor/model/fixtures/payload-v2.json"
        ))
        .expect("checked-in canvas contract")
    });

    fn valid_case(name: &str) -> Value {
        CONTRACT["valid"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap_or_else(|| panic!("valid case {name}"))["payload"]
            .clone()
    }

    fn reason(payload: &Value) -> String {
        match validate(payload) {
            Err(ModuleError::ValidationFailed { reason }) => reason,
            other => panic!("expected ValidationFailed, got {other:?}"),
        }
    }

    /// 契約データの patch を当てる。op は set / remove / append、path は文字列 (キー) と整数 (添字)。
    fn apply(target: &mut Value, patch: &Value) {
        let path = patch["path"].as_array().unwrap();
        let (last, parents) = path.split_last().unwrap();
        let mut parent = &mut *target;
        for step in parents {
            parent = match step {
                Value::String(key) => parent.get_mut(key.as_str()),
                Value::Number(index) => parent.get_mut(index.as_u64().unwrap() as usize),
                _ => panic!("bad path step {step}"),
            }
            .unwrap_or_else(|| panic!("missing path {path:?}"));
        }
        match patch["op"].as_str().unwrap() {
            "set" => match last {
                Value::String(key) => {
                    parent
                        .as_object_mut()
                        .unwrap()
                        .insert(key.clone(), patch["value"].clone());
                }
                Value::Number(index) => {
                    parent[index.as_u64().unwrap() as usize] = patch["value"].clone();
                }
                _ => panic!("bad path step {last}"),
            },
            "remove" => match last {
                Value::String(key) => {
                    parent.as_object_mut().unwrap().remove(key).unwrap();
                }
                Value::Number(index) => {
                    parent
                        .as_array_mut()
                        .unwrap()
                        .remove(index.as_u64().unwrap() as usize);
                }
                _ => panic!("bad path step {last}"),
            },
            "append" => {
                let array = match last {
                    Value::String(key) => parent.get_mut(key.as_str()),
                    Value::Number(index) => parent.get_mut(index.as_u64().unwrap() as usize),
                    _ => None,
                };
                array
                    .and_then(Value::as_array_mut)
                    .unwrap()
                    .push(patch["value"].clone());
            }
            op => panic!("unknown op {op}"),
        }
    }

    #[test]
    fn contract_valid_cases_pass() {
        for case in CONTRACT["valid"].as_array().unwrap() {
            let payload = &case["payload"];
            validate(payload).unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
            assert_eq!(search_text(payload), payload["text"], "{}", case["name"]);
        }
    }

    #[test]
    fn contract_invalid_cases_are_rejected() {
        let cases = CONTRACT["invalid"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let mut payload = valid_case(case["base"].as_str().unwrap());
            for patch in case["patch"].as_array().unwrap() {
                apply(&mut payload, patch);
            }
            let reason = reason(&payload);
            assert!(!reason.is_empty(), "{}", case["name"]);
        }
    }

    #[test]
    fn invalid_cases_fail_for_the_documented_reason() {
        // 拒否の理由が想定どおりか (別の規則で偶然落ちていないか) を代表的なものについて確かめる。
        let expected = [
            ("pages-empty", "ページは"),
            ("page-id-duplicate", "重複"),
            ("child-referenced-twice", "2 か所以上"),
            ("orphan-node", "参照されていません"),
            ("child-missing", "存在しないノード"),
            ("node-key-mismatch", "キーと一致しません"),
            ("unknown-node-type", "の type は"),
            ("unknown-field", "未知のフィールド rotation"),
            ("missing-field", "radius がありません"),
            ("bad-id", "ノードの ID"),
            ("bad-color", "#RRGGBB"),
            ("opacity-out-of-range", "opacity"),
            ("negative-size", "width"),
            ("coordinate-out-of-range", " x は"),
            ("number-as-string", "数値"),
            ("group-empty", "1 個以上"),
            ("gradient-one-stop", "stops"),
            ("gradient-stops-unsorted", "昇順"),
            ("font-weight-invalid", "fontWeight"),
            ("text-sizing-invalid", "sizing"),
            ("asset-missing", "存在しないアセット"),
            ("asset-unreferenced", "参照されていません"),
            ("asset-kind-mismatch", "別の種類"),
            ("image-data-mime-mismatch", "画像の形式と内容"),
            ("svg-asset-policy-violation", "未対応のSVG要素"),
            ("svg-asset-text-mismatch", "SVGと一致しません"),
            ("text-mismatch", "文書と一致しません"),
            ("guide-axis-invalid", "axis"),
            ("top-level-unknown-field", "未知のフィールド version"),
        ];
        let cases = CONTRACT["invalid"].as_array().unwrap();
        assert_eq!(cases.len(), expected.len(), "契約データの invalid が増えた");
        for (name, needle) in expected {
            let case = cases.iter().find(|c| c["name"] == name).unwrap();
            let mut payload = valid_case(case["base"].as_str().unwrap());
            for patch in case["patch"].as_array().unwrap() {
                apply(&mut payload, patch);
            }
            let reason = reason(&payload);
            assert!(reason.contains(needle), "{name}: {reason}");
        }
    }

    #[test]
    fn patterns_match_the_hand_written_checks() {
        assert_eq!(LIMITS.id_pattern, "^[A-Za-z0-9_-]{1,32}$");
        assert_eq!(LIMITS.color_pattern, "^#[0-9A-Fa-f]{6}$");
        for id in ["a", "Z9", "_-", &"a".repeat(32), "page1", "legacy"] {
            assert!(is_id(id), "{id}");
        }
        for id in ["", &"a".repeat(33), "bad id", "a.b", "é", "a\n", "ａ"] {
            assert!(!is_id(id), "{id:?}");
        }
        for color in ["#000000", "#FFFFFF", "#abcdef", "#AbC123"] {
            assert!(is_color(color), "{color}");
        }
        for color in [
            "",
            "#12345",
            "#1234567",
            "123456",
            "#GGGGGG",
            "#12345\n",
            "#１２３４５６",
        ] {
            assert!(!is_color(color), "{color:?}");
        }
    }

    #[test]
    fn image_limits_agree_with_validate_image() {
        // PNG の上限は既存の validate_image が持つ。limits.json と同じ値であることを確かめる。
        fn png(width: u64, height: u64) -> Vec<u8> {
            let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
            bytes.extend((width as u32).to_be_bytes());
            bytes.extend((height as u32).to_be_bytes());
            bytes
        }
        let side = LIMITS.max_image_side;
        let pixels = LIMITS.max_image_pixels;
        assert!(validate_image(&png(side, 1), "image/png").is_ok());
        assert!(validate_image(&png(side + 1, 1), "image/png").is_err());
        assert!(validate_image(&png(1, side + 1), "image/png").is_err());
        let square = (pixels as f64).sqrt() as u64;
        assert_eq!(square * square, pixels);
        assert!(validate_image(&png(square, square), "image/png").is_ok());
        assert!(validate_image(&png(square + 1, square), "image/png").is_err());
        // テキストの上限は v1 と同じ (SVG アセットの text は validate_svg の上限に従う)。
        assert_eq!(LIMITS.text_bytes, super::super::MAX_TEXT_BYTES);
    }

    fn rect(id: &str) -> Value {
        json!({
            "id": id, "name": "", "visible": true, "locked": false, "opacity": 1,
            "x": 0, "y": 0, "width": 10, "height": 10, "type": "rect",
            "fill": null, "stroke": null, "radius": 0, "shadow": null
        })
    }

    fn frame(id: &str, children: Vec<String>) -> Value {
        json!({
            "id": id, "name": "", "visible": true, "locked": false, "opacity": 1,
            "x": 0, "y": 0, "width": 10, "height": 10, "type": "frame",
            "children": children, "clip": false, "fill": null, "stroke": null,
            "radius": 0, "shadow": null
        })
    }

    fn document(root: Vec<String>, nodes: Map<String, Value>) -> Value {
        json!({
            "pages": [{ "id": "page1", "name": "ページ 1", "children": root, "guides": [] }],
            "nodes": nodes,
            "assets": {},
            "text": ""
        })
    }

    /// 深さ `depth` の frame の鎖 (ページ直下が 1)。
    fn chain(depth: usize) -> Value {
        let mut nodes = Map::new();
        for level in 1..=depth {
            let children = if level < depth {
                vec![format!("n{}", level + 1)]
            } else {
                vec![]
            };
            nodes.insert(format!("n{level}"), frame(&format!("n{level}"), children));
        }
        document(vec!["n1".into()], nodes)
    }

    #[test]
    fn depth_limit_is_inclusive() {
        let max = LIMITS.max_depth;
        validate(&chain(max)).unwrap();
        assert!(reason(&chain(max + 1)).contains("入れ子"));
    }

    fn flat(count: usize) -> Value {
        let ids: Vec<String> = (0..count).map(|i| format!("r{i}")).collect();
        let nodes = ids.iter().map(|id| (id.clone(), rect(id))).collect();
        document(ids, nodes)
    }

    #[test]
    fn node_count_limit_is_inclusive() {
        let max = LIMITS.max_nodes;
        validate(&flat(max)).unwrap();
        assert!(reason(&flat(max + 1)).contains("ノードは"));
    }

    #[test]
    fn cycles_are_rejected() {
        let mut nodes = Map::new();
        nodes.insert("a".into(), frame("a", vec!["b".into()]));
        nodes.insert("b".into(), frame("b", vec!["a".into()]));
        // ページから届かない輪
        assert!(reason(&document(vec![], nodes.clone())).contains("参照されていません"));
        // ページから届く輪
        assert!(reason(&document(vec!["a".into()], nodes)).contains("2 か所以上"));
        // 自分自身を子に持つ
        let mut nodes = Map::new();
        nodes.insert("a".into(), frame("a", vec!["a".into()]));
        assert!(reason(&document(vec!["a".into()], nodes)).contains("2 か所以上"));
    }

    fn text_node(id: &str, text: &str) -> Value {
        json!({
            "id": id, "name": "", "visible": false, "locked": false, "opacity": 1,
            "x": 0, "y": 0, "width": 10, "height": 10, "type": "text",
            "text": text, "fontFamily": "Hiragino Sans", "fontSize": 16, "fontWeight": 400,
            "italic": false, "lineHeight": null, "letterSpacing": 0, "align": "left",
            "sizing": "auto-width", "fill": null, "shadow": null
        })
    }

    fn texts(values: &[&str]) -> Value {
        let ids: Vec<String> = (0..values.len()).map(|i| format!("t{i}")).collect();
        let nodes = ids
            .iter()
            .zip(values)
            .map(|(id, text)| (id.clone(), text_node(id, text)))
            .collect();
        document(ids, nodes)
    }

    #[test]
    fn search_text_whitespace_is_char_is_whitespace() {
        // U+FEFF は空白として扱わない (JavaScript の \s と違う)。U+0085 と U+3000 は空白。
        assert_eq!(search_text(&texts(&["a\u{feff}b"])), "a\u{feff}b");
        assert_eq!(search_text(&texts(&["\u{feff}"])), "\u{feff}");
        assert_eq!(search_text(&texts(&["a\u{85}b\u{3000}c"])), "a b c");
        assert_eq!(
            search_text(&texts(&["  x\t\n y ", "", " \u{2028} ", "z"])),
            "x y z"
        );
        // 非表示のノードも拾う (text_node は visible: false)
        let mut payload = texts(&["見出し", "本文"]);
        payload["text"] = json!("見出し 本文");
        validate(&payload).unwrap();
        payload["text"] = json!("見出し  本文");
        assert!(reason(&payload).contains("文書と一致しません"));
    }

    #[test]
    fn search_text_stops_on_malformed_documents() {
        assert_eq!(search_text(&json!(null)), "");
        assert_eq!(search_text(&json!({ "pages": "x" })), "");
        let looping = json!({
            "pages": [{ "children": ["a", "a"] }],
            "nodes": { "a": { "type": "frame", "name": "A", "children": ["a"] } }
        });
        assert_eq!(search_text(&looping), "A");
    }

    #[test]
    fn text_byte_limit() {
        let max = LIMITS.text_bytes;
        let mut payload = texts(&[&"a".repeat(max)]);
        // maxTextLength を超えるので本文の検査でも落ちるが、先に text の大きさで落ちることを確かめる
        payload["text"] = json!("a".repeat(max + 1));
        assert!(reason(&payload).contains("1MiB"));
    }

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    /// 1x1 の PNG と、全体の合計が `total` バイトになる SVG アセットを持つ文書。
    fn with_assets(total: usize) -> Value {
        let head = "<svg xmlns=\"http://www.w3.org/2000/svg\"><!--";
        let tail = "--></svg>";
        let filler = total - PNG_1X1.len() - head.len() - tail.len();
        let svg = format!("{head}{}{tail}", "a".repeat(filler));
        assert_eq!(svg.len() + PNG_1X1.len(), total);
        json!({
            "pages": [{ "id": "page1", "name": "", "children": ["i", "s"], "guides": [] }],
            "nodes": {
                "i": {
                    "id": "i", "name": "", "visible": true, "locked": false, "opacity": 1,
                    "x": 0, "y": 0, "width": 1, "height": 1, "type": "image",
                    "assetId": "png", "radius": 0, "shadow": null
                },
                "s": {
                    "id": "s", "name": "", "visible": true, "locked": false, "opacity": 1,
                    "x": 0, "y": 0, "width": 1, "height": 1, "type": "svg", "assetId": "svg"
                }
            },
            "assets": {
                "png": { "kind": "image", "mime": "image/png", "data": PNG_1X1, "width": 1, "height": 1 },
                "svg": { "kind": "svg", "svg": svg, "text": "", "width": 1, "height": 1 }
            },
            "text": ""
        })
    }

    #[test]
    fn asset_total_limit_is_inclusive() {
        let max = LIMITS.payload_bytes;
        validate(&with_assets(max)).unwrap();
        assert!(reason(&with_assets(max + 1)).contains("アセットの合計"));
    }

    #[test]
    fn shared_image_asset_is_allowed() {
        let mut payload = with_assets(1000);
        payload["pages"][0]["children"] = json!(["i", "j", "s"]);
        let mut second = payload["nodes"]["i"].clone();
        second["id"] = json!("j");
        payload["nodes"]["j"] = second;
        validate(&payload).unwrap();
    }

    #[test]
    fn field_rules_from_the_design() {
        let base = valid_case("full");
        let rejects = |path: &[&str], value: Value| {
            let mut payload = base.clone();
            let mut target = &mut payload;
            for step in path {
                target = match step.parse::<usize>() {
                    Ok(index) => &mut target[index],
                    Err(_) => &mut target[*step],
                };
            }
            *target = value;
            assert!(validate(&payload).is_err(), "{path:?}");
        };
        rejects(&["nodes", "text1", "lineHeight"], json!(0));
        rejects(&["nodes", "text1", "fontFamily"], json!(""));
        rejects(&["nodes", "text1", "fontFamily"], json!("A\u{7}"));
        rejects(&["nodes", "text1", "fontSize"], json!(0.5));
        rejects(&["nodes", "text1", "italic"], json!(1));
        rejects(&["nodes", "rect1", "stroke", "width"], json!(0));
        rejects(&["nodes", "rect1", "shadow", "blur"], json!(-1));
        rejects(&["nodes", "rect1", "fill", "to", "x"], json!(100.5));
        rejects(&["nodes", "ellipse1", "fill", "radius"], json!(0));
        rejects(&["nodes", "line1", "stroke"], json!(null));
        rejects(&["nodes", "rect1", "name"], json!("あ".repeat(201)));
        rejects(&["pages", "0", "name"], json!("あ".repeat(201)));
        rejects(&["nodes", "rect1", "visible"], json!("true"));
        rejects(&["text"], json!(null));
        // 境界ちょうどは通る
        let mut payload = base.clone();
        payload["nodes"]["rect1"]["name"] = json!("あ".repeat(200));
        payload["nodes"]["rect1"]["x"] = json!(-1_000_000);
        payload["nodes"]["text1"]["lineHeight"] = json!(10_000);
        payload["nodes"]["text1"]["fontWeight"] = json!(900.0);
        validate(&payload).unwrap();
    }
}
