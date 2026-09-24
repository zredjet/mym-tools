use super::validation::{error, validate_image, validate_svg, MAX_SVG_BYTES};
use crate::{error::AppError, modules::image_export::write_atomically};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};

#[derive(Serialize)]
pub struct VectorDocument {
    pub svg: String,
    pub text: String,
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
    let text = validate_svg(&svg)?;
    Ok(VectorDocument { svg, text })
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
fn write_file(path: String, format: String, data: String) -> Result<(), AppError> {
    let path = Path::new(&path);
    if extension(path) != format {
        return Err(error("出力形式と拡張子が一致しません。"));
    }
    match format.as_str() {
        "svg" => {
            validate_svg(&data)?;
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
        assert!(write_file(path.clone(), "svg".into(), "<script/>".into()).is_err());
        assert!(write_file(path, "png".into(), "invalid".into()).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), svg);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
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
