//! PNGを1ファイルずつ、またはフォルダ直下をまとめて最適化するTauri command (ADR-0023)。
//!
//! 最適化は複製した shotq (`crates/shotq`) の `shotq::optimize` に任せる。出力の規則は shotq の
//! CLI と同じで、出力先には必ず完全なPNGが残り、PNG入力より大きくならない。shotq は内部で
//! rayon の全体プールを使うため (ADR-0009 R-2 の限定例外)、処理はアプリ全体で同時に1つにする。

use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::modules::image_export::write_atomically_with_guard;
use crate::operations::OperationGuard;
use crate::state::AppState;

use super::progress::{PngOptProgress, PngOptStatus};

const MODULE_ID: &str = "pngopt";
/// 1ファイルの上限。8K の写真のPNGも収まる大きさにする (ADR-0023 §2.5)。
pub const MAX_INPUT_BYTES: u64 = 128 * 1024 * 1024;
/// 画素数の上限。4,000万画素で shotq は約110 ms・最大メモリ約400 MB (M4 Max の実測、ADR-0023 §2.5)。
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_FOLDER_FILES: usize = 10_000;
const READ_CHUNK_SIZE: usize = 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const ENGINE_WAIT_INTERVAL: Duration = Duration::from_millis(50);

/// shotq の処理をアプリ全体で1つにする。shotq の並列処理にはワーカー同士が互いの進捗を
/// 待つ箇所があり、rayon の全体プールを別の処理と共有しない (ADR-0023 §2.3)。
static ENGINE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PngOptOutputMode {
    /// 別フォルダに同じ名前で書く
    Separate,
    /// 元のファイルを上書きする
    Overwrite,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PngOptFileResult {
    pub output_path: String,
    pub status: PngOptStatus,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    /// shotq の処理内容 (英語、`--timing` の行と同じ)
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PngOptScanResult {
    pub file_count: usize,
    pub input_bytes: u64,
    /// 出力で上書きされるファイルの数
    pub conflict_count: usize,
    /// 対象外 (PNG以外、サブフォルダ、シンボリックリンク、隠しファイル) の数
    pub skipped_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct PngOptFolderResult {
    pub total: u32,
    pub optimized: u32,
    pub quality_too_low: u32,
    pub not_smaller: u32,
    pub failed: u32,
    /// 失敗したファイルを除く入力の合計
    pub input_bytes: u64,
    /// 失敗したファイルを除く出力の合計
    pub output_bytes: u64,
    pub duration_ms: u64,
}

struct FileOutcome {
    status: PngOptStatus,
    input_bytes: u64,
    output_bytes: u64,
    width: u32,
    height: u32,
    detail: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pngopt_optimize_file(
    state: State<'_, AppState>,
    operation_id: String,
    input_path: String,
    output_path: String,
    quality_min: u8,
    quality_max: u8,
    speed: u8,
) -> Result<PngOptFileResult, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        optimize_file_inner(
            Path::new(&input_path),
            Path::new(&output_path),
            quality_min,
            quality_max,
            speed,
            &token,
            &operation_id,
        )
    })
    .await;

    join_result.map_err(AppError::from)?
}

#[tauri::command]
pub async fn pngopt_scan_folder(
    folder_path: String,
    output_mode: PngOptOutputMode,
    output_folder: Option<String>,
) -> Result<PngOptScanResult, AppError> {
    let join_result = tauri::async_runtime::spawn_blocking(move || {
        scan_folder_inner(
            Path::new(&folder_path),
            output_mode,
            output_folder.as_deref().map(Path::new),
        )
    })
    .await;

    join_result.map_err(AppError::from)?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pngopt_optimize_folder(
    state: State<'_, AppState>,
    operation_id: String,
    folder_path: String,
    output_mode: PngOptOutputMode,
    output_folder: Option<String>,
    quality_min: u8,
    quality_max: u8,
    speed: u8,
    on_progress: Channel<PngOptProgress>,
) -> Result<PngOptFolderResult, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());
    let id_for_blocking = operation_id.clone();

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let mut progress = make_channel_sink(on_progress, id_for_blocking.clone());
        let result = optimize_folder_inner(
            Path::new(&folder_path),
            output_mode,
            output_folder.as_deref().map(Path::new),
            quality_min,
            quality_max,
            speed,
            &token,
            &id_for_blocking,
            &mut progress,
        );
        if matches!(result, Err(AppError::Cancelled { .. })) {
            progress(PngOptProgress::Cancelled);
        }
        result
    })
    .await;

    join_result.map_err(AppError::from)?
}

