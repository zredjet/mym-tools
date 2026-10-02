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
/// - `path`: OS 既定ファイラー / 既定アプリで `target` を開く (Finder / Explorer)。
///   ネットワーク上の場所は `allow_network_path = true` の時だけ開く (`check_path_target`)
///
/// エラーの文言は Link 画面にそのまま表示する。
#[tauri::command]
pub async fn linkmemo_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    item_type: String,
    target: String,
    allow_network_path: Option<bool>,
) -> Result<(), AppError> {
    match item_type.as_str() {
        "url" => {
            if !(target.starts_with("http://") || target.starts_with("https://")) {
                return Err(validation(format!(
                    "URL は http:// か https:// で始まる必要があります: {target}"
                )));
            }
            app.opener()
                .open_url(target, None::<&str>)
                .map_err(|e| AppError::Internal(format!("URL を開けませんでした: {e}")))?;
        }
        "path" => {
            check_path_target(&target, allow_network_path == Some(true))?;
            app.opener()
                .open_path(target.as_str(), None::<&str>)
                .map_err(|e| {
                    AppError::Internal(format!("パスを開けませんでした: {target} ({e})"))
                })?;
        }
        other => {
            return Err(validation(format!("Link の種類が不正です: {other}")));
        }
    }
    Ok(())
}

/// `type=path` の `target` を opener へ渡してよいか。
///
/// ネットワーク上の場所は、利用者が確かめた時 (確認せずに開くサーバに登録済みか、
/// 確認ダイアログで「開く」を選んだ時) だけ開く。Windows では opener の存在確認
/// (`metadata()`) の時点で SMB 接続が走り、サインイン情報 (NTLM 認証) がサーバへ送られる。
/// インポートした Link 1 クリックで外部のサーバへ送らないためで、判定と確認はフロントの
/// `networkTrust.ts` が行う。ここは確認を経ていない呼び出しを止める。
fn check_path_target(target: &str, allow_network_path: bool) -> Result<(), AppError> {
    if target.is_empty() {
        return Err(validation("パスが空です".into()));
    }
    if is_network_path(target) && !allow_network_path {
        return Err(validation(format!(
            "ネットワーク上の場所は、確認してから開きます: {target}"
        )));
    }
    Ok(())
}

/// ネットワーク上の場所になり得るパスか。前の空白は除いて判定する。
///
/// - 先頭 2 文字がどちらもパス区切り (`\` か `/`): UNC (`\\server\share` / `//server/share`) と、
///   Win32 の device path (`\\?\UNC\server\share` / `\\.\UNC\...` / `\\?\GLOBALROOT\...`)
/// - `\??\` で始まる: NT の object path (`\??\UNC\server\share`)。Win32 のパス変換がそのまま通す
fn is_network_path(target: &str) -> bool {
    let mut chars = target.trim_start().chars();
    matches!(
        (chars.next(), chars.next(), chars.next(), chars.next()),
        (Some('\\' | '/'), Some('\\' | '/'), _, _)
            | (Some('\\' | '/'), Some('?'), Some('?'), Some('\\' | '/'))
    )
}

fn validation(reason: String) -> AppError {
    AppError::Validation {
        module_id: "linkmemo".into(),
        reason,
    }
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

    #[test]
    fn network_paths_are_detected() {
        for path in [
            r"\\attacker\share\invoice.exe",
            "//attacker/share/invoice.exe",
            r"\\?\UNC\attacker\share",
            r"\\.\UNC\attacker\share",
            r"\\?\GLOBALROOT\Device\Mup\attacker\share",
            r"\??\UNC\attacker\share",
            "/??/UNC/attacker/share",
            r"\/attacker/share",
            "  //attacker/share",
        ] {
            assert!(is_network_path(path), "{path}");
        }
        for path in [
            "/Users/x/Documents",
            r"C:\Users\x\Documents",
            r"C:\??\x",
            "/?/x",
            "~/Documents",
            "relative/path",
            "",
        ] {
            assert!(!is_network_path(path), "{path}");
        }
    }

    #[test]
    fn network_paths_open_only_when_allowed() {
        let reason = |result: Result<(), AppError>| match result {
            Err(AppError::Validation { module_id, reason }) => {
                assert_eq!(module_id, "linkmemo");
                reason
            }
            other => panic!("expected validation error: {other:?}"),
        };
        assert_eq!(
            reason(check_path_target(r"\\nas\share", false)),
            r"ネットワーク上の場所は、確認してから開きます: \\nas\share"
        );
        assert!(check_path_target(r"\\nas\share", true).is_ok());
        assert!(check_path_target(r"C:\Users\x\Documents", false).is_ok());
        assert_eq!(reason(check_path_target("", true)), "パスが空です");
    }
}
