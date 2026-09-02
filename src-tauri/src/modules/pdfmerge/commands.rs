//! PDFファイルの事前検査と結合を行うTauri command。

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use lopdf::{dictionary, Document, LoadOptions, Object};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::modules::image_export::write_atomically_with_guard;
use crate::operations::OperationGuard;
use crate::state::AppState;

use super::progress::PdfMergeProgress;

pub const MAX_INPUT_FILES: usize = 50;
pub const MAX_TOTAL_INPUT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_DECOMPRESSED_STREAM_BYTES: usize = 64 * 1024 * 1024;
const READ_CHUNK_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PdfInputInfo {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub page_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PdfInspectIssue {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PdfInspectResult {
    pub accepted: Vec<PdfInputInfo>,
    pub rejected: Vec<PdfInspectIssue>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PdfMergeResult {
    pub output_path: String,
    pub total_pages: u32,
    pub output_bytes: u64,
    pub duration_ms: u64,
}

struct LoadedPdf {
    document: Document,
    size_bytes: u64,
}

#[tauri::command]
pub async fn pdfmerge_inspect_files(
    state: State<'_, AppState>,
    operation_id: String,
    paths: Vec<String>,
    on_progress: Channel<PdfMergeProgress>,
) -> Result<PdfInspectResult, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());
    let id_for_blocking = operation_id.clone();

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let mut progress = make_channel_sink(on_progress, id_for_blocking.clone());
        let result = inspect_files_inner(&paths, &token, &mut progress, &id_for_blocking);
        if matches!(result, Err(AppError::Cancelled { .. })) {
            progress(PdfMergeProgress::Cancelled);
        }
        result
    })
    .await;

    join_result.map_err(AppError::from)?
}

#[tauri::command]
pub async fn pdfmerge_merge_files(
    state: State<'_, AppState>,
    operation_id: String,
    input_paths: Vec<String>,
    output_path: String,
    on_progress: Channel<PdfMergeProgress>,
) -> Result<PdfMergeResult, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());
    let id_for_blocking = operation_id.clone();

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let mut progress = make_channel_sink(on_progress, id_for_blocking.clone());
        let result = merge_files_inner(
            &input_paths,
            Path::new(&output_path),
            &token,
            &mut progress,
            &id_for_blocking,
        );
        if matches!(result, Err(AppError::Cancelled { .. })) {
            progress(PdfMergeProgress::Cancelled);
        }
        result
    })
    .await;

    join_result.map_err(AppError::from)?
}

fn make_channel_sink(
    channel: Channel<PdfMergeProgress>,
    operation_id: String,
) -> impl FnMut(PdfMergeProgress) {
    move |event| {
        if let Err(error) = channel.send(event) {
            tracing::warn!(
                operation_id = %operation_id,
                error = %error,
                "pdfmerge progress channel send failed; continuing"
            );
        }
    }
}

fn inspect_files_inner(
    paths: &[String],
    token: &CancellationToken,
    progress: &mut dyn FnMut(PdfMergeProgress),
    operation_id: &str,
) -> Result<PdfInspectResult, AppError> {
    let started = Instant::now();
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    let mut accepted_bytes = 0_u64;
    let total_files = paths.len().min(u32::MAX as usize) as u32;

    for (index, path) in paths.iter().enumerate() {
        ensure_not_cancelled(token, operation_id)?;
        let file_name = display_file_name(Path::new(path));
        if index >= MAX_INPUT_FILES {
            rejected.push(PdfInspectIssue {
                path: path.clone(),
                reason: format!("PDFは最大{MAX_INPUT_FILES}ファイルまでです。"),
            });
        } else {
            match inspect_one(Path::new(path), token, operation_id) {
                Ok(info) => {
                    if accepted_bytes.saturating_add(info.size_bytes) > MAX_TOTAL_INPUT_BYTES {
                        rejected.push(PdfInspectIssue {
                            path: path.clone(),
                            reason: "入力PDFの合計は200 MiB以下にしてください。".into(),
                        });
                    } else {
                        accepted_bytes += info.size_bytes;
                        accepted.push(info);
                    }
                }
                Err(error @ AppError::Cancelled { .. }) => return Err(error),
                Err(error) => rejected.push(PdfInspectIssue {
                    path: path.clone(),
                    reason: rejection_reason(error),
                }),
            }
        }
        progress(PdfMergeProgress::Reading {
            completed_files: (index + 1).min(u32::MAX as usize) as u32,
            total_files,
            file_name,
        });
    }

    ensure_not_cancelled(token, operation_id)?;
    progress(PdfMergeProgress::Done {
        duration_ms: elapsed_ms(started),
    });
    Ok(PdfInspectResult { accepted, rejected })
}