fn make_channel_sink(
    channel: Channel<PngOptProgress>,
    operation_id: String,
) -> impl FnMut(PngOptProgress) {
    move |event| {
        if let Err(error) = channel.send(event) {
            tracing::warn!(
                operation_id = %operation_id,
                error = %error,
                "pngopt progress channel send failed; continuing"
            );
        }
    }
}

fn optimize_file_inner(
    input: &Path,
    output: &Path,
    quality_min: u8,
    quality_max: u8,
    speed: u8,
    token: &CancellationToken,
    operation_id: &str,
) -> Result<PngOptFileResult, AppError> {
    let started = Instant::now();
    let options = engine_options(quality_min, quality_max, speed)?;
    require_png_extension(output)?;
    let _engine = lock_engine(token, operation_id)?;
    let outcome = optimize_to(input, output, &options, token, operation_id)?;
    Ok(PngOptFileResult {
        output_path: output.display().to_string(),
        status: outcome.status,
        input_bytes: outcome.input_bytes,
        output_bytes: outcome.output_bytes,
        width: outcome.width,
        height: outcome.height,
        duration_ms: elapsed_ms(started),
        detail: outcome.detail,
    })
}

fn scan_folder_inner(
    folder: &Path,
    mode: PngOptOutputMode,
    output_folder: Option<&Path>,
) -> Result<PngOptScanResult, AppError> {
    let output_dir = resolve_output_dir(folder, mode, output_folder)?;
    let listing = list_png_files(folder)?;
    let mut input_bytes = 0_u64;
    let mut conflict_count = 0;
    for file in &listing.files {
        input_bytes = input_bytes.saturating_add(fs::metadata(file).map(|m| m.len()).unwrap_or(0));
        let target = output_path_for(file, output_dir.as_deref());
        if target.exists() {
            conflict_count += 1;
        }
    }
    Ok(PngOptScanResult {
        file_count: listing.files.len(),
        input_bytes,
        conflict_count,
        skipped_count: listing.skipped,
    })
}

#[allow(clippy::too_many_arguments)]
fn optimize_folder_inner(
    folder: &Path,
    mode: PngOptOutputMode,
    output_folder: Option<&Path>,
    quality_min: u8,
    quality_max: u8,
    speed: u8,
    token: &CancellationToken,
    operation_id: &str,
    progress: &mut impl FnMut(PngOptProgress),
) -> Result<PngOptFolderResult, AppError> {
    let started = Instant::now();
    let options = engine_options(quality_min, quality_max, speed)?;
    let output_dir = resolve_output_dir(folder, mode, output_folder)?;
    let files = list_png_files(folder)?.files;
    if files.is_empty() {
        return Err(validation("フォルダの直下にPNGファイルがありません。"));
    }
    let total = u32::try_from(files.len()).unwrap_or(u32::MAX);
    progress(PngOptProgress::Started { total });
    let _engine = lock_engine(token, operation_id)?;

    let mut summary = PngOptFolderResult {
        total,
        ..PngOptFolderResult::default()
    };
    for (index, input) in files.iter().enumerate() {
        ensure_not_cancelled(token, operation_id)?;
        let output = output_path_for(input, output_dir.as_deref());
        let (status, input_bytes, output_bytes, detail) =
            match optimize_to(input, &output, &options, token, operation_id) {
                Ok(outcome) => (
                    outcome.status,
                    outcome.input_bytes,
                    outcome.output_bytes,
                    outcome.detail,
                ),
                Err(error @ AppError::Cancelled { .. }) => return Err(error),
                Err(error) => (PngOptStatus::Failed, 0, 0, failure_reason(error)),
            };
        match status {
            PngOptStatus::Optimized => summary.optimized += 1,
            PngOptStatus::QualityTooLow => summary.quality_too_low += 1,
            PngOptStatus::NotSmaller => summary.not_smaller += 1,
            PngOptStatus::Failed => summary.failed += 1,
        }
        summary.input_bytes = summary.input_bytes.saturating_add(input_bytes);
        summary.output_bytes = summary.output_bytes.saturating_add(output_bytes);
        progress(PngOptProgress::File {
            index: u32::try_from(index).unwrap_or(u32::MAX),
            total,
            name: display_file_name(input),
            status,
            input_bytes,
            output_bytes,
            detail,
        });
    }

    summary.duration_ms = elapsed_ms(started);
    progress(PngOptProgress::Done {
        duration_ms: summary.duration_ms,
    });
    Ok(summary)
}

