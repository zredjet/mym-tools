//! M-文字コード変換の Tauri command (ADR-0024)。
//!
//! ファイルの path だけを受け取り、中身は IPC に流さない。判定・プレビュー・変換はすべて Rust で
//! 行い、変換結果は別名で保存する (元のファイルには書かない)。

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::modules::image_export::write_atomically_with_guard;
use crate::modules::text_encoding::{
    self, ByteIssue, Ctx, Detection, SourceEncoding, StreamDecoder, TextEncoding,
};
use crate::operations::OperationGuard;
use crate::state::AppState;

use super::convert::{
    self, CharIssue, ConvertOptions, ConvertWarning, NewlineMode, NewlineStats, NewlineTransform,
    TargetEncoding,
};

const MODULE_ID: &str = "encoding";
/// 1 ファイルの上限 (ADR-0024)。
pub const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const PREVIEW_CHARS: usize = 2_000;
const PREVIEW_SOURCE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EncodingInspection {
    pub size: u64,
    pub bom: Option<TextEncoding>,
    /// 自動判定したときだけ Some
    pub detection: Option<Detection>,
    /// 読み取りに使った文字コード。自動判定できなければ None
    pub encoding: Option<TextEncoding>,
    pub ascii_only: bool,
    pub malformed_count: u64,
    pub malformed: Vec<ByteIssue>,
    pub newlines: NewlineStats,
    pub line_count: u64,
    pub char_count: u64,
    /// 私用領域の文字 (外字) の数
    pub private_use_count: u64,
    /// 先頭 2,000 文字。読めないバイトは U+FFFD で表示する
    pub preview: String,
    pub preview_truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvertStatus {
    Written,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EncodingConvertResult {
    pub status: ConvertStatus,
    pub source: TextEncoding,
    pub bytes_written: u64,
    pub malformed_count: u64,
    pub malformed: Vec<ByteIssue>,
    pub unmappable_count: u64,
    pub unmappable: Vec<CharIssue>,
    pub normalized_count: u64,
    pub warnings: Vec<ConvertWarning>,
    pub newlines: NewlineStats,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn encoding_inspect_file(
    state: State<'_, AppState>,
    operation_id: String,
    path: String,
    source: SourceEncoding,
) -> Result<EncodingInspection, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let ctx = Ctx {
            module_id: MODULE_ID,
            token: &token,
            operation_id: &operation_id,
        };
        inspect_inner(Path::new(&path), source, &ctx)
    })
    .await;
    join_result.map_err(AppError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn encoding_convert_file(
    state: State<'_, AppState>,
    operation_id: String,
    input_path: String,
    output_path: String,
    source: SourceEncoding,
    target: TargetEncoding,
    newline: NewlineMode,
    normalize_mac_symbols: bool,
) -> Result<EncodingConvertResult, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let ctx = Ctx {
            module_id: MODULE_ID,
            token: &token,
            operation_id: &operation_id,
        };
        convert_inner(
            Path::new(&input_path),
            Path::new(&output_path),
            ConvertRequest {
                source,
                target,
                newline,
                normalize_mac_symbols,
            },
            &ctx,
        )
    })
    .await;
    join_result.map_err(AppError::from)?
}

pub(crate) struct ConvertRequest {
    pub source: SourceEncoding,
    pub target: TargetEncoding,
    pub newline: NewlineMode,
    pub normalize_mac_symbols: bool,
}