fn inspect_one(
    path: &Path,
    token: &CancellationToken,
    operation_id: &str,
) -> Result<PdfInputInfo, AppError> {
    require_pdf_extension(path)?;
    let metadata = input_metadata(path)?;
    if metadata.len() > MAX_TOTAL_INPUT_BYTES {
        return Err(validation("1ファイルのサイズが200 MiBを超えています。"));
    }
    let loaded = load_pdf(path, token, operation_id)?;
    let page_count = validate_supported_document(&loaded.document)?;
    Ok(PdfInputInfo {
        path: path.display().to_string(),
        file_name: display_file_name(path),
        size_bytes: loaded.size_bytes,
        page_count,
    })
}

fn merge_files_inner(
    input_paths: &[String],
    output_path: &Path,
    token: &CancellationToken,
    progress: &mut dyn FnMut(PdfMergeProgress),
    operation_id: &str,
) -> Result<PdfMergeResult, AppError> {
    let started = Instant::now();
    validate_merge_paths(input_paths, output_path)?;
    ensure_not_cancelled(token, operation_id)?;

    let mut output = Document::with_version("1.5");
    let pages_root_id = output.new_object_id();
    let catalog_id = output.new_object_id();
    let mut next_object_id = output.max_id + 1;
    let mut page_tree_roots = Vec::with_capacity(input_paths.len());
    let mut total_pages = 0_u32;
    let mut actual_total_bytes = 0_u64;
    let total_files = input_paths.len().min(u32::MAX as usize) as u32;

    for (index, input_path) in input_paths.iter().enumerate() {
        ensure_not_cancelled(token, operation_id)?;
        let path = Path::new(input_path);
        let file_name = display_file_name(path);
        let loaded = load_pdf(path, token, operation_id)?;
        actual_total_bytes = actual_total_bytes
            .checked_add(loaded.size_bytes)
            .ok_or_else(|| validation("入力PDFの合計サイズが大きすぎます。"))?;
        if actual_total_bytes > MAX_TOTAL_INPUT_BYTES {
            return Err(validation("入力PDFの合計は200 MiB以下にしてください。"));
        }
        let mut document = loaded.document;
        let page_count = validate_supported_document(&document)?;
        total_pages = total_pages
            .checked_add(page_count)
            .ok_or_else(|| validation("総ページ数が処理可能範囲を超えています。"))?;
        output.version = max_pdf_version(&output.version, &document.version);

        progress(PdfMergeProgress::Reading {
            completed_files: (index + 1).min(u32::MAX as usize) as u32,
            total_files,
            file_name,
        });

        document.renumber_objects_with(next_object_id);
        next_object_id = document.max_id.saturating_add(1);
        let source_catalog_id = document
            .trailer
            .get(b"Root")
            .and_then(Object::as_reference)
            .map_err(|error| invalid_pdf(error.to_string()))?;
        let source_pages_id = document
            .catalog()
            .and_then(|catalog| catalog.get(b"Pages"))
            .and_then(Object::as_reference)
            .map_err(|error| invalid_pdf(error.to_string()))?;
        document
            .get_dictionary_mut(source_pages_id)
            .map_err(|error| invalid_pdf(error.to_string()))?
            .set("Parent", pages_root_id);

        page_tree_roots.push(Object::Reference(source_pages_id));
        output.objects.extend(
            document
                .objects
                .into_iter()
                .filter(|(object_id, _)| *object_id != source_catalog_id),
        );
        progress(PdfMergeProgress::Merging {
            completed_files: (index + 1).min(u32::MAX as usize) as u32,
            total_files,
            pages_processed: total_pages,
        });
    }

    output.objects.insert(
        pages_root_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_tree_roots,
            "Count" => i64::from(total_pages),
        }),
    );
    output.objects.insert(
        catalog_id,
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_root_id,
        }),
    );
    output.trailer.set("Root", catalog_id);
    output.prune_objects();
    output.max_id = output
        .objects
        .keys()
        .map(|(id, _)| *id)
        .max()
        .unwrap_or(catalog_id.0);

    ensure_not_cancelled(token, operation_id)?;
    progress(PdfMergeProgress::Writing { total_pages });
    write_atomically_with_guard(
        output_path,
        |file| {
            output
                .save_to(file)
                .map_err(|error| AppError::Io(format!("PDFを書き込めません: {error}")))?;
            Ok(())
        },
        || ensure_not_cancelled(token, operation_id),
    )?;

    let output_bytes = fs::metadata(output_path)?.len();
    let duration_ms = elapsed_ms(started);
    progress(PdfMergeProgress::Done { duration_ms });
    Ok(PdfMergeResult {
        output_path: output_path.display().to_string(),
        total_pages,
        output_bytes,
        duration_ms,
    })
}