/// 1ファイルを最適化して `output` に書く。出力の規則は shotq の CLI と同じ:
/// 最適化できたらその PNG、できなかった (98 / 99) なら入力のバイト列を書き、
/// 出力先が入力と同じならそのままにする。
fn optimize_to(
    input: &Path,
    output: &Path,
    options: &shotq::Options,
    token: &CancellationToken,
    operation_id: &str,
) -> Result<FileOutcome, AppError> {
    let bytes = read_file_cancellable(input, token, operation_id)?;
    let (width, height) = png_dimensions(&bytes)?;
    ensure_not_cancelled(token, operation_id)?;
    let outcome = run_engine(&bytes, options)?;
    ensure_not_cancelled(token, operation_id)?;

    let written: Option<&[u8]> = match &outcome.png {
        Some(png) => Some(png),
        None if same_file(input, output) => None,
        None => Some(&bytes),
    };
    if let Some(data) = written {
        write_atomically_with_guard(
            output,
            |file| {
                file.write_all(data)?;
                Ok(())
            },
            || ensure_not_cancelled(token, operation_id),
        )?;
    }
    let output_len = written.map_or(bytes.len(), <[u8]>::len);
    Ok(FileOutcome {
        status: match outcome.status {
            shotq::Status::Optimized => PngOptStatus::Optimized,
            shotq::Status::QualityTooLow => PngOptStatus::QualityTooLow,
            shotq::Status::NotSmaller => PngOptStatus::NotSmaller,
        },
        input_bytes: bytes.len() as u64,
        output_bytes: output_len as u64,
        width,
        height,
        detail: outcome.note,
    })
}

fn run_engine(bytes: &[u8], options: &shotq::Options) -> Result<shotq::Outcome, AppError> {
    // shotq の panic は不具合なので、フォルダ処理の残りを続けられるようファイル単位で受け止める
    match panic::catch_unwind(AssertUnwindSafe(|| shotq::optimize(bytes, options))) {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(reason)) => Err(validation(format!("PNGを最適化できません ({reason})。"))),
        Err(_) => Err(AppError::Internal(
            "PNG最適化の処理中に内部エラーが発生しました。".into(),
        )),
    }
}

fn engine_options(quality_min: u8, quality_max: u8, speed: u8) -> Result<shotq::Options, AppError> {
    if quality_min > quality_max || quality_max > 100 {
        return Err(validation(
            "品質は0〜100の範囲で、下限を上限以下にしてください。",
        ));
    }
    if !(1..=11).contains(&speed) {
        return Err(validation("速度は1〜11の範囲で指定してください。"));
    }
    Ok(shotq::Options {
        qmin: quality_min,
        qmax: quality_max,
        speed: i32::from(speed),
        ..shotq::Options::default()
    })
}

fn lock_engine(
    token: &CancellationToken,
    operation_id: &str,
) -> Result<MutexGuard<'static, ()>, AppError> {
    loop {
        match ENGINE_LOCK.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {
                ensure_not_cancelled(token, operation_id)?;
                std::thread::sleep(ENGINE_WAIT_INTERVAL);
            }
        }
    }
}

/// PNGのシグネチャと IHDR から幅・高さを読み、画素数の上限をデコード前に確かめる。
fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), AppError> {
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(validation("PNGファイルではありません。"));
    }
    if bytes.len() < 33 || &bytes[12..16] != b"IHDR" {
        return Err(validation("PNGのヘッダーが壊れています。"));
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 {
        return Err(validation("PNGのヘッダーが壊れています。"));
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(validation(format!(
            "画素数が上限の4,000万画素を超えています ({width}×{height})。"
        )));
    }
    Ok((width, height))
}

