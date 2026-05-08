//! M-Hash の Tauri コマンド (`module-contract.md` §12.4)。
//!
//! - `hash_compute_text`: テキストハッシュ (Q-22 PoC で実装済)
//! - `hash_compute_file`: ファイルハッシュ + キャンセル機構 (ADR-0009 §2)
//!
//! ファイルハッシュは数秒〜分のオーダで掛かりうるため、ADR-0009 の規約に従い
//! `tauri::async_runtime::spawn_blocking` で逃がし、1 MB チャンクごとに
//! `CancellationToken::is_cancelled()` を確認して早期 return する。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use digest::DynDigest;
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::modules::hash::progress::HashFileProgress;
use crate::operations::OperationGuard;
#[cfg(test)]
use crate::operations::OperationRegistry;
use crate::state::AppState;

/// 1 MB (ADR-0009 §2.3 R-5: I/O 規定チャンクサイズ)。
const CHUNK_SIZE: usize = 1024 * 1024;

/// 対応アルゴリズム名から `Box<dyn DynDigest>` を生成する。
/// `digest::DynDigest` は object-safe で、`update` / `finalize_reset` を `&mut self` で持つ
/// ためアルゴリズム別の dyn dispatch に使える。
fn make_hasher(algorithm: &str) -> Result<Box<dyn DynDigest>, AppError> {
    match algorithm {
        "md5" => Ok(Box::new(Md5::new())),
        "sha1" => Ok(Box::new(Sha1::new())),
        "sha256" => Ok(Box::new(Sha256::new())),
        "sha512" => Ok(Box::new(Sha512::new())),
        other => Err(AppError::Internal(format!(
            "unsupported hash algorithm: {other}"
        ))),
    }
}

/// テキストのハッシュ値を計算する (Q-22 PoC)。
///
/// - `algorithm`: `"md5"` / `"sha1"` / `"sha256"` / `"sha512"` のいずれか
/// - 戻り値: 16 進小文字表現のハッシュ文字列
#[tauri::command]
pub fn hash_compute_text(text: String, algorithm: String) -> Result<String, AppError> {
    hash_text_inner(&text, &algorithm)
}

fn hash_text_inner(text: &str, algorithm: &str) -> Result<String, AppError> {
    let mut hasher = make_hasher(algorithm)?;
    hasher.update(text.as_bytes());
    Ok(hex_encode(&hasher.finalize_reset()))
}

/// ファイルのハッシュ値を計算する (ADR-0009 §2.1)。
///
/// `operation_id` (フロント発行 UUID v4) を `OperationRegistry` に登録し、
/// `tauri::async_runtime::spawn_blocking` の中で 1 MB チャンクごとに進捗 Channel に
/// 送信しつつ `CancellationToken` を確認する。フロントが `core_cancel_operation` を
/// 呼ぶとチャンク境界で早期 return し `AppError::Cancelled` を返す。
///
/// ## 進捗 Channel の挙動 (ADR-0009 §2.3 R-9 / R-10):
/// - 各チャンク完了後に `HashFileProgress::Progress { bytes_processed, total_bytes }` を 1 件送る
/// - 正常完了直前に `HashFileProgress::Done { duration_ms }` を 1 件送る
/// - キャンセル成立時に `HashFileProgress::Cancelled` を 1 件送って `Err(Cancelled)` を返す
/// - `Channel::send` の失敗は warn ログのみで継続 (フロントが既に Channel を drop した等)
#[tauri::command]
pub async fn hash_compute_file(
    state: State<'_, AppState>,
    operation_id: String,
    path: String,
    algorithm: String,
    on_progress: Channel<HashFileProgress>,
) -> Result<String, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    // RAII: 関数 Drop 時 (正常終了 / 早期 return / panic) にレジストリから ID を削除
    let _guard = OperationGuard::new(&registry, operation_id.clone());

    // R-1: 重い処理は spawn_blocking 経由のみ
    let id_for_blocking = operation_id.clone();
    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let mut progress_sink = make_channel_sink(on_progress, id_for_blocking.clone());
        hash_file_inner(
            Path::new(&path),
            &algorithm,
            &token,
            &mut progress_sink,
            &id_for_blocking,
        )
    })
    .await;

    // tauri::async_runtime::JoinHandle::await の戻りは Result<T, tauri::Error>
    // (ADR-0009 §2.6 注 / `From<tauri::Error> for AppError`)
    join_result.map_err(AppError::from)?
}

