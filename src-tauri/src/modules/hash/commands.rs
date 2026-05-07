//! M-Hash の Tauri コマンド (`module-contract.md` §12.4)。
//!
//! Q-22 PoC: `hash_compute_text` のみ。ファイルハッシュ (`hash_compute_file`) は
//! ADR-0009 のキャンセル機構と一緒に後続で追加する。

// `md-5` パッケージは内部 lib 名 `md5` で Md5 型を公開する (Cargo.toml の `md-5` は
// 旧 `md5` crate との衝突回避のためのパッケージ名で、import path は `md5`)。
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};

use crate::error::AppError;

/// 対応アルゴリズム。フロントは `&str` で渡す想定。
fn hash_text_inner(text: &str, algorithm: &str) -> Result<String, AppError> {
    match algorithm {
        "md5" => {
            let mut h = Md5::new();
            h.update(text.as_bytes());
            Ok(format!("{:x}", h.finalize()))
        }
        "sha1" => {
            let mut h = Sha1::new();
            h.update(text.as_bytes());
            Ok(format!("{:x}", h.finalize()))
        }
        "sha256" => {
            let mut h = Sha256::new();
            h.update(text.as_bytes());
            Ok(format!("{:x}", h.finalize()))
        }
        "sha512" => {
            let mut h = Sha512::new();
            h.update(text.as_bytes());
            Ok(format!("{:x}", h.finalize()))
        }
        other => Err(AppError::Internal(format!(
            "unsupported hash algorithm: {other}"
        ))),
    }
}

/// テキストのハッシュ値を計算する。
///
/// - `algorithm`: `"md5"` / `"sha1"` / `"sha256"` / `"sha512"` のいずれか
/// - 戻り値: 16 進小文字表現のハッシュ文字列
#[tauri::command]
pub fn hash_compute_text(text: String, algorithm: String) -> Result<String, AppError> {
    hash_text_inner(&text, &algorithm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string_known_hashes() {
        // RFC / 規格で示される空文字列のハッシュ値
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
    }

    #[test]
    fn ascii_known_hashes() {
        // "abc" のハッシュ値 (FIPS PUB 180-4 等)
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
        }
    }
}
