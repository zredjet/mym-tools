//! M-Link の Tauri コマンド (`module-contract.md` §12.2)。
//!
//! - `linkmemo_normalize_target`: 入力文字列を `(type, target)` に正規化。pure function
//!   なので Tauri ランタイム不要 (テストは `normalize` モジュールで完結)
//! - `linkmemo_open`: `type` (`url` / `path`) に応じて OS の既定アプリで `target` を開く。
//!   `tauri-plugin-opener` の `OpenerExt::opener()` 経由で OS API を叩く

use tauri_plugin_opener::OpenerExt;

use crate::error::AppError;
use crate::modules::linkmemo::normalize::{normalize_target, NormalizedTarget};

/// 入力文字列を `(type, target)` に正規化する (`module-contract.md` §12.2)。
///
/// pure function なので副作用なし / state 不要。フロントが `file://` URL を貼り付けた
/// ときの自動 path 化や、入力種別の自動判定 (URL or path) に使う。
#[tauri::command]
pub fn linkmemo_normalize_target(input: String) -> NormalizedTarget {
    normalize_target(&input)
}

/// `type` (`url` / `path`) に応じて OS の既定アプリで `target` を開く
/// (`module-contract.md` §12.2)。
///
/// - `url`: 既定ブラウザで `target` を開く (`http://` / `https://` のみ受理、
///   `file://` 等は事前に `linkmemo_normalize_target` で path 化されている前提)
/// - `path`: OS 既定ファイラー / 既定アプリで `target` を開く (Finder / Explorer)
#[tauri::command]
pub async fn linkmemo_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    item_type: String,
    target: String,
) -> Result<(), AppError> {
    match item_type.as_str() {
        "url" => {
            if !(target.starts_with("http://") || target.starts_with("https://")) {
                return Err(AppError::Validation {
                    module_id: "linkmemo".into(),
                    reason: format!(
                        "linkmemo_open type=url target must start with http(s)://: {target}"
                    ),
                });
            }
            app.opener()
                .open_url(target, None::<&str>)
                .map_err(|e| AppError::Internal(format!("opener.open_url failed: {e}")))?;
        }
        "path" => {
            if target.is_empty() {
                return Err(AppError::Validation {
                    module_id: "linkmemo".into(),
                    reason: "linkmemo_open type=path target must not be empty".into(),
                });
            }
            app.opener()
                .open_path(target, None::<&str>)
                .map_err(|e| AppError::Internal(format!("opener.open_path failed: {e}")))?;
        }
        other => {
            return Err(AppError::Validation {
                module_id: "linkmemo".into(),
                reason: format!("linkmemo_open: invalid type {other}"),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // `linkmemo_normalize_target` は pure function なので `normalize` モジュールで
    // 完全にテスト済 (出力 NormalizedTarget の振る舞いを直接検証している)。
    // ここでは Tauri command 経由で通る path だけをスモークテストとして残す
    // (Tauri State / AppHandle が要らない `linkmemo_normalize_target` のみ実行可能)。

    use super::*;

    #[test]
    fn normalize_target_command_returns_url_for_https_input() {
        let r = linkmemo_normalize_target("https://example.com".into());
        assert_eq!(r.type_, "url");
        assert_eq!(r.target, "https://example.com");
    }

    #[test]
    fn normalize_target_command_returns_path_for_file_url() {
        let r = linkmemo_normalize_target("file:///Users/x".into());
        assert_eq!(r.type_, "path");
        assert_eq!(r.target, "/Users/x");
    }

    // `linkmemo_open` は `tauri::AppHandle` が必要なため、ユニットテストでは
    // OS 既定アプリ起動経路は検証できない。バリデーションロジックは `linkmemo_open` 内の
    // 早期 return で網羅されており、結合テストは Phase 1 後半の手動検証で扱う。
}