pub(crate) fn inspect_inner(
    path: &Path,
    source: SourceEncoding,
    ctx: &Ctx<'_>,
) -> Result<EncodingInspection, AppError> {
    let bytes = text_encoding::read_file(path, MAX_INPUT_BYTES, ctx)?;
    let resolution = text_encoding::resolve(&bytes, source, ctx)?;
    let ascii_only = bytes.is_ascii();
    let mut inspection = EncodingInspection {
        size: bytes.len() as u64,
        bom: resolution.bom,
        detection: resolution.detection,
        encoding: resolution.encoding,
        ascii_only,
        malformed_count: 0,
        malformed: Vec::new(),
        newlines: NewlineStats::default(),
        line_count: 0,
        char_count: 0,
        private_use_count: 0,
        preview: String::new(),
        preview_truncated: false,
    };
    let Some(encoding) = resolution.encoding else {
        return Ok(inspection);
    };

    let mut decoder = StreamDecoder::new(&bytes, encoding, resolution.bom_len);
    let mut newlines = NewlineTransform::new(NewlineMode::Keep);
    let mut sink = Vec::new();
    let mut ends_with_newline = true;
    while let Some((piece, _)) = decoder.next_piece() {
        ctx.check()?;
        sink.clear();
        newlines.push(piece.as_bytes(), &mut sink);
        for ch in piece.chars() {
            inspection.char_count += 1;
            if ('\u{E000}'..='\u{F8FF}').contains(&ch) {
                inspection.private_use_count += 1;
            }
        }
        if let Some(last) = piece.chars().last() {
            ends_with_newline = matches!(last, '\r' | '\n');
        }
    }
    sink.clear();
    newlines.finish(&mut sink);
    let stats = newlines.stats;
    let breaks = stats.crlf + stats.lf + stats.cr;
    inspection.newlines = stats;
    inspection.line_count = breaks + u64::from(inspection.char_count > 0 && !ends_with_newline);
    inspection.malformed_count = decoder.malformed_count;
    inspection.malformed = decoder.malformed;

    let body = &bytes[resolution.bom_len..];
    let head = &body[..body.len().min(PREVIEW_SOURCE_BYTES)];
    let (decoded, _) = encoding.encoding().decode_without_bom_handling(head);
    let mut chars = decoded.chars();
    inspection.preview = chars.by_ref().take(PREVIEW_CHARS).collect();
    inspection.preview_truncated = chars.next().is_some() || head.len() < body.len();
    Ok(inspection)
}

