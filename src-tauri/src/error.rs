//! アプリ共通エラー型 (`architecture.md` §10.1)。
//!
//! IPC 越しにフロントへ返すときは `{ "code": <snake_case>, "message": <string|object> }`
//! の形にシリアライズされる。フロントは `code` フィールドで分岐し、`message` は表示層で
//! 整形する (ADR-0009 §2.6 と整合)。

use thiserror::Error;

/// アプリ全体のエラー種別。新しい variant を追加する場合は serde tag 名 (snake_case) と
/// `#[error("...")]` の表示文を整合させること。
#[derive(Debug, Error, serde::Serialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum AppError {
    /// 操作がキャンセルされた (ADR-0009 §2.6)。`operation_id` は `core_cancel_operation`
    /// 経由で渡されたフロント発行 UUID。フロントは "cancelled" code を見て
    /// エラートーストを出さず「キャンセルされました」表示にする。
    #[error("operation cancelled: {operation_id}")]
    Cancelled { operation_id: String },

    /// `OperationRegistry::register` で同 ID が既存だった (ADR-0009 §2.6)。実装ミス想定。
    /// 共通フックが `prev_id cancel → 新 ID 生成` で正規化するため、UI には通常出ない。
    #[error("operation already exists: {operation_id}")]
    OperationAlreadyExists { operation_id: String },

    /// `tauri::async_runtime::spawn_blocking` の `JoinHandle::await` が返す `tauri::Error`
    /// (ADR-0009 §2.6 注: `tokio::task::JoinError` ではなく Tauri 独自のグローバルエラー型)。
    #[error("blocking task join failed: {0}")]
    JoinError(String),

    /// ステートレスモジュール (`is_stateless = true`) で StorageService の CRUD API を
    /// 呼ぼうとした (`module-contract.md` §5.1 / §9.2)。
    #[error("module {module_id} is stateless and does not support this operation")]
    StatelessModule { module_id: String },

    /// `module_id` で `AppState.modules` を引いたが見つからなかった。
    #[error("module not found: {module_id}")]
    ModuleNotFound { module_id: String },

    /// `item.payload_schema_version > module.current_payload_version()` の場合 (ADR-0009 §7.3)。
    /// 新版アプリで作ったデータを旧版アプリで開いたケース。
    #[error(
        "unsupported future payload version: module={module_id} item_version={item_version} current_version={current_version}"
    )]
    UnsupportedFuturePayloadVersion {
        module_id: String,
        item_version: u32,
        current_version: u32,
    },

    /// `ModuleBackend::upgrade_payload` が失敗した (ADR-0006 / `module-contract.md` §7.3)。
    #[error("payload upgrade failed for module {module_id}: {reason}")]
    PayloadUpgradeFailed { module_id: String, reason: String },

    /// `ModuleBackend::validate_payload` が拒否した。
    #[error("validation failed for module {module_id}: {reason}")]
    Validation { module_id: String, reason: String },

    /// 検索 / 一覧などで対象が見つからない。
    #[error("not found: {entity}={key}")]
    NotFound { entity: String, key: String },

    /// ファイル I/O (バックアップ取得 / リストア / ハッシュ計算等で発生)。
    #[error("I/O error: {0}")]
    Io(String),

    /// HTTP module の URL / TLS / timeout / response read error。
    #[error("network error: {0}")]
    Network(String),

    /// SQLite / StorageService 由来のエラー (`data-model.md` §13)。
    #[error("storage error: {0}")]
    Storage(String),

    /// 起動時の DB schema 検証で発覚した不整合 (将来バージョンの DB を旧アプリで開いた等)。
    /// `architecture.md` §9 / `data-model.md` §4 に従い、起動を停止しエラー画面を出す経路。
    #[error("unsupported db_schema_version: db has {db_version}, app expects {app_version}")]
    UnsupportedDbSchemaVersion { db_version: i64, app_version: i64 },

    /// それ以外の想定外エラー。これに分類されるものを増やしすぎないこと。
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        AppError::Storage(value.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(value: reqwest::Error) -> Self {
        AppError::Network(value.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        AppError::JoinError(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_serializes_with_code_field() {
        let e = AppError::Cancelled {
            operation_id: "abc-123".into(),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "cancelled");
        assert_eq!(json["message"]["operation_id"], "abc-123");
    }

    #[test]
    fn module_not_found_has_snake_case_code() {
        let e = AppError::ModuleNotFound {
            module_id: "prompt".into(),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "module_not_found");
    }

    #[test]
    fn unsupported_future_payload_version_includes_all_fields() {
        let e = AppError::UnsupportedFuturePayloadVersion {
            module_id: "linkmemo".into(),
            item_version: 5,
            current_version: 2,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "unsupported_future_payload_version");
        assert_eq!(json["message"]["module_id"], "linkmemo");
        assert_eq!(json["message"]["item_version"], 5);
        assert_eq!(json["message"]["current_version"], 2);
    }

    #[test]
    fn from_io_error_maps_to_io_variant() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let e: AppError = io.into();
        match e {
            AppError::Io(msg) => assert!(msg.contains("missing")),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn display_message_is_human_readable() {
        let e = AppError::StatelessModule {
            module_id: "hash".into(),
        };
        let s = format!("{e}");
        assert!(s.contains("hash"));
        assert!(s.contains("stateless"));
    }
}