fn validate_merge_paths(input_paths: &[String], output_path: &Path) -> Result<(), AppError> {
    if input_paths.len() < 2 {
        return Err(validation("2ファイル以上のPDFを指定してください。"));
    }
    if input_paths.len() > MAX_INPUT_FILES {
        return Err(validation(format!(
            "PDFは最大{MAX_INPUT_FILES}ファイルまでです。"
        )));
    }
    require_pdf_extension(output_path)?;
    let output_parent = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| validation("出力先フォルダを確認してください。"))?;
    if !output_parent.is_dir() {
        return Err(validation("出力先フォルダが存在しません。"));
    }

    let canonical_output = if output_path.exists() {
        fs::canonicalize(output_path)?
    } else {
        let name = output_path
            .file_name()
            .ok_or_else(|| validation("出力ファイル名を確認してください。"))?;
        fs::canonicalize(output_parent)?.join(name)
    };

    let mut total_bytes = 0_u64;
    for input_path in input_paths {
        let path = Path::new(input_path);
        require_pdf_extension(path)?;
        let metadata = input_metadata(path)?;
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| validation("入力PDFの合計サイズが大きすぎます。"))?;
        if total_bytes > MAX_TOTAL_INPUT_BYTES {
            return Err(validation("入力PDFの合計は200 MiB以下にしてください。"));
        }
        if fs::canonicalize(path)? == canonical_output {
            return Err(validation(
                "入力PDFと同じファイルを出力先には指定できません。",
            ));
        }
    }
    Ok(())
}

fn load_pdf(
    path: &Path,
    token: &CancellationToken,
    operation_id: &str,
) -> Result<LoadedPdf, AppError> {
    let bytes = read_file_cancellable(path, token, operation_id)?;
    let size_bytes = u64::try_from(bytes.len())
        .map_err(|_| validation("PDFファイルのサイズが処理可能範囲を超えています。"))?;
    ensure_not_cancelled(token, operation_id)?;
    let options = LoadOptions::with_max_decompressed_size(MAX_DECOMPRESSED_STREAM_BYTES);
    let document = Document::load_mem_with_options(&bytes, options).map_err(map_lopdf_error)?;
    ensure_not_cancelled(token, operation_id)?;
    Ok(LoadedPdf {
        document,
        size_bytes,
    })
}

