//! ダイアグラムのローカルファイル入出力境界。

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

use super::super::image_export::{decode_and_validate_image, write_atomically};
use super::{validate_diagram_xml, MAX_DIAGRAM_BYTES};

#[tauri::command]
pub fn diagram_read_file(path: String) -> Result<String, AppError> {
    let path = PathBuf::from(path);
    require_extension(&path, &["drawio", "xml"])?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_DIAGRAM_BYTES as u64 {
        return Err(validation("diagram import must be 1 MiB or smaller"));
    }
    let xml = fs::read_to_string(&path)
        .map_err(|error| AppError::Io(format!("failed to read {}: {error}", path.display())))?;
    validate_diagram_xml(&xml).map_err(module_error_to_app)?;
    Ok(xml)
}

#[tauri::command]
pub fn diagram_write_file(path: String, format: String, data: String) -> Result<(), AppError> {
    let path = PathBuf::from(path);
    let bytes = match format.as_str() {
        "drawio" => {
            require_extension(&path, &["drawio", "xml"])?;
            validate_diagram_xml(&data).map_err(module_error_to_app)?;
            data.into_bytes()
        }
        "svg" => decode_and_validate_image("diagram", &path, "svg", &data)?.1,
        "png" => decode_and_validate_image("diagram", &path, "png", &data)?.1,
        _ => {
            return Err(validation(
                "diagram export format must be drawio, svg, or png",
            ));
        }
    };

    write_atomically(&path, &bytes)
}

fn require_extension(path: &Path, allowed: &[&str]) -> Result<(), AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension
        .as_deref()
        .is_some_and(|value| allowed.contains(&value))
    {
        Ok(())
    } else {
        Err(validation(format!(
            "unsupported file extension for {}",
            path.display()
        )))
    }
}

fn validation(reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: "diagram".into(),
        reason: reason.into(),
    }
}

fn module_error_to_app(error: crate::module::ModuleError) -> AppError {
    validation(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    const XML: &str = r#"<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>"#;
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

    #[test]
    fn reads_valid_xml_and_rejects_other_extensions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sample.drawio");
        fs::write(&path, XML).unwrap();
        assert_eq!(diagram_read_file(path.display().to_string()).unwrap(), XML);

        let invalid = directory.path().join("sample.txt");
        fs::write(&invalid, XML).unwrap();
        assert!(diagram_read_file(invalid.display().to_string()).is_err());
    }

    #[test]
    fn rejects_invalid_and_oversized_imports() {
        let directory = tempfile::tempdir().unwrap();
        let invalid = directory.path().join("invalid.xml");
        fs::write(&invalid, "<svg/>").unwrap();
        assert!(diagram_read_file(invalid.display().to_string()).is_err());

        let oversized = directory.path().join("oversized.drawio");
        fs::write(&oversized, vec![b'x'; MAX_DIAGRAM_BYTES + 1]).unwrap();
        assert!(diagram_read_file(oversized.display().to_string()).is_err());
    }

    #[test]
    fn writes_each_supported_format_and_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let drawio = directory.path().join("sample.drawio");
        fs::write(&drawio, "old").unwrap();
        diagram_write_file(drawio.display().to_string(), "drawio".into(), XML.into()).unwrap();
        assert_eq!(fs::read_to_string(drawio).unwrap(), XML);

        let svg = directory.path().join("sample.svg");
        diagram_write_file(svg.display().to_string(), "svg".into(), "<svg/>".into()).unwrap();
        assert_eq!(fs::read_to_string(svg).unwrap(), "<svg/>");

        let png = directory.path().join("sample.png");
        diagram_write_file(
            png.display().to_string(),
            "png".into(),
            format!("data:image/png;base64,{}", BASE64.encode(PNG)),
        )
        .unwrap();
        assert_eq!(fs::read(png).unwrap(), PNG);
    }

    #[test]
    fn rejects_mismatched_or_invalid_exports() {
        let directory = tempfile::tempdir().unwrap();
        assert!(diagram_write_file(
            directory.path().join("sample.txt").display().to_string(),
            "svg".into(),
            "<svg/>".into(),
        )
        .is_err());
        assert!(diagram_write_file(
            directory.path().join("sample.png").display().to_string(),
            "png".into(),
            "not a png".into(),
        )
        .is_err());
    }
}
