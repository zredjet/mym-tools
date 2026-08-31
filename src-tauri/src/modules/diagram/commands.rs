//! ダイアグラムのローカルファイル入出力境界。

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use crate::error::AppError;

use super::{validate_diagram_xml, MAX_DIAGRAM_BYTES};

const MAX_EXPORT_BYTES: usize = 20 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

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
        "svg" => {
            require_extension(&path, &["svg"])?;
            let bytes = decode_data_url(&data, "data:image/svg+xml;base64,")?;
            if bytes.len() > MAX_EXPORT_BYTES || !looks_like_svg(&bytes) {
                return Err(validation("SVG export is invalid or larger than 20 MiB"));
            }
            bytes
        }
        "png" => {
            require_extension(&path, &["png"])?;
            let bytes = decode_data_url(&data, "data:image/png;base64,")?;
            if bytes.len() > MAX_EXPORT_BYTES || !bytes.starts_with(PNG_SIGNATURE) {
                return Err(validation("PNG export is invalid or larger than 20 MiB"));
            }
            bytes
        }
        _ => {
            return Err(validation(
                "diagram export format must be drawio, svg, or png",
            ));
        }
    };

    write_atomically(&path, &bytes)
}

fn decode_data_url(data: &str, prefix: &str) -> Result<Vec<u8>, AppError> {
    if let Some(encoded) = data.strip_prefix(prefix) {
        BASE64
            .decode(encoded)
            .map_err(|error| validation(format!("invalid export base64: {error}")))
    } else {
        Ok(data.as_bytes().to_vec())
    }
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes)
        .ok()
        .map(str::trim_start)
        .is_some_and(|text| {
            text.starts_with("<svg")
                || text
                    .strip_prefix("<?xml")
                    .and_then(|rest| rest.find("?>").map(|end| &rest[end + 2..]))
                    .map(str::trim_start)
                    .is_some_and(|rest| rest.starts_with("<svg"))
        })
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

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| AppError::Io(format!("output path has no parent: {}", path.display())))?;
    if !parent.is_dir() {
        return Err(AppError::Io(format!(
            "output directory does not exist: {}",
            parent.display()
        )));
    }

    let temp_path = temporary_path(path);
    let result = (|| -> Result<(), AppError> {
        let mut file = File::create(&temp_path)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        replace_atomically(&temp_path, path)?;
        sync_parent_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    PathBuf::from(name)
}

#[cfg(not(windows))]
fn replace_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        return fs::rename(source, destination);
    }
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: 両パスは終端NUL付きで、この呼び出し中はバッファが生存している。
    let success = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            source_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
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