fn read_file_cancellable(
    path: &Path,
    token: &CancellationToken,
    operation_id: &str,
) -> Result<Vec<u8>, AppError> {
    let file = File::open(path)
        .map_err(|error| AppError::Io(format!("{} を開けません: {error}", path.display())))?;
    let length = file.metadata()?.len();
    if length > MAX_TOTAL_INPUT_BYTES {
        return Err(validation("1ファイルのサイズが200 MiBを超えています。"));
    }
    let capacity = usize::try_from(length).unwrap_or(MAX_TOTAL_INPUT_BYTES as usize);
    let mut reader = BufReader::with_capacity(READ_CHUNK_SIZE, file);
    let mut bytes = Vec::with_capacity(capacity);
    let mut chunk = vec![0_u8; READ_CHUNK_SIZE];
    loop {
        ensure_not_cancelled(token, operation_id)?;
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > MAX_TOTAL_INPUT_BYTES as usize {
            return Err(validation("1ファイルのサイズが200 MiBを超えています。"));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok(bytes)
}

fn validate_supported_document(document: &Document) -> Result<u32, AppError> {
    if document.is_encrypted() || document.was_encrypted() {
        return Err(validation("暗号化されたPDFには対応していません。"));
    }
    let catalog = document
        .catalog()
        .map_err(|error| invalid_pdf(error.to_string()))?;
    for (key, reason) in [
        (
            b"AcroForm".as_slice(),
            "フォームを含むPDFには対応していません。",
        ),
        (
            b"Outlines".as_slice(),
            "しおりを含むPDFには対応していません。",
        ),
        (
            b"Collection".as_slice(),
            "PDFポートフォリオには対応していません。",
        ),
        (
            b"AF".as_slice(),
            "添付ファイルを含むPDFには対応していません。",
        ),
        (
            b"Perms".as_slice(),
            "電子署名を含むPDFには対応していません。",
        ),
    ] {
        if catalog.has(key) {
            return Err(validation(reason));
        }
    }
    if catalog
        .get(b"Names")
        .ok()
        .and_then(|object| document.dereference(object).ok())
        .and_then(|(_, object)| object.as_dict().ok())
        .is_some_and(|names| names.has(b"EmbeddedFiles"))
    {
        return Err(validation("添付ファイルを含むPDFには対応していません。"));
    }
    for object in document.objects.values() {
        let dictionary = match object {
            Object::Dictionary(dictionary) => Some(dictionary),
            Object::Stream(stream) => Some(&stream.dict),
            _ => None,
        };
        if let Some(dictionary) = dictionary {
            if dictionary.has(b"AF")
                || dictionary.has_type(b"EmbeddedFile")
                || dictionary
                    .get(b"Subtype")
                    .and_then(Object::as_name)
                    .is_ok_and(|name| name == b"FileAttachment")
            {
                return Err(validation("添付ファイルを含むPDFには対応していません。"));
            }
            if dictionary
                .get(b"FT")
                .and_then(Object::as_name)
                .is_ok_and(|name| name == b"Sig")
                || dictionary.has_type(b"Sig")
            {
                return Err(validation("電子署名を含むPDFには対応していません。"));
            }
            if dictionary
                .get(b"Subtype")
                .and_then(Object::as_name)
                .is_ok_and(|name| name == b"Widget")
            {
                return Err(validation("フォームを含むPDFには対応していません。"));
            }
        }
    }

    let page_count = document.get_pages().len();
    if page_count == 0 {
        return Err(validation("ページを含まないPDFは結合できません。"));
    }
    u32::try_from(page_count).map_err(|_| validation("ページ数が処理可能範囲を超えています。"))
}

fn require_pdf_extension(path: &Path) -> Result<(), AppError> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        Ok(())
    } else {
        Err(validation("拡張子が.pdfのファイルを指定してください。"))
    }
}

