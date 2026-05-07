//! `ModuleBackend` trait — `module-contract.md` §3 の Rust 側契約。

use serde_json::Value as JsonValue;

use crate::error::AppError;

/// モジュール側エラー (`module-contract.md` §3.3)。
///
/// `into_app_error(module_id)` で `AppError` に変換され、IPC 越しのエラーコードに反映される
/// (`ValidationFailed` → `validation` / `UnknownPayloadVersion` →
/// `payload_upgrade_failed` 等)。`From<ModuleError> for AppError` だけでは module_id が
/// 分からないため、明示的に変換ヘルパを使う。
#[derive(Debug, thiserror::Error)]
pub enum ModuleError {
    #[error("validation failed: {reason}")]
    ValidationFailed { reason: String },

    #[error("unknown payload version: {0}")]
    UnknownPayloadVersion(u32),

    #[error("payload upgrade failed: {reason}")]
    UpgradeFailed { reason: String },

    #[error("module internal error: {0}")]
    Internal(String),
}

impl ModuleError {
    /// `ModuleError` を `AppError` に変換する (module_id 付与)。
    /// 呼び出し側 (StorageService / Tauri command) が module_id を知っている前提。
    pub fn into_app_error(self, module_id: &str) -> AppError {
        match self {
            ModuleError::ValidationFailed { reason } => AppError::Validation {
                module_id: module_id.to_string(),
                reason,
            },
            ModuleError::UnknownPayloadVersion(v) => AppError::PayloadUpgradeFailed {
                module_id: module_id.to_string(),
                reason: format!("unknown payload version: {v}"),
            },
            ModuleError::UpgradeFailed { reason } => AppError::PayloadUpgradeFailed {
                module_id: module_id.to_string(),
                reason,
            },
            ModuleError::Internal(msg) => AppError::Internal(format!("[{module_id}] {msg}")),
        }
    }
}

/// すべてのモジュールバックエンドが実装する trait (`module-contract.md` §3.1)。
///
/// `is_stateless: true` のモジュール (M-Hash / D-06) は `validate_payload` /
/// `index_text` / `upgrade_payload` をデフォルト実装のまま使える (StorageService から
/// 呼ばれないため)。永続データを持つモジュールは少なくとも `validate_payload` /
/// `index_text` を override する必要がある。
pub trait ModuleBackend: Send + Sync {
    /// モジュール識別子 (`module-contract.md` §3.2 `id()`)。英小文字 / 数字のみ、3〜32 文字。
    /// `items.module_id` / Tauri コマンド prefix `<id>_*` / settings 名前空間 `modules.<id>.*`
    /// で使われる。一度公開した id は変更不可。
    fn id(&self) -> &'static str;

    /// このモジュールが永続データを持たないか (D-06)。
    /// `true` の場合: items テーブルへの書き込み API は呼ばれない / エクスポート対象から除外
    /// される / 横断検索の対象から除外される (`module-contract.md` §9.2)。
    fn is_stateless(&self) -> bool {
        false
    }

    /// 現在書き込む payload のスキーマバージョン (単調増加の整数)。
    fn current_payload_version(&self) -> u32 {
        1
    }

    /// 古い payload を 1 段階アップグレードする (`module-contract.md` §7)。
    /// `from_version` は payload が書かれた時のバージョン。戻り値は `from_version + 1` の payload。
    /// `from_version == current_payload_version()` の場合は呼ばれない。
    /// **冪等であること** (同じ from_version + payload の組から常に同じ結果)。
    fn upgrade_payload(
        &self,
        from_version: u32,
        _payload: JsonValue,
    ) -> Result<JsonValue, ModuleError> {
        Err(ModuleError::UnknownPayloadVersion(from_version))
    }

    /// payload の構造的妥当性を検証する (`module-contract.md` §3.2)。
    /// **副作用禁止** (DB / ファイル / 時刻に依存しない)。失敗理由は
    /// `ModuleError::ValidationFailed { reason }` の reason に詳細を含めて呼び出し側で
    /// ログ集約する。
    fn validate_payload(&self, _payload: &JsonValue) -> Result<(), ModuleError> {
        Ok(())
    }

    /// FTS5 検索インデックスに投入する文字列を生成する (`module-contract.md` §3.2)。
    /// **純粋関数**。title / tags は呼び出し側 (StorageService) が共通カラムから取り出して
    /// 結合するため、本メソッドでは payload 由来の固有情報のみを返す。
    fn index_text(&self, _payload: &JsonValue) -> String {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn into_app_error_maps_validation_failed() {
        let me = ModuleError::ValidationFailed {
            reason: "title is empty".into(),
        };
        let app_err = me.into_app_error("prompt");
        match app_err {
            AppError::Validation { module_id, reason } => {
                assert_eq!(module_id, "prompt");
                assert_eq!(reason, "title is empty");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn into_app_error_maps_unknown_payload_version() {
        let me = ModuleError::UnknownPayloadVersion(7);
        let app_err = me.into_app_error("linkmemo");
        match app_err {
            AppError::PayloadUpgradeFailed { module_id, reason } => {
                assert_eq!(module_id, "linkmemo");
                assert!(reason.contains('7'));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn into_app_error_maps_upgrade_failed() {
        let me = ModuleError::UpgradeFailed {
            reason: "missing field 'body'".into(),
        };
        let app_err = me.into_app_error("prompt");
        match app_err {
            AppError::PayloadUpgradeFailed { module_id, reason } => {
                assert_eq!(module_id, "prompt");
                assert!(reason.contains("body"));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn into_app_error_internal_prepends_module_id() {
        let me = ModuleError::Internal("something broke".into());
        let app_err = me.into_app_error("color");
        match app_err {
            AppError::Internal(msg) => {
                assert!(msg.contains("[color]"));
                assert!(msg.contains("something broke"));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
}
