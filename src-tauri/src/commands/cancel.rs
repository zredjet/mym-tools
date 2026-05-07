//! `core_cancel_operation` Tauri コマンド (ADR-0009 §2.1)。
//!
//! フロントの `useCancellableOperation` 共通フック (将来 PR で実装) からのみ呼ばれる想定。
//! `module-contract.md` §6.2 に従い、モジュール配下の UI から直接呼ぶことは禁止する。

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// 進行中のオペレーションをキャンセルする (ADR-0009 §2.1 / §2.2)。
///
/// **冪等**: 該当しない `operation_id` (typo / 完了済 / 未知) でも `Ok(())` を返す。
/// フロントの unmount cleanup や手動連打で安全。
///
/// # Arguments
/// - `operation_id`: フロント発行の UUID v4 (`crypto.randomUUID()` 由来)
#[tauri::command]
pub fn core_cancel_operation(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<(), AppError> {
    state.operations.cancel(&operation_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    // 注: `core_cancel_operation` は `tauri::State` を引数に取るため、ユニットテストで
    // 直接呼ぶには Tauri ランタイムが必要。代わりに内部ロジック (registry.cancel) を
    // 直接検証することで `core_cancel_operation` の実体動作をカバーする。
    use std::sync::Arc;

    use crate::operations::OperationRegistry;

    /// `core_cancel_operation` 関数のロジック (Tauri State 抜き)。
    /// `state.operations.cancel(&id)` を呼んで `Ok(())` を返すだけなので、
    /// 直接 `OperationRegistry::cancel` を呼ぶ統合動作で代替検証する。
    #[test]
    fn cancel_via_registry_is_idempotent_for_unknown_id() {
        let registry = Arc::new(OperationRegistry::new());
        registry.cancel("nonexistent-id");
        // panic / error なし、ID 数は 0 のまま
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn cancel_via_registry_marks_token_cancelled() {
        let registry = Arc::new(OperationRegistry::new());
        let token = registry.register("op-1".into()).unwrap();
        assert!(!token.is_cancelled());
        registry.cancel("op-1");
        assert!(token.is_cancelled());
    }
}