fn input_metadata(path: &Path) -> Result<fs::Metadata, AppError> {
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::Io(format!("{} を確認できません: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(validation("PDFファイルを指定してください。"));
    }
    Ok(metadata)
}

fn ensure_not_cancelled(token: &CancellationToken, operation_id: &str) -> Result<(), AppError> {
    if token.is_cancelled() {
        Err(AppError::Cancelled {
            operation_id: operation_id.to_string(),
        })
    } else {
        Ok(())
    }
}

fn map_lopdf_error(error: lopdf::Error) -> AppError {
    match error {
        lopdf::Error::AlreadyEncrypted
        | lopdf::Error::InvalidPassword
        | lopdf::Error::Decryption(_) => validation("暗号化されたPDFには対応していません。"),
        lopdf::Error::Decompress(_) => {
            validation("PDF内の圧縮データが安全な展開サイズ上限（64 MiB）を超えています。")
        }
        other => invalid_pdf(other.to_string()),
    }
}

fn invalid_pdf(detail: impl Into<String>) -> AppError {
    validation(format!("PDFとして解析できません: {}", detail.into()))
}

fn validation(reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: "pdfmerge".into(),
        reason: reason.into(),
    }
}

fn rejection_reason(error: AppError) -> String {
    match error {
        AppError::Validation { reason, .. } => reason,
        AppError::Io(reason) => reason,
        other => other.to_string(),
    }
}

fn display_file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn max_pdf_version(left: &str, right: &str) -> String {
    if pdf_version_key(right) > pdf_version_key(left) {
        right.to_string()
    } else {
        left.to_string()
    }
}