fn read_file_cancellable(
    path: &Path,
    token: &CancellationToken,
    operation_id: &str,
) -> Result<Vec<u8>, AppError> {
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::Io(format!("{} を確認できません: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(validation("PNGファイルを指定してください。"));
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(validation("1ファイルのサイズが128 MiBを超えています。"));
    }
    let file = File::open(path)
        .map_err(|error| AppError::Io(format!("{} を開けません: {error}", path.display())))?;
    let capacity = usize::try_from(metadata.len()).unwrap_or(0);
    let mut reader = BufReader::with_capacity(READ_CHUNK_SIZE, file);
    let mut bytes = Vec::with_capacity(capacity);
    let mut chunk = vec![0_u8; READ_CHUNK_SIZE];
    loop {
        ensure_not_cancelled(token, operation_id)?;
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) as u64 > MAX_INPUT_BYTES {
            return Err(validation("1ファイルのサイズが128 MiBを超えています。"));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok(bytes)
}

struct Listing {
    files: Vec<PathBuf>,
    skipped: usize,
}

/// フォルダ直下の `*.png` をファイル名の順に返す。サブフォルダ、シンボリックリンク、隠しファイルは対象外。
fn list_png_files(folder: &Path) -> Result<Listing, AppError> {
    require_directory(folder, "入力")?;
    let mut files = Vec::new();
    let mut skipped = 0;
    let entries = fs::read_dir(folder)
        .map_err(|error| AppError::Io(format!("{} を読めません: {error}", folder.display())))?;
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        let name = entry.file_name();
        let is_target = file_type.is_file()
            && has_png_extension(&path)
            && !is_hidden(&name, &entry.metadata()?);
        if is_target {
            files.push(path);
        } else {
            skipped += 1;
        }
    }
    if files.len() > MAX_FOLDER_FILES {
        return Err(validation(format!(
            "PNGファイルが{}件あります。1回に処理できるのは{MAX_FOLDER_FILES}件までです。",
            files.len()
        )));
    }
    files.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    Ok(Listing { files, skipped })
}

fn resolve_output_dir(
    folder: &Path,
    mode: PngOptOutputMode,
    output_folder: Option<&Path>,
) -> Result<Option<PathBuf>, AppError> {
    require_directory(folder, "入力")?;
    match mode {
        PngOptOutputMode::Overwrite => Ok(None),
        PngOptOutputMode::Separate => {
            let output =
                output_folder.ok_or_else(|| validation("出力先のフォルダを指定してください。"))?;
            require_directory(output, "出力先")?;
            if same_file(folder, output) {
                return Err(validation(
                    "出力先には入力とは別のフォルダを指定してください。",
                ));
            }
            Ok(Some(output.to_path_buf()))
        }
    }
}

fn output_path_for(input: &Path, output_dir: Option<&Path>) -> PathBuf {
    match (output_dir, input.file_name()) {
        (Some(dir), Some(name)) => dir.join(name),
        _ => input.to_path_buf(),
    }
}

fn require_directory(path: &Path, label: &str) -> Result<(), AppError> {
    if path.is_dir() {
        Ok(())
    } else {
        Err(validation(format!("{label}のフォルダが見つかりません。")))
    }
}

fn require_png_extension(path: &Path) -> Result<(), AppError> {
    if has_png_extension(path) {
        Ok(())
    } else {
        Err(validation(
            "出力先には拡張子が.pngのファイルを指定してください。",
        ))
    }
}

fn has_png_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
}

fn is_hidden(name: &OsStr, metadata: &fs::Metadata) -> bool {
    if name.to_string_lossy().starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = metadata;
    false
}

/// 両方が存在して同じファイルを指すか。出力先がまだ無ければ入力と同じではない。
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
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

fn validation(reason: impl Into<String>) -> AppError {
    AppError::Validation {
        module_id: MODULE_ID.into(),
        reason: reason.into(),
    }
}

fn failure_reason(error: AppError) -> String {
    match error {
        AppError::Validation { reason, .. } => reason,
        AppError::Io(reason) => reason,
        AppError::Internal(reason) => reason,
        other => other.to_string(),
    }
}

