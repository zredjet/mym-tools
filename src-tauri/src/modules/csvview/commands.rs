//! M-CSV ビューアの Tauri command (ADR-0024)。
//!
//! 表に出すには文字列が要るため、path を受け取って文字コードを判定・復号し、文字列を返す
//! (`vector_read_file` と同じ)。読めないバイトがあれば置換文字にせず拒否する。
//! CSV の解析と変換はフロントの Worker で行う。

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::modules::text_encoding::{self, Confidence, Ctx, SourceEncoding, TextEncoding};
use crate::operations::OperationGuard;
use crate::state::AppState;

const MODULE_ID: &str = "csvview";
/// ファイルの上限 (ADR-0024)。
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// 復号した文字列 (UTF-8) の上限。半角カナばかりの Shift_JIS は 3 倍になる。
pub const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CsvFileText {
    pub text: String,
    pub encoding: TextEncoding,
    /// 自動判定したときだけ Some
    pub confidence: Option<Confidence>,
    pub bom: Option<TextEncoding>,
    pub size: u64,
}

#[tauri::command]
pub async fn csvview_read_file(
    state: State<'_, AppState>,
    operation_id: String,
    path: String,
    source: SourceEncoding,
) -> Result<CsvFileText, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let ctx = Ctx {
            module_id: MODULE_ID,
            token: &token,
            operation_id: &operation_id,
        };
        read_inner(Path::new(&path), source, &ctx)
    })
    .await;
    join_result.map_err(AppError::from)?
}

pub(crate) fn read_inner(
    path: &Path,
    source: SourceEncoding,
    ctx: &Ctx<'_>,
) -> Result<CsvFileText, AppError> {
    let bytes = text_encoding::read_file(path, MAX_FILE_BYTES, ctx)?;
    let resolution = text_encoding::resolve(&bytes, source, ctx)?;
    let Some(encoding) = resolution.encoding else {
        return Err(ctx.invalid("文字コードを判定できませんでした。文字コードを選んでください。"));
    };
    let decoded =
        text_encoding::decode_all(&bytes, encoding, resolution.bom_len, MAX_TEXT_BYTES, ctx)?;
    if let Some(first) = decoded.malformed.first() {
        let more = decoded.malformed_count.saturating_sub(1);
        let others = if more > 0 {
            format!(" (ほか {more} か所)")
        } else {
            String::new()
        };
        return Err(ctx.invalid(format!(
            "{} 行目 ({} バイト目) に {} として読めないバイト ({}) があります{}。文字コードを選び直してください。",
            first.line,
            first.offset,
            encoding.label(),
            first.bytes,
            others
        )));
    }
    Ok(CsvFileText {
        text: decoded.text,
        encoding,
        confidence: resolution.detection.map(|detection| detection.confidence),
        bom: resolution.bom,
        size: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::SHIFT_JIS;
    use tokio_util::sync::CancellationToken;

    fn read(path: &Path, source: SourceEncoding) -> Result<CsvFileText, AppError> {
        let token = CancellationToken::new();
        read_inner(
            path,
            source,
            &Ctx {
                module_id: MODULE_ID,
                token: &token,
                operation_id: "op",
            },
        )
    }

    #[test]
    fn reads_a_shift_jis_csv() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("list.csv");
        std::fs::write(&path, SHIFT_JIS.encode("名前,値\r\n東京,1\r\n").0).unwrap();
        let file = read(&path, SourceEncoding::Auto).unwrap();
        assert_eq!(file.text, "名前,値\r\n東京,1\r\n");
        assert_eq!(file.encoding, TextEncoding::ShiftJis);
        assert_eq!(file.confidence, Some(Confidence::Guess));
        assert_eq!(file.size, 17);
    }

    #[test]
    fn strips_the_bom_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("list.csv");
        std::fs::write(&path, b"\xEF\xBB\xBFa,b\n").unwrap();
        let file = read(&path, SourceEncoding::Utf8).unwrap();
        assert_eq!(file.text, "a,b\n");
        assert_eq!(file.bom, Some(TextEncoding::Utf8));
        assert_eq!(file.confidence, None);
    }

    #[test]
    fn rejects_malformed_bytes_with_their_position() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("list.csv");
        std::fs::write(&path, b"a,b\n\x82\x20").unwrap();
        match read(&path, SourceEncoding::ShiftJis).unwrap_err() {
            AppError::Validation { reason, .. } => {
                assert!(
                    reason.starts_with("2 行目 (4 バイト目) に Shift_JIS"),
                    "{reason}"
                );
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn rejects_undetectable_files_and_files_over_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.csv");
        std::fs::write(&path, b"\x81\x20\x8F\xFF").unwrap();
        assert!(matches!(
            read(&path, SourceEncoding::Auto),
            Err(AppError::Validation { .. })
        ));

        let large = dir.path().join("large.csv");
        std::fs::File::create(&large)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(matches!(
            read(&large, SourceEncoding::Utf8),
            Err(AppError::Validation { .. })
        ));
    }
}