fn pdf_version_key(version: &str) -> (u32, u32) {
    let mut parts = version.split('.');
    let major = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let minor = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    (major, minor)
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sample_document(widths: &[i64]) -> Document {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let mut kids = Vec::new();
        for width in widths {
            let content_id = document.add_object(lopdf::Stream::new(dictionary! {}, Vec::new()));
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "MediaBox" => vec![0.into(), 0.into(), (*width).into(), 842.into()],
                "Resources" => dictionary! {},
            });
            kids.push(Object::Reference(page_id));
        }
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => widths.len() as i64,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    fn save_document(directory: &Path, name: &str, mut document: Document) -> std::path::PathBuf {
        let path = directory.join(name);
        document.save(&path).unwrap();
        path
    }

    fn page_widths(document: &Document) -> Vec<i64> {
        document
            .get_pages()
            .values()
            .map(|page_id| {
                document
                    .get_dictionary(*page_id)
                    .unwrap()
                    .get(b"MediaBox")
                    .unwrap()
                    .as_array()
                    .unwrap()[2]
                    .as_i64()
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn inspects_valid_files_and_rejects_invalid_files_individually() {
        let directory = tempfile::tempdir().unwrap();
        let valid = save_document(directory.path(), "valid.pdf", sample_document(&[500, 600]));
        let invalid = directory.path().join("invalid.pdf");
        File::create(&invalid)
            .unwrap()
            .write_all(b"not pdf")
            .unwrap();
        let paths = vec![valid.display().to_string(), invalid.display().to_string()];
        let token = CancellationToken::new();
        let mut events = Vec::new();

        let result =
            inspect_files_inner(&paths, &token, &mut |event| events.push(event), "inspect")
                .unwrap();

        assert_eq!(result.accepted.len(), 1);
        assert_eq!(result.accepted[0].page_count, 2);
        assert_eq!(result.rejected.len(), 1);
        assert!(result.rejected[0].reason.contains("解析できません"));
        assert!(matches!(events.last(), Some(PdfMergeProgress::Done { .. })));
    }

    #[test]
    fn merges_page_trees_in_input_order_and_allows_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        let first = save_document(directory.path(), "first.pdf", sample_document(&[400, 410]));
        let second = save_document(directory.path(), "second.pdf", sample_document(&[700]));
        let output = directory.path().join("merged.pdf");
        let paths = vec![
            first.display().to_string(),
            second.display().to_string(),
            first.display().to_string(),
        ];
        let token = CancellationToken::new();
        let mut events = Vec::new();

        let result = merge_files_inner(
            &paths,
            &output,
            &token,
            &mut |event| events.push(event),
            "merge",
        )
        .unwrap();

        assert_eq!(result.total_pages, 5);
        let merged = Document::load(&output).unwrap();
        assert_eq!(page_widths(&merged), vec![400, 410, 700, 400, 410]);
        assert!(matches!(events.last(), Some(PdfMergeProgress::Done { .. })));
    }

    #[test]
    fn merges_ten_files_in_the_selected_order() {
        let directory = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for index in 0..10 {
            let path = save_document(
                directory.path(),
                &format!("input-{index}.pdf"),
                sample_document(&[500 + index]),
            );
            paths.push(path.display().to_string());
        }
        let output = directory.path().join("merged-ten.pdf");

        let result = merge_files_inner(
            &paths,
            &output,
            &CancellationToken::new(),
            &mut |_| {},
            "merge-ten",
        )
        .unwrap();

        assert_eq!(result.total_pages, 10);
        let merged = Document::load(&output).unwrap();
        assert_eq!(page_widths(&merged), (500..510).collect::<Vec<_>>());
    }

    #[test]
    fn rejects_unsupported_catalog_features() {
        for (key, expected) in [
            ("AcroForm", "フォーム"),
            ("Outlines", "しおり"),
            ("Collection", "ポートフォリオ"),
            ("AF", "添付"),
            ("Perms", "電子署名"),
        ] {
            let mut document = sample_document(&[500]);
            document.catalog_mut().unwrap().set(key, dictionary! {});
            let error = validate_supported_document(&document).unwrap_err();
            assert!(rejection_reason(error).contains(expected));
        }
    }

    #[test]
    fn rejects_widget_annotations_and_zero_page_documents() {
        let mut widget = sample_document(&[500]);
        widget.add_object(dictionary! { "Type" => "Annot", "Subtype" => "Widget" });
        assert!(
            rejection_reason(validate_supported_document(&widget).unwrap_err())
                .contains("フォーム")
        );

        let empty = sample_document(&[]);
        assert!(
            rejection_reason(validate_supported_document(&empty).unwrap_err()).contains("ページ")
        );
    }

    #[test]
    fn rejects_encryption_and_embedded_file_name_trees() {
        let mut encrypted = sample_document(&[500]);
        let encryption_id = encrypted.add_object(dictionary! {});
        encrypted.trailer.set("Encrypt", encryption_id);
        assert!(
            rejection_reason(validate_supported_document(&encrypted).unwrap_err())
                .contains("暗号化")
        );

        let mut attached = sample_document(&[500]);
        attached
            .catalog_mut()
            .unwrap()
            .set("Names", dictionary! { "EmbeddedFiles" => dictionary! {} });
        assert!(
            rejection_reason(validate_supported_document(&attached).unwrap_err()).contains("添付")
        );

        for object in [
            dictionary! { "Type" => "EmbeddedFile" },
            dictionary! { "Type" => "Annot", "Subtype" => "FileAttachment" },
            dictionary! { "AF" => Vec::<Object>::new() },
        ] {
            let mut attached = sample_document(&[500]);
            attached.add_object(object);
            assert!(
                rejection_reason(validate_supported_document(&attached).unwrap_err())
                    .contains("添付")
            );
        }
    }

    #[test]
    fn enforces_file_count_and_total_size_limits() {
        let too_many = vec!["input.pdf".to_string(); MAX_INPUT_FILES + 1];
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("merged.pdf");
        assert!(
            rejection_reason(validate_merge_paths(&too_many, &output).unwrap_err())
                .contains("最大50")
        );

        let huge = directory.path().join("huge.pdf");
        File::create(&huge)
            .unwrap()
            .set_len(MAX_TOTAL_INPUT_BYTES + 1)
            .unwrap();
        let small = save_document(directory.path(), "small.pdf", sample_document(&[500]));
        let error = validate_merge_paths(
            &[huge.display().to_string(), small.display().to_string()],
            &output,
        )
        .unwrap_err();
        assert!(rejection_reason(error).contains("200 MiB"));
    }

    #[test]
    fn cancellation_keeps_existing_output_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let first = save_document(directory.path(), "first.pdf", sample_document(&[400]));
        let second = save_document(directory.path(), "second.pdf", sample_document(&[500]));
        let output = directory.path().join("merged.pdf");
        fs::write(&output, b"existing").unwrap();
        let token = CancellationToken::new();
        token.cancel();

        let error = merge_files_inner(
            &[first.display().to_string(), second.display().to_string()],
            &output,
            &token,
            &mut |_| {},
            "cancelled",
        )
        .unwrap_err();

        assert!(matches!(error, AppError::Cancelled { .. }));
        assert_eq!(fs::read(&output).unwrap(), b"existing");
    }

    #[test]
    fn cancellation_between_input_merges_keeps_existing_output_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let first = save_document(directory.path(), "first.pdf", sample_document(&[400]));
        let second = save_document(directory.path(), "second.pdf", sample_document(&[500]));
        let output = directory.path().join("merged.pdf");
        fs::write(&output, b"existing").unwrap();
        let token = CancellationToken::new();
        let token_from_progress = token.clone();

        let error = merge_files_inner(
            &[first.display().to_string(), second.display().to_string()],
            &output,
            &token,
            &mut |event| {
                if matches!(
                    event,
                    PdfMergeProgress::Merging {
                        completed_files: 1,
                        ..
                    }
                ) {
                    token_from_progress.cancel();
                }
            },
            "cancel-between-files",
        )
        .unwrap_err();

        assert!(matches!(error, AppError::Cancelled { .. }));
        assert_eq!(fs::read(&output).unwrap(), b"existing");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
    }

    #[test]
    fn cancellation_before_replace_removes_temp_and_keeps_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let first = save_document(directory.path(), "first.pdf", sample_document(&[400]));
        let second = save_document(directory.path(), "second.pdf", sample_document(&[500]));
        let output = directory.path().join("merged.pdf");
        fs::write(&output, b"existing").unwrap();
        let token = CancellationToken::new();
        let token_from_progress = token.clone();

        let error = merge_files_inner(
            &[first.display().to_string(), second.display().to_string()],
            &output,
            &token,
            &mut |event| {
                if matches!(event, PdfMergeProgress::Writing { .. }) {
                    token_from_progress.cancel();
                }
            },
            "cancel-before-replace",
        )
        .unwrap_err();

        assert!(matches!(error, AppError::Cancelled { .. }));
        assert_eq!(fs::read(&output).unwrap(), b"existing");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
    }

    #[test]
    fn missing_or_invalid_input_is_revalidated_without_touching_output() {
        let directory = tempfile::tempdir().unwrap();
        let valid = save_document(directory.path(), "valid.pdf", sample_document(&[400]));
        let missing = directory.path().join("missing.pdf");
        let invalid = directory.path().join("invalid.pdf");
        fs::write(&invalid, b"not a pdf").unwrap();
        let output = directory.path().join("merged.pdf");
        fs::write(&output, b"existing").unwrap();

        for second in [missing, invalid] {
            let error = merge_files_inner(
                &[valid.display().to_string(), second.display().to_string()],
                &output,
                &CancellationToken::new(),
                &mut |_| {},
                "revalidate",
            )
            .unwrap_err();
            assert!(matches!(
                error,
                AppError::Io(_) | AppError::Validation { .. }
            ));
            assert_eq!(fs::read(&output).unwrap(), b"existing");
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3);
    }

    #[test]
    fn rejects_output_that_is_also_an_input() {
        let directory = tempfile::tempdir().unwrap();
        let first = save_document(directory.path(), "first.pdf", sample_document(&[400]));
        let second = save_document(directory.path(), "second.pdf", sample_document(&[500]));
        let error = validate_merge_paths(
            &[first.display().to_string(), second.display().to_string()],
            &first,
        )
        .unwrap_err();
        assert!(rejection_reason(error).contains("同じファイル"));
    }

    #[test]
    fn chooses_the_highest_pdf_version() {
        assert_eq!(max_pdf_version("1.5", "1.7"), "1.7");
        assert_eq!(max_pdf_version("2.0", "1.7"), "2.0");
    }
}
