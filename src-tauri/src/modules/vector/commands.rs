use super::validation::{error, validate_image, validate_svg, MAX_SVG_BYTES};
use super::CURRENT_PAYLOAD_VERSION;
use crate::commands::{run_storage, LockMode};
use crate::state::AppState;
use crate::storage::{ItemId, StorageService};
use crate::{error::AppError, modules::image_export::write_atomically};
use base64::{engine::general_purpose::STANDARD, Engine};
use quick_xml::{
    events::{BytesStart, Event},
    Reader, XmlVersion,
};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::{fs::File, io::Read, path::Path};
use tauri::State;

#[derive(Serialize)]
pub struct VectorDocument {
    pub svg: String,
    pub text: String,
    /// 取り込み時に行った変換の説明 (draw.io の SVG など)。変換しなければ空
    pub notices: Vec<String>,
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}
fn read_bounded(path: &Path) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_SVG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SVG_BYTES {
        return Err(error("ファイルは20MiB以下にしてください。"));
    }
    Ok(bytes)
}
fn read_file(path: String) -> Result<VectorDocument, AppError> {
    let path = Path::new(&path);
    if extension(path) != "svg" {
        return Err(error("SVGファイルを選択してください。"));
    }
    let svg =
        String::from_utf8(read_bounded(path)?).map_err(|_| error("SVGはUTF-8にしてください。"))?;
    // draw.io の SVG は HTML ラベルなどを含みポリシーで拒否されるため、取り込み用に変換し、
    // 変換内容を notices で利用者に示す
    let (svg, notices) = match super::drawio_import::convert_drawio_svg(&svg)? {
        Some(converted) => (converted.svg, converted.notices),
        None => (svg, Vec::new()),
    };
    let text = validate_svg(&svg)?;
    Ok(VectorDocument { svg, text, notices })
}
fn read_image(path: String) -> Result<String, AppError> {
    let path = Path::new(&path);
    let mime = match extension(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err(error("PNG/JPEG/WebPを選択してください。")),
    };
    let bytes = read_bounded(path)?;
    validate_image(&bytes, mime)?;
    let data = format!("data:{mime};base64,{}", STANDARD.encode(bytes));
    if data.len() > MAX_SVG_BYTES {
        return Err(error("埋め込み画像が20MiBを超えます。"));
    }
    Ok(data)
}
/// 書き出す SVG の上限 (`docs/canvas-editor-design.md` §4.9)。埋め込み SVG と画像は base64 で
/// 4/3 倍になるので、20 MiB の埋め込み SVG を持つ文書も書き出せる大きさにする。
/// TypeScript の `MAX_EXPORT_SVG_BYTES` (`editor/export/svg.ts`) と同じ値。
pub const MAX_EXPORT_SVG_BYTES: usize = 28 * 1024 * 1024;

