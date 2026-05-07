//! `ModuleBackend` trait — `module-contract.md` §3 の Rust 側契約。
//!
//! Phase 1 着手時の最小実装。Q-22 PoC では `is_stateless: true` のモジュール (M-Hash) のみが
//! 利用するため、`upgrade_payload` / `validate_payload` / `index_text` はデフォルト実装で済む。
//! 後続で M-Prompt / M-LinkMemo / M-Color の本実装時に各モジュールが override する。

use serde_json::Value as JsonValue;

use crate::error::AppError;

/// モジュール側エラー (`module-contract.md` §3.3)。
///
/// Q-22 PoC では `Internal` のみ。本実装で `ValidationFailed` / `UnknownPayloadVersion` /
/// `UpgradeFailed` を追加する。
#[derive(Debug, thiserror::Error)]
pub enum ModuleError {
    #[error("module internal error: {0}")]
    Internal(String),
}

impl From<ModuleError> for AppError {
    fn from(value: ModuleError) -> Self {
        AppError::Internal(value.to_string())
    }
}

/// すべてのモジュールバックエンドが実装する trait。
///
/// 詳細は `docs/module-contract.md` §3 を参照。
pub trait ModuleBackend: Send + Sync {
    /// モジュール識別子 (英小文字 / 数字、3〜32 文字)。`items.module_id` /
    /// Tauri コマンド prefix `<id>_*` / settings 名前空間 `modules.<id>.*` で使われる。
    fn id(&self) -> &'static str;

    /// このモジュールが永続データを持たないか (D-06)。
    /// `true` の場合 ScopedStorage 経由の CRUD は呼ばれない。
    fn is_stateless(&self) -> bool {
        false
    }

    /// 現在書き込む payload のスキーマバージョン (単調増加)。
    fn current_payload_version(&self) -> u32 {
        1
    }

    /// 古い payload を 1 段階アップグレードする (`module-contract.md` §7)。
    /// Q-22 PoC ではどのモジュールも呼ばれない (M-Hash は items を持たない)。
    fn upgrade_payload(
        &self,
        from_version: u32,
        _payload: JsonValue,
    ) -> Result<JsonValue, ModuleError> {
        Err(ModuleError::Internal(format!(
            "unknown payload version: {from_version}"
        )))
    }

    /// payload の構造的妥当性を検証する (`module-contract.md` §3.2)。副作用禁止。
    fn validate_payload(&self, _payload: &JsonValue) -> Result<(), ModuleError> {
        Ok(())
    }

    /// FTS5 検索インデックスに投入する文字列を生成する (`module-contract.md` §3.2)。純粋関数。
    fn index_text(&self, _payload: &JsonValue) -> String {
        String::new()
    }
}
