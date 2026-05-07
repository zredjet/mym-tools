//! アプリ共通エラー型 (architecture.md §10.1)。
//!
//! Phase 1 着手時の最小実装。`AppError::Internal` のみで Q-22 PoC 用。
//! 後続で `Storage` / `Validation` / `Module(<id>)` / `Io` / `NotFound` 等の variant を
//! `module-contract.md` §3.3 の `ModuleError` と合わせて拡張する。

use thiserror::Error;

#[derive(Debug, Error, serde::Serialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum AppError {
    /// 想定外のエラー。CI / Phase 1 PoC 段階で使う仮 variant。
    #[error("internal error: {0}")]
    Internal(String),
}