/// 書き出す SVG が XML として整形式で、ルートの要素が 1 つの `svg` であることだけを確かめる (§4.9)。
///
/// 取込用の SVG ポリシーは当てない (エディタの出力は `data:image/svg+xml` の `<image>`、`lang`・
/// `xml:lang`・`style` などをルートに持つ)。壊れた文字列や SVG でないものを `.svg` として書かないための検査。
fn check_export_svg(svg: &str) -> Result<(), AppError> {
    let malformed =
        |e: &dyn std::fmt::Display| error(format!("書き出す SVG の XML が不正です: {e}"));
    let mut reader = Reader::from_str(svg);
    let (mut depth, mut roots) = (0usize, 0usize);
    let mut open = |element: &BytesStart, depth: usize| -> Result<(), AppError> {
        if depth == 0 {
            roots += 1;
            if roots > 1 || element.local_name().as_ref() != b"svg" {
                return Err(error(
                    "書き出す SVG のルートの要素が svg 1 つではありません。",
                ));
            }
        }
        for attr in element.attributes() {
            let attr = attr.map_err(|e| malformed(&e))?;
            attr.normalized_value(XmlVersion::Implicit1_0)
                .map_err(|e| malformed(&e))?;
        }
        Ok(())
    };
    loop {
        match reader.read_event().map_err(|e| malformed(&e))? {
            Event::Start(element) => {
                open(&element, depth)?;
                depth += 1;
            }
            Event::Empty(element) => open(&element, depth)?,
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| error("書き出す SVG の閉じタグが不正です。"))?;
            }
            Event::Text(text) if depth == 0 => {
                if !text.iter().all(u8::is_ascii_whitespace) {
                    return Err(error("書き出す SVG のルートの外に文字があります。"));
                }
            }
            Event::CData(_) | Event::GeneralRef(_) if depth == 0 => {
                return Err(error("書き出す SVG のルートの外に文字があります。"));
            }
            Event::GeneralRef(entity) => {
                let entity = entity.decode().map_err(|e| malformed(&e))?;
                quick_xml::escape::unescape(&format!("&{entity};")).map_err(|e| malformed(&e))?;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if roots != 1 || depth != 0 {
        return Err(error(
            "書き出す SVG のルートの要素が svg 1 つではありません。",
        ));
    }
    Ok(())
}

fn write_file(path: String, format: String, data: String) -> Result<(), AppError> {
    let path = Path::new(&path);
    if extension(path) != format {
        return Err(error("出力形式と拡張子が一致しません。"));
    }
    match format.as_str() {
        // 書き出す SVG はエディタが作った出力で、埋め込み SVG を `data:image/svg+xml` の `<image>` で持つ。
        // 取込用の SVG ポリシー (`validate_svg`) は data URL の SVG を拒否するので当てず、
        // UTF-8 (`String` なので保証済み)、大きさ、XML として整形式でルートが `svg` であることを
        // 確かめる (§4.9)。
        "svg" => {
            if data.trim().is_empty() || data.len() > MAX_EXPORT_SVG_BYTES {
                return Err(error("SVGは空でなく28MiB以下にしてください。"));
            }
            check_export_svg(&data)?;
            write_atomically(path, data.as_bytes())
        }
        "png" => {
            if data.len() > (MAX_SVG_BYTES * 4 / 3 + 128) {
                return Err(error("PNGは20MiB以下にしてください。"));
            }
            let body = data
                .strip_prefix("data:image/png;base64,")
                .ok_or_else(|| error("PNGデータが不正です。"))?;
            let bytes = STANDARD
                .decode(body)
                .map_err(|_| error("PNGのbase64が不正です。"))?;
            validate_image(&bytes, "image/png")?;
            write_atomically(path, &bytes)
        }
        _ => Err(error("SVG/PNGのみ書き出せます。")),
    }
}

/// 新しい形式に変換できない v1 の作品の、保存されている元の SVG を `path` へ書く (ADR-0027)。
///
/// 読み取りだけで、行は変えない (Eager-on-Read を発火しない)。変換できず開けない作品から
/// 中身を取り出すための口。書き出すのは保存されている文字列そのままで、ポリシーは当てない。
fn export_original_svg(
    storage: &dyn StorageService,
    id: &ItemId,
    path: &Path,
) -> Result<(), AppError> {
    if extension(path) != "svg" {
        return Err(error("拡張子を .svg にしてください。"));
    }
    let stored = storage.stored_payload_if_not_current("vector", id, CURRENT_PAYLOAD_VERSION)?;
    let payload = match stored {
        Some((1, payload)) => payload,
        _ => {
            return Err(error(
                "この作品は元の形式 (ベクター描画の SVG) で保存されていません。",
            ))
        }
    };
    let svg = payload
        .get("svg")
        .and_then(Value::as_str)
        .filter(|svg| !svg.trim().is_empty())
        .ok_or_else(|| error("保存されている SVG が読めません。"))?;
    write_atomically(path, svg.as_bytes())
}

// Bounded file I/O and XML/image validation run away from the WebView thread.
#[tauri::command]
pub async fn vector_read_file(path: String) -> Result<VectorDocument, AppError> {
    tauri::async_runtime::spawn_blocking(move || read_file(path))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}
#[tauri::command]
pub async fn vector_read_image(path: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || read_image(path))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}
#[tauri::command]
pub async fn vector_write_file(path: String, format: String, data: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || write_file(path, format, data))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn vector_export_original_svg(
    state: State<'_, AppState>,
    item_id: String,
    path: String,
) -> Result<(), AppError> {
    let storage = Arc::clone(&state.storage);
    run_storage(&state, LockMode::Shared, move || {
        export_original_svg(storage.as_ref(), &ItemId::new(item_id), Path::new(&path))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_roundtrip_and_failed_export_preserve_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("作品.svg");
        let path = file.to_string_lossy().to_string();
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>日本語</text></svg>";
        write_file(path.clone(), "svg".into(), svg.into()).unwrap();
        let loaded = read_file(path.clone()).unwrap();
        assert_eq!(loaded.svg, svg);
        assert_eq!(loaded.text, "日本語");
        // 失敗した書き出しは既存のファイルを変えない
        let too_large = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><!--{}--></svg>",
            "a".repeat(MAX_EXPORT_SVG_BYTES)
        );
        assert!(write_file(path.clone(), "svg".into(), too_large).is_err());
        assert!(write_file(path.clone(), "svg".into(), " \n".into()).is_err());
        assert!(write_file(path, "png".into(), "invalid".into()).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), svg);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// 書き出す SVG は取込用の SVG ポリシーで検証しない (§4.9)。埋め込み SVG を
    /// `data:image/svg+xml` の `<image>` で持つ出力も、28 MiB までなら書ける。
    #[test]
    fn exported_svg_skips_the_import_policy_up_to_28_mib() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("書き出し.svg");
        let path_text = path.to_string_lossy().to_string();
        let embedded = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"data:image/svg+xml;base64,{}\" width=\"10\" height=\"10\"/></svg>",
            STANDARD.encode("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
        );
        assert!(
            validate_svg(&embedded).is_err(),
            "取込用のポリシーは拒否する"
        );
        write_file(path_text.clone(), "svg".into(), embedded.clone()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), embedded);

        let head = "<svg xmlns=\"http://www.w3.org/2000/svg\"><!--";
        let tail = "--></svg>";
        let exact = format!(
            "{head}{}{tail}",
            "a".repeat(MAX_EXPORT_SVG_BYTES - head.len() - tail.len())
        );
        assert_eq!(exact.len(), MAX_EXPORT_SVG_BYTES);
        assert_eq!(MAX_EXPORT_SVG_BYTES, 29_360_128);
        write_file(path_text.clone(), "svg".into(), exact.clone()).unwrap();
        assert!(write_file(path_text, "svg".into(), format!("{exact} ")).is_err());
        assert_eq!(std::fs::read(&path).unwrap().len(), MAX_EXPORT_SVG_BYTES);
    }
    /// 書き出す SVG は XML として整形式で、ルートの要素が svg 1 つであること (§4.9)。
    #[test]
    fn exported_svg_must_be_well_formed_with_an_svg_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("書き出し.svg");
        let path_text = path.to_string_lossy().to_string();
        // エディタの出力の形 (根の lang / xml:lang / style、XML 宣言、文字参照、CDATA の style)
        for svg in [
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" lang=\"ja\" xml:lang=\"ja\" style=\"background:#fff\" width=\"10\" height=\"10\"><style><![CDATA[text{font:12px sans-serif}]]></style><text>a &amp; &#x3042;</text></svg>\n",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            "<!-- c --><svg:svg xmlns:svg=\"http://www.w3.org/2000/svg\"></svg:svg>",
        ] {
            write_file(path_text.clone(), "svg".into(), svg.into())
                .unwrap_or_else(|e| panic!("{svg}: {e}"));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), svg);
        }
        let kept = std::fs::read_to_string(&path).unwrap();
        for svg in [
            "not xml",
            "<html/>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\">",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"></g>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg><svg/>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>tail",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>&unknown;</text></svg>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\" a=\"1\" a=\"2\"/>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\" a=\"&bad;\"/>",
        ] {
            assert!(
                write_file(path_text.clone(), "svg".into(), svg.into()).is_err(),
                "{svg}"
            );
        }
        // 失敗した書き出しは既存のファイルを変えない
        assert_eq!(std::fs::read_to_string(&path).unwrap(), kept);
    }

    fn storage_with_vector(version: u32, payload: Value) -> (Arc<dyn StorageService>, ItemId) {
        let storage: Arc<dyn StorageService> =
            Arc::new(crate::storage::SqliteStorage::open(":memory:").unwrap());
        let project = storage.create_project("P", None).unwrap();
        let id = storage
            .create_item(
                "vector",
                &project.id,
                "古い作品",
                &[],
                version,
                &payload,
                "古い作品",
            )
            .unwrap();
        (storage, id)
    }

    /// 変換できない v1 の作品の元の SVG を、行を変えずに書き出せる (ADR-0027)。
    #[test]
    fn original_svg_of_a_v1_item_is_exported_without_changing_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
        let v1 = serde_json::json!({ "svg": svg, "text": "" });
        let (storage, id) = storage_with_vector(1, v1.clone());
        let revision = storage.data_revision().unwrap();
        let path = dir.path().join("元の作品.svg");
        export_original_svg(storage.as_ref(), &id, &path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), svg);
        let project = &storage.list_projects().unwrap()[0];
        let row = &storage.list_items("vector", &project.id, 10, 0).unwrap()[0];
        assert_eq!(row.payload_schema_version, 1);
        assert_eq!(row.payload, v1);
        assert_eq!(storage.data_revision().unwrap(), revision);

        // 拡張子が svg でない、行が無い
        assert!(export_original_svg(storage.as_ref(), &id, &dir.path().join("a.png")).is_err());
        assert!(matches!(
            export_original_svg(storage.as_ref(), &ItemId::new("missing"), &path),
            Err(AppError::NotFound { .. })
        ));
    }

    #[test]
    fn original_svg_is_only_for_v1_items() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("作品.svg");
        let v2: Value = serde_json::from_str(include_str!(
            "../../../../src/modules/vector/editor/model/fixtures/payload-v2.json"
        ))
        .unwrap();
        let (storage, id) = storage_with_vector(2, v2["valid"][0]["payload"].clone());
        assert!(export_original_svg(storage.as_ref(), &id, &path).is_err());
        let (storage, id) = storage_with_vector(1, serde_json::json!({ "text": "" }));
        assert!(export_original_svg(storage.as_ref(), &id, &path).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn image_formats_are_checked_before_read_and_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, b"not a PNG").unwrap();
        assert!(read_image(path.to_string_lossy().into()).is_err());
        let data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=";
        write_file(path.to_string_lossy().into(), "png".into(), data.into()).unwrap();
        assert_eq!(read_image(path.to_string_lossy().into()).unwrap(), data);
        assert!(write_file(
            path.to_string_lossy().into(),
            "png".into(),
            "data:image/png;base64,/9j/4A==".into()
        )
        .is_err());
        assert_eq!(read_image(path.to_string_lossy().into()).unwrap(), data);
    }
}
