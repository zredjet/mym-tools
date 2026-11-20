//! Mermaid / Diagramの画像書出しとPDF結合が共有する原子的ローカル保存境界。

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
    // base64 は 4 文字で 3 バイト。デコード後の上限を超える入力は、デコード (メモリ確保) 前に拒否する
    if data.len() > MAX_IMAGE_EXPORT_BYTES.div_ceil(3) * 4 + 64 {
        return Err(validation(
            module_id,
            "image export must be 20 MiB or smaller",
        ));
    }
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
    write_atomically_with(path, |file| {
        file.write_all(bytes)?;
        Ok(())
    })
}

/// 同一ディレクトリの一時ファイルへ書き込み、成功したときだけ出力先を置換する。
///
/// PDF のように出力全体を `Vec<u8>` へ保持したくないモジュールも、同じ原子的保存境界を
/// 利用できるよう writer closure を受け取る。closure がエラーを返した場合は一時ファイルを
/// 削除し、既存の出力先には触れない。
pub(crate) fn write_atomically_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), AppError>,
) -> Result<(), AppError> {
    write_atomically_with_guard(path, write, || Ok(()))
}

/// flush / fsync 後、出力先を置換する直前に最終確認を挟める原子的保存。
pub(crate) fn write_atomically_with_guard(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), AppError>,
    before_replace: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
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

    let temp_path = temporary_path(parent);
    let result = (|| -> Result<(), AppError> {
        let mut file = File::create(&temp_path)?;
        write(&mut file)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        before_replace()?;
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

/// UTF-8 で、ルート要素 `<svg` の前 (prolog) に XML 宣言・コメント・空白・
/// `<!DOCTYPE svg …>` だけがあるかを確かめる。
///
/// draw.io のメニュー (ファイル > 形式を指定してエクスポート > SVG) は、XML 宣言、
/// (編集可能な SVG なら) `<!-- Do not edit … -->`、SVG 1.1 の DOCTYPE をこの順に
/// 付けて送ってくる。XML 宣言は先頭に 1 回、DOCTYPE は 1 回だけ認める。DOCTYPE の
/// 名前は `svg` に限り、内部サブセット (`[…]`。実体宣言を書ける) は認めない。
/// ほかの処理命令 (`<?xml-stylesheet …?>` など) や `<!ENTITY …>` も認めない。
fn looks_like_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut rest = text.trim_start();
    if let Some(declaration) = rest.strip_prefix("<?xml") {
        let Some(declaration) = after_required_space(declaration) else {
            return false;
        };
        let Some(end) = declaration.find("?>") else {
            return false;
        };
        rest = &declaration[end + 2..];
    }
    let mut seen_doctype = false;
    loop {
        rest = rest.trim_start();
        if let Some(comment) = rest.strip_prefix("<!--") {
            let Some(end) = comment.find("-->") else {
                return false;
            };
            rest = &comment[end + 3..];
        } else if !seen_doctype && rest.starts_with("<!DOCTYPE") {
            let Some(after) = skip_svg_doctype(rest) else {
                return false;
            };
            rest = after;
            seen_doctype = true;
        } else {
            return rest.starts_with("<svg");
        }
    }
}

/// `<!DOCTYPE svg>`、`<!DOCTYPE svg PUBLIC "…" "…">`、`<!DOCTYPE svg SYSTEM "…">` を
/// 読み飛ばし、`>` の後ろを返す。それ以外 (別の名前・内部サブセット) は `None`。
fn skip_svg_doctype(text: &str) -> Option<&str> {
    let mut rest = after_required_space(text.strip_prefix("<!DOCTYPE")?)?.strip_prefix("svg")?;
    if let Some(spaced) = after_required_space(rest) {
        rest = if let Some(public) = spaced.strip_prefix("PUBLIC") {
            let public_id = after_quoted_literal(after_required_space(public)?)?;
            after_quoted_literal(after_required_space(public_id)?)?
        } else if let Some(system) = spaced.strip_prefix("SYSTEM") {
            after_quoted_literal(after_required_space(system)?)?
        } else {
            spaced
        };
    }
    rest.trim_start().strip_prefix('>')
}

/// 先頭に 1 文字以上の空白があれば、空白を除いた残りを返す。
fn after_required_space(text: &str) -> Option<&str> {
    let trimmed = text.trim_start();
    (trimmed.len() < text.len()).then_some(trimmed)
}

/// 先頭の `"…"` か `'…'` を読み飛ばし、閉じ引用符の後ろを返す。
fn after_quoted_literal(text: &str) -> Option<&str> {
    let quote = text
        .chars()
        .next()
        .filter(|first| matches!(first, '"' | '\''))?;
    let body = &text[1..];
    body.find(quote).map(|end| &body[end + 1..])
}

/// 出力先と同じディレクトリの一時ファイル名。元のファイル名に付け足すと長い名前で
/// ファイル名上限 (255 バイト) を超えるため、長さ固定 (41 文字) の名前にする。
fn temporary_path(parent: &Path) -> PathBuf {
    parent.join(format!(".mym-{}.tmp", uuid::Uuid::new_v4().simple()))
}

#[cfg(not(windows))]
fn replace_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    // rename は一時ファイルの属性で置き換えるため、既存ファイルのパーミッションを引き継ぐ
    // (Windows の ReplaceFileW は置換先の属性を保持する)
    if let Ok(existing) = fs::metadata(destination) {
        fs::set_permissions(source, existing.permissions())?;
    }
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

    // draw.io (Graph.xmlDeclaration / Graph.svgFileComment / Graph.svgDoctype) と同じ文字列
    const DRAWIO_XML_DECLARATION: &str = r#"<?xml version="1.0" encoding="UTF-8"?>"#;
    const DRAWIO_FILE_COMMENT: &str =
        "<!-- Do not edit this file with editors other than draw.io -->";
    const DRAWIO_SVG_DOCTYPE: &str = r#"<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">"#;
    const SVG_ROOT: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="10px" height="10px" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>"#;

    #[test]
    fn accepts_drawio_menu_svg_export_prolog() {
        // ファイル > 形式を指定してエクスポート > SVG で EditorUi.exportSvg が組み立てる先頭。
        // 編集可能な SVG ではコメントが入る
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("diagram.svg");
        let plain = format!("{DRAWIO_XML_DECLARATION}\n{DRAWIO_SVG_DOCTYPE}\n{SVG_ROOT}");
        let editable = format!(
            "{DRAWIO_XML_DECLARATION}\n{DRAWIO_FILE_COMMENT}\n{DRAWIO_SVG_DOCTYPE}\n{SVG_ROOT}"
        );
        for svg in [plain, editable] {
            let (format, bytes) = decode_and_validate_image("diagram", &path, "svg", &svg).unwrap();
            assert_eq!(format, ImageFormat::Svg);
            assert_eq!(bytes, svg.as_bytes(), "the export is saved unchanged");

            let data_url = format!("data:image/svg+xml;base64,{}", BASE64.encode(&svg));
            let (_, bytes) = decode_and_validate_image("diagram", &path, "svg", &data_url).unwrap();
            assert_eq!(bytes, svg.as_bytes());
        }
    }

    #[test]
    fn accepts_svg_prologs_with_comments_whitespace_and_svg_doctype() {
        for svg in [
            "<svg/>",
            " \r\n\t<svg/>",
            r#"<?xml version="1.0"?><svg/>"#,
            "<?xml version=\"1.0\"?>\n<!-- a -->\n<!-- b --><svg/>",
            "<!DOCTYPE svg><svg/>",
            "<!DOCTYPE svg ><!-- after --><svg/>",
            "<!DOCTYPE svg SYSTEM 'svg11.dtd'><svg/>",
            // 引用符の中の `[` と `>` は内部サブセットや DOCTYPE の終わりではない
            r#"<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "a[b]>c"><svg/>"#,
        ] {
            assert!(looks_like_svg(svg.as_bytes()), "{svg}");
        }
    }

    #[test]
    fn rejects_other_doctypes_internal_subsets_and_entities() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("diagram.svg");
        for svg in [
            "",
            "<html/>",
            "<!DOCTYPE html><svg/>",
            "<!DOCTYPE html>\n<html><body><svg/></body></html>",
            "<!doctype svg><svg/>",
            "<!DOCTYPE svgx><svg/>",
            "<!DOCTYPEsvg><svg/>",
            "<!DOCTYPE svg [<!ENTITY a \"b\">]><svg>&a;</svg>",
            &format!(
                "{DRAWIO_XML_DECLARATION}\n{}\n{SVG_ROOT}",
                DRAWIO_SVG_DOCTYPE.replace('>', " [<!ENTITY a \"b\">]>")
            ),
            r#"<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg/>"#,
            r#"<!DOCTYPE svg SYSTEM "unterminated><svg/>"#,
            "<!DOCTYPE svg><!DOCTYPE svg><svg/>",
            "<!ENTITY a \"b\"><svg/>",
            &format!("{DRAWIO_XML_DECLARATION}\n<!ENTITY a \"b\">\n{SVG_ROOT}"),
            r#"<?xml-stylesheet href="https://example.com/a.css"?><svg/>"#,
            r#"<?xml version="1.0"?><?xml-stylesheet href="a.css"?><svg/>"#,
            r#"<?xml version="1.0"?><?xml version="1.0"?><svg/>"#,
            r#"<!DOCTYPE svg><?xml version="1.0"?><svg/>"#,
            "<!-- before --><?xml version=\"1.0\"?><svg/>",
            r#"<?xml version="1.0"<svg/>"#,
            "<!-- unterminated <svg/>",
        ] {
            assert!(!looks_like_svg(svg.as_bytes()), "{svg}");
            assert!(
                matches!(
                    decode_and_validate_image("diagram", &path, "svg", svg),
                    Err(AppError::Validation { reason, .. }) if reason == "SVG export is invalid"
                ),
                "{svg}"
            );
        }

        // UTF-8 として読めないバイト列 (Latin-1 の é)
        let mut latin1 = format!("{DRAWIO_XML_DECLARATION}\n{DRAWIO_SVG_DOCTYPE}\n").into_bytes();
        latin1.extend_from_slice(b"<svg><text>\xe9</text></svg>");
        assert!(!looks_like_svg(&latin1));
    }

    #[test]
    fn guarded_write_keeps_existing_destination_when_guard_fails() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("existing.bin");
        fs::write(&path, b"old").unwrap();

        let result = write_atomically_with_guard(
            &path,
            |file| {
                file.write_all(b"new")?;
                Ok(())
            },
            || Err(AppError::Internal("stop before replace".into())),
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_write_supports_long_file_names() {
        let dir = tempfile::tempdir().unwrap();
        // 250 バイトの名前 (元の名前に付け足す方式だと一時ファイル名が 255 バイトを超えていた)
        let name = format!("{}.png", "a".repeat(246));
        let path = dir.path().join(&name);
        write_atomically(&path, b"data").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"data");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keep.svg");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        write_atomically(&path, b"new").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn rejects_oversized_export_before_decoding() {
        // デコードすると 20 MiB を超える base64 (中身は不正でもよい: デコード前に弾く)
        let oversized = format!(
            "data:image/png;base64,{}",
            "!".repeat(MAX_IMAGE_EXPORT_BYTES.div_ceil(3) * 4 + 128)
        );
        let error =
            decode_and_validate_image("mermaid", Path::new("/tmp/a.png"), "png", &oversized)
                .unwrap_err();
        assert!(
            matches!(&error, AppError::Validation { reason, .. } if reason.contains("20 MiB")),
            "{error:?}"
        );
    }
}