/// `Channel::send` を `FnMut(HashFileProgress)` に包んだ sink。`send` の失敗は warn ログ
/// に記録するだけで panic させない (ADR-0009 §2.3 R-9)。
fn make_channel_sink(
    channel: Channel<HashFileProgress>,
    operation_id: String,
) -> impl FnMut(HashFileProgress) {
    move |p| {
        if let Err(e) = channel.send(p) {
            tracing::warn!(
                operation_id = %operation_id,
                error = %e,
                "hash_compute_file progress channel send failed; continuing"
            );
        }
    }
}

/// ファイルハッシュ計算の本体 (テスト容易性のため `progress` は `&mut dyn FnMut` で
/// 抽象化、Tauri Channel に依存しない)。
///
/// **キャンセル確認のタイミング** (ADR-0009 §2.3 R-5 / R-10):
/// - 各チャンクの read 前 (= 1 MB ごと)
/// - 正常終了直前 (R-10: `Ok` 返却と `cancel()` のレース防止)
fn hash_file_inner(
    path: &Path,
    algorithm: &str,
    token: &CancellationToken,
    progress: &mut dyn FnMut(HashFileProgress),
    operation_id: &str,
) -> Result<String, AppError> {
    let started = Instant::now();
    let file = File::open(path).map_err(AppError::from)?;
    let total_bytes = file.metadata().map_err(AppError::from)?.len();
    let mut reader = BufReader::with_capacity(CHUNK_SIZE, file);
    let mut hasher = make_hasher(algorithm)?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut bytes_processed: u64 = 0;

    loop {
        // R-5: チャンク読み込み前に cancellation 確認 (1 MB 単位)
        if token.is_cancelled() {
            progress(HashFileProgress::Cancelled);
            return Err(AppError::Cancelled {
                operation_id: operation_id.to_string(),
            });
        }

        let n = reader.read(&mut buf).map_err(AppError::from)?;
        if n == 0 {
            break; // EOF
        }
        hasher.update(&buf[..n]);
        bytes_processed += n as u64;
        progress(HashFileProgress::Progress {
            bytes_processed,
            total_bytes,
        });
    }

    // R-10: Ok 直前にも最終確認 (チャンク完了直後にキャンセルが到達したケースを潰す)
    if token.is_cancelled() {
        progress(HashFileProgress::Cancelled);
        return Err(AppError::Cancelled {
            operation_id: operation_id.to_string(),
        });
    }

    let hex = hex_encode(&hasher.finalize());

    // R-9: 完了直前に Done を送信
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    progress(HashFileProgress::Done { duration_ms });
    Ok(hex)
}

/// バイト列を 16 進小文字表現に変換する (`hex` crate を増やさないための最小実装)。
fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(&mut s, "{b:02x}").expect("write to String never fails");
    }
    s
}