fn display_file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const CONTRACT_EXPECTED: &str = include_str!("contract/expected.txt");

    fn contract_fixture(name: &str) -> &'static [u8] {
        match name {
            "flat-truecolor.png" => include_bytes!("contract/flat-truecolor.png"),
            "noise.png" => include_bytes!("contract/noise.png"),
            "photo-alpha.png" => include_bytes!("contract/photo-alpha.png"),
            "tiny.png" => include_bytes!("contract/tiny.png"),
            "ui-icc.png" => include_bytes!("contract/ui-icc.png"),
            "ui-large.png" => include_bytes!("contract/ui-large.png"),
            "ui.png" => include_bytes!("contract/ui.png"),
            other => panic!("unknown contract fixture {other}"),
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn cli_options() -> shotq::Options {
        // `shotq --quality=70-85 --speed 11`
        engine_options(70, 85, 11).unwrap()
    }

    fn token() -> CancellationToken {
        CancellationToken::new()
    }

    /// ADR-0023 §2.7: 複製した shotq が、同じ commit の CLI とバイト単位で同じ結果を出す。
    #[test]
    fn contract_matches_the_shotq_cli() {
        let mut checked = 0;
        for line in CONTRACT_EXPECTED
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let [expected_sha, expected_status, name] = fields[..] else {
                panic!("malformed expected.txt line: {line}");
            };
            let input = contract_fixture(name);
            let _engine = ENGINE_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let outcome = shotq::optimize(input, &cli_options()).unwrap();
            let output = outcome.png.as_deref().unwrap_or(input);
            let status = match outcome.status {
                shotq::Status::Optimized => "optimized",
                shotq::Status::QualityTooLow => "quality_too_low",
                shotq::Status::NotSmaller => "not_smaller",
            };
            assert_eq!(status, expected_status, "{name}: status");
            assert_eq!(
                sha256_hex(output),
                expected_sha,
                "{name}: output bytes differ from the shotq CLI"
            );
            checked += 1;
        }
        assert_eq!(checked, 7);
    }

    #[test]
    fn options_follow_the_cli_ranges() {
        assert!(engine_options(0, 100, 1).is_ok());
        assert!(engine_options(86, 85, 11).is_err());
        assert!(engine_options(70, 101, 11).is_err());
        assert!(engine_options(70, 85, 0).is_err());
        assert!(engine_options(70, 85, 12).is_err());
        let options = cli_options();
        assert_eq!((options.qmin, options.qmax, options.speed), (70, 85, 11));
        assert_eq!(options.level, None);
        assert_eq!(options.dither, 0.0);
    }

    #[test]
    fn dimensions_are_checked_before_decoding() {
        assert_eq!(
            png_dimensions(contract_fixture("ui.png")).unwrap(),
            (320, 200)
        );
        assert!(png_dimensions(b"not a png").is_err());
        assert!(png_dimensions(PNG_SIGNATURE).is_err());
        let mut huge = contract_fixture("tiny.png").to_vec();
        huge[16..20].copy_from_slice(&8000_u32.to_be_bytes());
        huge[20..24].copy_from_slice(&5001_u32.to_be_bytes());
        let error = png_dimensions(&huge).unwrap_err();
        assert!(failure_reason(error).contains("4,000万画素"));
    }

    #[test]
    fn single_file_writes_the_optimized_png_next_to_the_input() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("ui.png");
        let output = directory.path().join("ui-optimized.png");
        fs::write(&input, contract_fixture("ui.png")).unwrap();
        let result = optimize_file_inner(&input, &output, 70, 85, 11, &token(), "op").unwrap();
        assert_eq!(result.status, PngOptStatus::Optimized);
        assert_eq!((result.width, result.height), (320, 200));
        assert_eq!(result.input_bytes, contract_fixture("ui.png").len() as u64);
        assert_eq!(result.output_bytes, fs::metadata(&output).unwrap().len());
        assert!(result.output_bytes < result.input_bytes);
        assert_eq!(fs::read(&input).unwrap(), contract_fixture("ui.png"));
        assert_eq!(
            entries(directory.path()),
            vec!["ui-optimized.png", "ui.png"]
        );
    }

    #[test]
    fn inputs_that_are_kept_are_copied_or_left_alone() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["tiny.png", "noise.png"] {
            let input = directory.path().join(name);
            fs::write(&input, contract_fixture(name)).unwrap();
            // to another path: the input bytes are written there
            let copy = directory.path().join(format!("out-{name}"));
            let result = optimize_file_inner(&input, &copy, 70, 85, 11, &token(), "op").unwrap();
            assert_ne!(result.status, PngOptStatus::Optimized);
            assert_eq!(fs::read(&copy).unwrap(), contract_fixture(name));
            // in place: nothing is written
            let before = fs::metadata(&input).unwrap().modified().unwrap();
            let result = optimize_file_inner(&input, &input, 70, 85, 11, &token(), "op").unwrap();
            assert_eq!(result.output_bytes, result.input_bytes);
            assert_eq!(fs::read(&input).unwrap(), contract_fixture(name));
            assert_eq!(fs::metadata(&input).unwrap().modified().unwrap(), before);
        }
        let result_status = |name: &str| {
            let input = directory.path().join(name);
            optimize_file_inner(&input, &input, 70, 85, 11, &token(), "op")
                .unwrap()
                .status
        };
        assert_eq!(result_status("tiny.png"), PngOptStatus::NotSmaller);
        assert_eq!(result_status("noise.png"), PngOptStatus::QualityTooLow);
    }

    #[test]
    fn overwrite_replaces_the_input_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("ui.png");
        fs::write(&input, contract_fixture("ui.png")).unwrap();
        let result = optimize_file_inner(&input, &input, 70, 85, 11, &token(), "op").unwrap();
        assert_eq!(result.status, PngOptStatus::Optimized);
        assert_eq!(fs::metadata(&input).unwrap().len(), result.output_bytes);
        assert_eq!(entries(directory.path()), vec!["ui.png"]);
    }

    #[test]
    fn broken_inputs_and_bad_outputs_are_rejected_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let broken = directory.path().join("broken.png");
        let mut bytes = contract_fixture("ui.png").to_vec();
        bytes.truncate(bytes.len() / 2);
        fs::write(&broken, &bytes).unwrap();
        let output = directory.path().join("out.png");
        assert!(optimize_file_inner(&broken, &output, 70, 85, 11, &token(), "op").is_err());
        assert!(!output.exists());

        let input = directory.path().join("ui.png");
        fs::write(&input, contract_fixture("ui.png")).unwrap();
        let not_png = directory.path().join("out.jpg");
        assert!(optimize_file_inner(&input, &not_png, 70, 85, 11, &token(), "op").is_err());
        assert!(optimize_file_inner(&input, &output, 90, 80, 11, &token(), "op").is_err());
        let missing = directory.path().join("missing.png");
        assert!(optimize_file_inner(&missing, &output, 70, 85, 11, &token(), "op").is_err());
        assert!(!output.exists());
    }

    #[test]
    fn cancelled_operations_leave_no_output_or_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("ui.png");
        fs::write(&input, contract_fixture("ui.png")).unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let output = directory.path().join("out.png");
        let error = optimize_file_inner(&input, &output, 70, 85, 11, &cancelled, "op").unwrap_err();
        assert!(matches!(error, AppError::Cancelled { .. }));
        assert_eq!(entries(directory.path()), vec!["ui.png"]);
    }

    fn folder_fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("b-ui.png"), contract_fixture("ui.png")).unwrap();
        fs::write(root.join("a-tiny.png"), contract_fixture("tiny.png")).unwrap();
        fs::write(root.join("C-NOISE.PNG"), contract_fixture("noise.png")).unwrap();
        fs::write(root.join("d-broken.png"), b"\x89PNG\r\n\x1a\nbroken").unwrap();
        fs::write(root.join("notes.txt"), b"not an image").unwrap();
        fs::write(root.join(".hidden.png"), contract_fixture("ui.png")).unwrap();
        fs::create_dir(root.join("sub.png")).unwrap();
        fs::write(
            root.join("sub.png").join("nested.png"),
            contract_fixture("ui.png"),
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("b-ui.png"), root.join("link.png")).unwrap();
        directory
    }

    #[test]
    fn folder_listing_takes_only_direct_png_files_in_name_order() {
        let directory = folder_fixture();
        let listing = list_png_files(directory.path()).unwrap();
        let names: Vec<String> = listing
            .files
            .iter()
            .map(|path| display_file_name(path))
            .collect();
        assert_eq!(
            names,
            vec!["C-NOISE.PNG", "a-tiny.png", "b-ui.png", "d-broken.png"]
        );
        let expected_skipped = if cfg!(unix) { 4 } else { 3 };
        assert_eq!(listing.skipped, expected_skipped);
    }

    #[test]
    fn folder_run_continues_after_a_failure_and_counts_every_status() {
        let directory = folder_fixture();
        let output = tempfile::tempdir().unwrap();
        let mut events = Vec::new();
        let summary = optimize_folder_inner(
            directory.path(),
            PngOptOutputMode::Separate,
            Some(output.path()),
            70,
            85,
            11,
            &token(),
            "op",
            &mut |event| events.push(event),
        )
        .unwrap();
        assert_eq!(
            (
                summary.total,
                summary.optimized,
                summary.quality_too_low,
                summary.not_smaller,
                summary.failed
            ),
            (4, 1, 1, 1, 1)
        );
        assert_eq!(
            entries(output.path()),
            vec!["C-NOISE.PNG", "a-tiny.png", "b-ui.png"]
        );
        assert_eq!(
            fs::read(output.path().join("a-tiny.png")).unwrap(),
            contract_fixture("tiny.png")
        );
        assert!(matches!(
            events.first(),
            Some(PngOptProgress::Started { total: 4 })
        ));
        assert!(matches!(events.last(), Some(PngOptProgress::Done { .. })));
        let statuses: Vec<(String, PngOptStatus)> = events
            .iter()
            .filter_map(|event| match event {
                PngOptProgress::File { name, status, .. } => Some((name.clone(), *status)),
                _ => None,
            })
            .collect();
        assert_eq!(
            statuses[3],
            ("d-broken.png".to_string(), PngOptStatus::Failed)
        );
        // inputs are untouched in separate mode
        assert_eq!(
            fs::read(directory.path().join("b-ui.png")).unwrap(),
            contract_fixture("ui.png")
        );
    }

    #[test]
    fn folder_scan_counts_conflicts_and_rejects_the_input_folder_as_output() {
        let directory = folder_fixture();
        let output = tempfile::tempdir().unwrap();
        fs::write(output.path().join("b-ui.png"), b"old").unwrap();
        let scan = scan_folder_inner(
            directory.path(),
            PngOptOutputMode::Separate,
            Some(output.path()),
        )
        .unwrap();
        assert_eq!((scan.file_count, scan.conflict_count), (4, 1));
        let overwrite =
            scan_folder_inner(directory.path(), PngOptOutputMode::Overwrite, None).unwrap();
        assert_eq!(overwrite.conflict_count, 4);
        assert!(scan_folder_inner(
            directory.path(),
            PngOptOutputMode::Separate,
            Some(directory.path())
        )
        .is_err());
        assert!(scan_folder_inner(directory.path(), PngOptOutputMode::Separate, None).is_err());
    }

    #[test]
    fn folder_overwrite_replaces_only_the_improved_files() {
        let directory = folder_fixture();
        let summary = optimize_folder_inner(
            directory.path(),
            PngOptOutputMode::Overwrite,
            None,
            70,
            85,
            11,
            &token(),
            "op",
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(summary.optimized, 1);
        assert!(
            fs::metadata(directory.path().join("b-ui.png"))
                .unwrap()
                .len()
                < contract_fixture("ui.png").len() as u64
        );
        assert_eq!(
            fs::read(directory.path().join("a-tiny.png")).unwrap(),
            contract_fixture("tiny.png")
        );
        assert_eq!(
            fs::read(directory.path().join("C-NOISE.PNG")).unwrap(),
            contract_fixture("noise.png")
        );
        assert_eq!(
            fs::read(directory.path().join("sub.png").join("nested.png")).unwrap(),
            contract_fixture("ui.png")
        );
    }

    #[test]
    fn folder_cancellation_keeps_finished_files_complete() {
        let directory = folder_fixture();
        let output = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let mut processed = 0;
        let result = optimize_folder_inner(
            directory.path(),
            PngOptOutputMode::Separate,
            Some(output.path()),
            70,
            85,
            11,
            &cancel,
            "op",
            &mut |event| {
                if matches!(event, PngOptProgress::File { .. }) {
                    processed += 1;
                    if processed == 2 {
                        cancel.cancel();
                    }
                }
            },
        );
        assert!(matches!(result, Err(AppError::Cancelled { .. })));
        assert_eq!(entries(output.path()), vec!["C-NOISE.PNG", "a-tiny.png"]);
    }

    #[test]
    fn empty_folders_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let result = optimize_folder_inner(
            directory.path(),
            PngOptOutputMode::Separate,
            Some(output.path()),
            70,
            85,
            11,
            &token(),
            "op",
            &mut |_| {},
        );
        assert!(result.is_err());
    }

    fn entries(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}