pub(crate) fn convert_inner(
    input: &Path,
    output: &Path,
    request: ConvertRequest,
    ctx: &Ctx<'_>,
) -> Result<EncodingConvertResult, AppError> {
    let started = Instant::now();
    check_output_path(input, output, ctx)?;
    let bytes = text_encoding::read_file(input, MAX_INPUT_BYTES, ctx)?;
    let resolution = text_encoding::resolve(&bytes, request.source, ctx)?;
    let source = resolution.encoding.ok_or_else(|| {
        ctx.invalid("文字コードを判定できませんでした。変換元の文字コードを選んでください。")
    })?;
    let options = ConvertOptions {
        source,
        bom_len: resolution.bom_len,
        target: request.target,
        newline: request.newline,
        normalize_mac_symbols: request.normalize_mac_symbols,
    };

    // 拒否のときは一時ファイルを捨てるために書き込みを失敗させ、結果は report で返す
    let mut report = None;
    let written = write_atomically_with_guard(
        output,
        |file| {
            let result = convert::convert(&bytes, &options, file, &|| ctx.check())?;
            let rejected = result.rejected();
            report = Some(result);
            if rejected {
                Err(ctx.invalid("rejected"))
            } else {
                Ok(())
            }
        },
        || ctx.check(),
    );
    let report = match (written, report) {
        (Ok(()), Some(report)) => report,
        (Err(_), Some(report)) if report.rejected() => report,
        (Err(error), _) => return Err(error),
        (Ok(()), None) => return Err(AppError::Internal("変換結果がありません。".into())),
    };
    let status = if report.rejected() {
        ConvertStatus::Rejected
    } else {
        ConvertStatus::Written
    };
    Ok(EncodingConvertResult {
        status,
        source,
        bytes_written: if status == ConvertStatus::Written {
            report.bytes_written
        } else {
            0
        },
        malformed_count: report.malformed_count,
        malformed: report.malformed,
        unmappable_count: report.unmappable_count,
        unmappable: report.unmappable,
        normalized_count: report.normalized_count,
        warnings: report.warnings,
        newlines: report.newlines,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

fn check_output_path(input: &Path, output: &Path, ctx: &Ctx<'_>) -> Result<(), AppError> {
    if output.is_dir() {
        return Err(ctx.invalid("出力先にはファイル名を指定してください。"));
    }
    let parent_exists = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .is_some_and(Path::is_dir);
    if !parent_exists {
        return Err(ctx.invalid("出力先のフォルダが見つかりません。"));
    }
    // hardlink や大文字小文字だけ違う名前も同じファイルとみなす。出力先がまだ無ければ別のファイル
    if same_file::is_same_file(input, output).unwrap_or(false) {
        return Err(ctx.invalid("出力先には元のファイルとは別のファイルを指定してください。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::text_encoding::Confidence;
    use encoding_rs::SHIFT_JIS;
    use tokio_util::sync::CancellationToken;

    fn with_ctx<T>(run: impl FnOnce(&Ctx<'_>) -> T) -> T {
        let token = CancellationToken::new();
        run(&Ctx {
            module_id: MODULE_ID,
            token: &token,
            operation_id: "op",
        })
    }

    fn request(source: SourceEncoding, target: TargetEncoding) -> ConvertRequest {
        ConvertRequest {
            source,
            target,
            newline: NewlineMode::Keep,
            normalize_mac_symbols: false,
        }
    }

    /// `src/ipc/encoding.ts` の文字列と一致すること。
    #[test]
    fn ipc_enum_names_match_the_frontend() {
        for (name, expected) in [
            ("auto", SourceEncoding::Auto),
            ("utf8", SourceEncoding::Utf8),
            ("utf16_le", SourceEncoding::Utf16Le),
            ("utf16_be", SourceEncoding::Utf16Be),
            ("shift_jis", SourceEncoding::ShiftJis),
            ("euc_jp", SourceEncoding::EucJp),
            ("iso2022_jp", SourceEncoding::Iso2022Jp),
        ] {
            let parsed: SourceEncoding = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed, expected);
        }
        for (name, expected) in [
            ("utf8", TargetEncoding::Utf8),
            ("utf8_bom", TargetEncoding::Utf8Bom),
            ("shift_jis", TargetEncoding::ShiftJis),
            ("euc_jp", TargetEncoding::EucJp),
        ] {
            let parsed: TargetEncoding = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed, expected);
        }
        for (name, expected) in [
            ("keep", NewlineMode::Keep),
            ("lf", NewlineMode::Lf),
            ("crlf", NewlineMode::Crlf),
        ] {
            let parsed: NewlineMode = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed, expected);
        }
        assert_eq!(
            serde_json::to_value(TextEncoding::Iso2022Jp).unwrap(),
            serde_json::json!("iso2022_jp")
        );
        assert_eq!(
            serde_json::to_value(ConvertStatus::Rejected).unwrap(),
            serde_json::json!("rejected")
        );
    }

    #[test]
    fn inspects_shift_jis_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.csv");
        std::fs::write(&path, SHIFT_JIS.encode("名前,値\r\n東京,1\r\n大阪").0).unwrap();
        let inspection = with_ctx(|ctx| inspect_inner(&path, SourceEncoding::Auto, ctx)).unwrap();
        assert_eq!(inspection.encoding, Some(TextEncoding::ShiftJis));
        assert_eq!(
            inspection
                .detection
                .as_ref()
                .map(|detection| detection.confidence),
            Some(Confidence::Guess)
        );
        assert_eq!(
            inspection.newlines,
            NewlineStats {
                crlf: 2,
                lf: 0,
                cr: 0
            }
        );
        assert_eq!(inspection.line_count, 3);
        assert_eq!(inspection.char_count, 14);
        assert_eq!(inspection.preview, "名前,値\r\n東京,1\r\n大阪");
        assert!(!inspection.preview_truncated);
    }

    #[test]
    fn inspection_reports_malformed_bytes_for_an_explicit_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.txt");
        std::fs::write(&path, b"ok\n\x82").unwrap();
        let inspection =
            with_ctx(|ctx| inspect_inner(&path, SourceEncoding::ShiftJis, ctx)).unwrap();
        assert_eq!(inspection.malformed_count, 1);
        assert_eq!(inspection.malformed[0].line, 2);
        assert!(inspection.preview.ends_with('\u{FFFD}'));
    }

    #[test]
    fn writes_the_converted_file() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        let output = dir.path().join("output.txt");
        std::fs::write(&input, "日本語\n").unwrap();
        let result = with_ctx(|ctx| {
            convert_inner(
                &input,
                &output,
                request(SourceEncoding::Auto, TargetEncoding::ShiftJis),
                ctx,
            )
        })
        .unwrap();
        assert_eq!(result.status, ConvertStatus::Written);
        assert_eq!(result.source, TextEncoding::Utf8);
        assert_eq!(
            std::fs::read(&output).unwrap(),
            SHIFT_JIS.encode("日本語\n").0.as_ref()
        );
        assert_eq!(result.bytes_written, 7);
    }

    #[test]
    fn rejection_keeps_the_existing_output_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        let output = dir.path().join("output.txt");
        std::fs::write(&input, "〜").unwrap();
        std::fs::write(&output, "before").unwrap();
        let result = with_ctx(|ctx| {
            convert_inner(
                &input,
                &output,
                request(SourceEncoding::Utf8, TargetEncoding::ShiftJis),
                ctx,
            )
        })
        .unwrap();
        assert_eq!(result.status, ConvertStatus::Rejected);
        assert_eq!(result.unmappable_count, 1);
        assert_eq!(result.bytes_written, 0);
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "before");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn cancellation_keeps_the_existing_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        let output = dir.path().join("output.txt");
        std::fs::write(&input, "abc").unwrap();
        std::fs::write(&output, "before").unwrap();
        let token = CancellationToken::new();
        token.cancel();
        let ctx = Ctx {
            module_id: MODULE_ID,
            token: &token,
            operation_id: "op",
        };
        let error = convert_inner(
            &input,
            &output,
            request(SourceEncoding::Utf8, TargetEncoding::ShiftJis),
            &ctx,
        )
        .unwrap_err();
        assert!(matches!(error, AppError::Cancelled { .. }));
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "before");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn rejects_writing_over_the_input() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        std::fs::write(&input, "abc").unwrap();
        let error = with_ctx(|ctx| {
            convert_inner(
                &input,
                &input,
                request(SourceEncoding::Utf8, TargetEncoding::ShiftJis),
                ctx,
            )
        })
        .unwrap_err();
        assert!(matches!(error, AppError::Validation { .. }));

        let link = dir.path().join("link.txt");
        std::fs::hard_link(&input, &link).unwrap();
        let error = with_ctx(|ctx| {
            convert_inner(
                &input,
                &link,
                request(SourceEncoding::Utf8, TargetEncoding::ShiftJis),
                ctx,
            )
        })
        .unwrap_err();
        assert!(matches!(error, AppError::Validation { .. }));
    }

    #[test]
    fn rejects_a_directory_or_missing_folder_as_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        std::fs::write(&input, "abc").unwrap();
        for output in [dir.path().to_path_buf(), dir.path().join("missing/out.txt")] {
            let error = with_ctx(|ctx| {
                convert_inner(
                    &input,
                    &output,
                    request(SourceEncoding::Utf8, TargetEncoding::ShiftJis),
                    ctx,
                )
            })
            .unwrap_err();
            assert!(matches!(error, AppError::Validation { .. }));
        }
    }

    #[test]
    fn rejects_undetectable_input_without_an_explicit_source() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        std::fs::write(&input, b"\x81\x20\x8F\xFF").unwrap();
        let error = with_ctx(|ctx| {
            convert_inner(
                &input,
                &dir.path().join("out.txt"),
                request(SourceEncoding::Auto, TargetEncoding::Utf8),
                ctx,
            )
        })
        .unwrap_err();
        assert!(matches!(error, AppError::Validation { .. }));
    }

    #[test]
    fn rejects_files_over_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.txt");
        let file = std::fs::File::create(&input).unwrap();
        file.set_len(MAX_INPUT_BYTES + 1).unwrap();
        let error = with_ctx(|ctx| inspect_inner(&input, SourceEncoding::Auto, ctx)).unwrap_err();
        assert!(matches!(error, AppError::Validation { .. }));
    }
}
