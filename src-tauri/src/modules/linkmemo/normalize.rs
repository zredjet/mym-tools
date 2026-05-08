//! `linkmemo_normalize_target` の純粋関数本体 (`module-contract.md` §12.2 /
//! `data-model.md` §10.2)。
//!
//! `file://` URL を path に変換し、入力文字列の type (`url` / `path`) を判定する。
//! Tauri / DB / OS API に依存しない pure function なのでユニットテストで完全に検証できる。

use serde::Serialize;

/// 正規化結果。`type_` は `serde` で `"type"` フィールドに rename される
/// (フロント側の TS interface は `{ type: "url" | "path", target: string }` に対応)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NormalizedTarget {
    #[serde(rename = "type")]
    pub type_: String,
    pub target: String,
}

/// 入力文字列を正規化して `NormalizedTarget` を返す (`data-model.md` §10.2 の
/// `file://` 処理を含む)。
///
/// **判定ルール**:
/// 1. `http://` / `https://` で始まる → `type=url, target=入力そのまま`
/// 2. `file://` で始まる → `type=path` に変換 (下記正規化)
/// 3. それ以外 → `type=path, target=入力そのまま` (ローカル / UNC パス想定)
///
/// **`file://` 正規化** (`data-model.md` §10.2):
/// - `file:///Users/x/folder` → `/Users/x/folder` (macOS / Linux: 三つ目のスラッシュ後を path)
/// - `file:///C:/Users/x/folder` → `C:\Users\x\folder` (Windows: forward slash を backslash 化)
/// - `file://server/share/dir` → `\\server\share\dir` (UNC: host 部を `\\` プレフィクス化)
///
/// 戻り値の `target` は trim されない (前後空白がそのまま残る)。trim はフロント側の責務。
pub fn normalize_target(input: &str) -> NormalizedTarget {
    if input.starts_with("http://") || input.starts_with("https://") {
        return NormalizedTarget {
            type_: "url".into(),
            target: input.to_string(),
        };
    }

    if let Some(rest) = input.strip_prefix("file://") {
        return NormalizedTarget {
            type_: "path".into(),
            target: normalize_file_url_path(rest),
        };
    }

    NormalizedTarget {
        type_: "path".into(),
        target: input.to_string(),
    }
}

/// `file://` を取り除いた残り部分を OS パスに変換する。
///
/// - 残りが `/` で始まる: macOS / Linux 形式 (`file:///Users/x` → `/Users/x`)
///   - ただし `/C:/...` のように `/` の後にドライブレターがあれば Windows path として扱い backslash 化
/// - それ以外 (`file://server/share/dir` 等): UNC パス (`\\server\share\dir`)
fn normalize_file_url_path(rest: &str) -> String {
    if let Some(after_slash) = rest.strip_prefix('/') {
        // `/C:/Users/x` 形式 (Windows file URL)
        if is_windows_drive_letter_prefix(after_slash) {
            return after_slash.replace('/', "\\");
        }
        // POSIX 形式: `/Users/x/folder` (先頭の `/` を残す)
        return format!("/{after_slash}");
    }
    // UNC: `server/share/dir` → `\\server\share\dir`
    let unc = rest.replace('/', "\\");
    format!("\\\\{unc}")
}

/// 文字列が `X:/...` のような Windows ドライブレター形式かを判定する。
fn is_windows_drive_letter_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_url_kept_as_url() {
        let r = normalize_target("http://example.com/foo");
        assert_eq!(r.type_, "url");
        assert_eq!(r.target, "http://example.com/foo");
    }

    #[test]
    fn https_url_kept_as_url() {
        let r = normalize_target("https://example.com/foo");
        assert_eq!(r.type_, "url");
        assert_eq!(r.target, "https://example.com/foo");
    }

    #[test]
    fn posix_file_url_normalizes_to_path() {
        let r = normalize_target("file:///Users/redjet/folder");
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "/Users/redjet/folder");
    }

    #[test]
    fn windows_file_url_normalizes_to_backslash_path() {
        let r = normalize_target("file:///C:/Users/foo/Bar");
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "C:\\Users\\foo\\Bar");
    }

    #[test]
    fn unc_file_url_normalizes_to_unc_path() {
        let r = normalize_target("file://server/share/dir");
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "\\\\server\\share\\dir");
    }

    #[test]
    fn plain_local_path_kept_as_path() {
        let r = normalize_target("/Users/redjet/folder");
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "/Users/redjet/folder");
    }

    #[test]
    fn windows_drive_path_kept_as_path() {
        let r = normalize_target("C:\\Users\\foo\\Bar");
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "C:\\Users\\foo\\Bar");
    }

    #[test]
    fn unc_backslash_path_kept_as_path() {
        let r = normalize_target("\\\\server\\share\\dir");
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "\\\\server\\share\\dir");
    }

    #[test]
    fn ftp_treated_as_path_not_url() {
        // 仕様上 url type は http/https のみ。ftp:// は path として残す
        let r = normalize_target("ftp://server/path");
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "ftp://server/path");
    }

    #[test]
    fn serializes_with_type_field() {
        let r = normalize_target("https://example.com");
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["type"], "url");
        assert_eq!(json["target"], "https://example.com");
    }
}
