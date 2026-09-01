//! Mermaid / Diagram が共有するローカル画像書出し境界。

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use crate::error::AppError;

pub(crate) const MAX_IMAGE_EXPORT_BYTES: usize = 20 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImageFormat {
    Svg,
    Png,
}

pub(crate) fn decode_and_validate_image(
    module_id: &str,
    path: &Path,
    format: &str,
    data: &str,
) -> Result<(ImageFormat, Vec<u8>), AppError> {
    let (format, extension, prefix) = match format {
        "svg" => (ImageFormat::Svg, "svg", Some("data:image/svg+xml;base64,")),
        "png" => (ImageFormat::Png, "png", Some("data:image/png;base64,")),
        _ => {
            return Err(validation(
                module_id,
                "image export format must be svg or png",
            ))
        }
    };
    require_extension(module_id, path, extension)?;
    let bytes = decode_data_url(module_id, data, prefix)?;
    if bytes.len() > MAX_IMAGE_EXPORT_BYTES {
        return Err(validation(
            module_id,
            "image export must be 20 MiB or smaller",
        ));
    }
    match format {
        ImageFormat::Svg if !looks_like_svg(&bytes) => {
            return Err(validation(module_id, "SVG export is invalid"));
        }
        ImageFormat::Png if !bytes.starts_with(PNG_SIGNATURE) => {
            return Err(validation(module_id, "PNG export is invalid"));
        }
        _ => {}
    }
    Ok((format, bytes))
}

pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
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

fn require_extension(module_id: &str, path: &Path, expected: &str) -> Result<(), AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension.as_deref() == Some(expected) {
        Ok(())
    } else {
        Err(validation(
            module_id,
            format!("unsupported file extension for {}", path.display()),
        ))
    }
}

fn decode_data_url(module_id: &str, data: &str, prefix: Option<&str>) -> Result<Vec<u8>, AppError> {
    if let Some(encoded) = prefix.and_then(|prefix| data.strip_prefix(prefix)) {
        BASE64
            .decode(encoded)
            .map_err(|error| validation(module_id, format!("invalid export base64: {error}")))
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

fn validation(module_id: &str, reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: module_id.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_supported_image_formats() {
        let directory = tempfile::tempdir().unwrap();
        let svg = directory.path().join("sample.svg");
        let png = directory.path().join("sample.png");
        assert_eq!(
            decode_and_validate_image("test", &svg, "svg", "<svg/>")
                .unwrap()
                .0,
            ImageFormat::Svg
        );
        assert_eq!(
            decode_and_validate_image(
                "test",
                &png,
                "png",
                &format!(
                    "data:image/png;base64,{}",
                    BASE64.encode(b"\x89PNG\r\n\x1a\nfixture")
                ),
            )
            .unwrap()
            .0,
            ImageFormat::Png
        );
    }

    #[test]
    fn rejects_extension_signature_and_size_mismatches() {
        let directory = tempfile::tempdir().unwrap();
        assert!(decode_and_validate_image(
            "test",
            &directory.path().join("sample.txt"),
            "svg",
            "<svg/>"
        )
        .is_err());
        assert!(decode_and_validate_image(
            "test",
            &directory.path().join("sample.png"),
            "png",
            "not png"
        )
        .is_err());
        assert!(decode_and_validate_image(
            "test",
            &directory.path().join("sample.svg"),
            "svg",
            &format!("<svg>{}</svg>", "x".repeat(MAX_IMAGE_EXPORT_BYTES))
        )
        .is_err());
    }
}