/// テスト専用: `OperationRegistry` を作って `hash_file_inner` を直接呼ぶためのヘルパ。
/// `AppState` / Tauri `State` を介さずキャンセル機構の動作検証ができる。
#[cfg(test)]
fn hash_file_for_test(
    path: &Path,
    algorithm: &str,
    operation_id: &str,
    progress: &mut dyn FnMut(HashFileProgress),
) -> (Arc<OperationRegistry>, Result<String, AppError>) {
    let registry = Arc::new(OperationRegistry::new());
    let token = registry.register(operation_id.to_string()).unwrap();
    let result = hash_file_inner(path, algorithm, &token, progress, operation_id);
    (registry, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // -------- hash_compute_text の既知ハッシュ値 --------
    // RFC / FIPS PUB 180-4 / RFC 1321 で定義される空文字列・"abc" のハッシュ値

    #[test]
    fn empty_string_known_hashes() {
        assert_eq!(
            hash_text_inner("", "md5").unwrap(),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(
            hash_text_inner("", "sha1").unwrap(),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        assert_eq!(
            hash_text_inner("", "sha256").unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hash_text_inner("", "sha512").unwrap(),
            "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
        );
    }

    #[test]
    fn ascii_known_hashes() {
        assert_eq!(
            hash_text_inner("abc", "md5").unwrap(),
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            hash_text_inner("abc", "sha1").unwrap(),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hash_text_inner("abc", "sha256").unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn unsupported_algorithm_returns_error() {
        let err = hash_text_inner("abc", "blake3").unwrap_err();
        match err {
            AppError::Internal(msg) => assert!(msg.contains("blake3")),
            other => panic!("expected Internal, got: {other:?}"),
        }
    }

    /// 指定バイト数の一時ファイルを作成し、TempDir と path を返す
    /// (TempDir が drop されるとディレクトリが削除されるため、テスト関数末尾まで保持)。
    fn write_temp_file(size: usize) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.bin");
        let mut f = File::create(&path).unwrap();
        let chunk_size = 64 * 1024;
        let mut buf = vec![0u8; chunk_size.min(size).max(1)];
        let mut written = 0;
        while written < size {
            let to_write = (size - written).min(buf.len());
            for (i, b) in buf.iter_mut().take(to_write).enumerate() {
                *b = ((written + i) % 251) as u8;
            }
            f.write_all(&buf[..to_write]).unwrap();
            written += to_write;
        }
        (dir, path)
    }

    // -------- hash_file_inner: 正常系 --------

    #[test]
    fn hash_file_empty_file_matches_empty_string_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        File::create(&path).unwrap();

        let mut events = Vec::new();
        let (_registry, result) = hash_file_for_test(&path, "sha256", "op-empty", &mut |p| {
            events.push(p);
        });
        let hex = result.unwrap();
        assert_eq!(
            hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert!(matches!(events.last(), Some(HashFileProgress::Done { .. })));
        // 空ファイルなので Progress は来ない (read で即 EOF)
        assert!(events
            .iter()
            .all(|e| !matches!(e, HashFileProgress::Progress { .. })));
    }

    #[test]
    fn hash_file_small_file_matches_text_hash() {
        // ファイル内容 "abc" → sha256 の既知値と一致
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc.bin");
        File::create(&path).unwrap().write_all(b"abc").unwrap();

        let mut events = Vec::new();
        let (_registry, result) = hash_file_for_test(&path, "sha256", "op-abc", &mut |p| {
            events.push(p);
        });
        assert_eq!(
            result.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // 3 バイト < 1 MB なので 1 チャンクで完了 → Progress 1 件 + Done 1 件
        let progress_count = events
            .iter()
            .filter(|e| matches!(e, HashFileProgress::Progress { .. }))
            .count();
        assert_eq!(progress_count, 1);
        assert!(matches!(events.last(), Some(HashFileProgress::Done { .. })));
    }

    #[test]
    fn hash_file_multi_chunk_progress_is_monotonic() {
        // 2.5 MB → 1 MB チャンク 3 回 + Done
        let size = 2 * CHUNK_SIZE + CHUNK_SIZE / 2;
        let (_dir, path) = write_temp_file(size);

        let mut events = Vec::new();
        let (_registry, result) = hash_file_for_test(&path, "md5", "op-multi", &mut |p| {
            events.push(p);
        });
        assert!(result.is_ok());

        let progress_pairs: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                HashFileProgress::Progress {
                    bytes_processed,
                    total_bytes,
                } => Some((*bytes_processed, *total_bytes)),
                _ => None,
            })
            .collect();
        assert_eq!(progress_pairs.len(), 3);
        // total_bytes は全 Progress で同一
        assert!(progress_pairs.iter().all(|(_, t)| *t == size as u64));
        // bytes_processed は単調増加
        assert!(progress_pairs[0].0 < progress_pairs[1].0);
        assert!(progress_pairs[1].0 < progress_pairs[2].0);
        // 最後の Progress で全バイト到達
        assert_eq!(progress_pairs[2].0, size as u64);
        assert!(matches!(events.last(), Some(HashFileProgress::Done { .. })));
    }

    // -------- hash_file_inner: キャンセル系 --------

    #[test]
    fn hash_file_cancellation_returns_cancelled_error() {
        // 4 MB ファイルに対し、計算開始前に token.cancel() →
        // 最初のチャンク先頭の `is_cancelled()` で必ず引っ掛かる
        let size = 4 * CHUNK_SIZE;
        let (_dir, path) = write_temp_file(size);

        let registry = Arc::new(OperationRegistry::new());
        let token = registry.register("op-cancel".into()).unwrap();
        token.cancel();

        let mut events = Vec::new();
        let result = hash_file_inner(&path, "sha1", &token, &mut |p| events.push(p), "op-cancel");

        match result {
            Err(AppError::Cancelled { operation_id }) => {
                assert_eq!(operation_id, "op-cancel");
            }
            other => panic!("expected Cancelled, got: {other:?}"),
        }
        // 最後の event は Cancelled (R-9)
        assert!(matches!(events.last(), Some(HashFileProgress::Cancelled)));
        // Done は送られない
        assert!(events
            .iter()
            .all(|e| !matches!(e, HashFileProgress::Done { .. })));
    }

    #[test]
    fn hash_file_token_cancelled_after_loop_triggers_r10_check() {
        // R-10: 全チャンク完了後・Ok 返却直前のキャンセル確認
        // 実装: 1 件目の Progress を受け取った瞬間に token.cancel() →
        // - 1 チャンクで EOF になるサイズなのでループは 1 回で抜け
        // - ループ末尾の R-10 チェックで Cancelled に変換される
        let (_dir, path) = write_temp_file(100); // < 1 MB
        let registry = Arc::new(OperationRegistry::new());
        let token = registry.register("op-r10".into()).unwrap();

        let token_for_sink = token.clone();
        let mut events = Vec::new();
        let mut sink = |p: HashFileProgress| {
            if matches!(p, HashFileProgress::Progress { .. }) {
                token_for_sink.cancel();
            }
            events.push(p);
        };
        let result = hash_file_inner(&path, "md5", &token, &mut sink, "op-r10");
        match result {
            Err(AppError::Cancelled { operation_id }) => assert_eq!(operation_id, "op-r10"),
            other => panic!("expected Cancelled (R-10), got: {other:?}"),
        }
        assert!(matches!(events.last(), Some(HashFileProgress::Cancelled)));
    }

    // -------- hash_file_inner: エラー系 --------

    #[test]
    fn hash_file_unsupported_algorithm_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.bin");
        File::create(&path).unwrap().write_all(b"x").unwrap();

        let mut events = Vec::new();
        let (_registry, result) = hash_file_for_test(&path, "blake3", "op-bad-algo", &mut |p| {
            events.push(p);
        });
        match result {
            Err(AppError::Internal(msg)) => assert!(msg.contains("blake3")),
            other => panic!("expected Internal, got: {other:?}"),
        }
    }

    #[test]
    fn hash_file_nonexistent_path_returns_io_error() {
        let mut events = Vec::new();
        let (_registry, result) = hash_file_for_test(
            Path::new("/nonexistent/path/that/does/not/exist.bin"),
            "sha256",
            "op-no-file",
            &mut |p| events.push(p),
        );
        match result {
            Err(AppError::Io(_)) => {}
            other => panic!("expected Io error, got: {other:?}"),
        }
    }

    // -------- ヘルパ関数 --------

    #[test]
    fn make_hasher_supported_algorithms_succeed() {
        for algo in &["md5", "sha1", "sha256", "sha512"] {
            let mut h = make_hasher(algo).unwrap();
            h.update(b"test");
            let _ = h.finalize_reset();
        }
    }

    #[test]
    fn hex_encode_lowercase_padded() {
        assert_eq!(hex_encode(&[0x00, 0x01, 0x0f, 0xff]), "00010fff");
        assert_eq!(hex_encode(&[]), "");
    }
}
