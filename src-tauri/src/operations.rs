//! 操作レジストリとキャンセル機構 (ADR-0009 §2.2)。
//!
//! `OperationRegistry` は **アプリ全体で 1 つ**保持され、`AppState.operations` 経由で
//! 各 Tauri コマンドからアクセスする。長時間処理 (M-Hash 大ファイル / export / import /
//! FTS rebuild / restore) はコマンド先頭でフロント発行 `operationId` を `register` し、
//! `OperationGuard` (RAII) で関数 Drop 時に確実に `deregister` される。
//!
//! フロントは別コマンド `core_cancel_operation(operationId)` で `cancel` を呼ぶことで、
//! `spawn_blocking` 内のチャンクループが `token.is_cancelled()` を見て早期 return する
//! (ADR-0009 §2.3 規約 R-5 / R-10)。
//!
//! ## 規約サマリ (ADR-0009 §2.3 R-1〜R-10 の正典は ADR を参照)
//!
//! - R-1〜R-2: 重い処理は `tauri::async_runtime::spawn_blocking` 経由のみ。
//!   その他のスレッド生成 API (OS thread / 別 runtime / rayon 等) は禁止
//! - R-3〜R-4: blocking 内のネスト spawn / block_on 系は禁止
//! - R-5: I/O はチャンク (1 MB) ごと、CPU は最大 100 ms ごとに `token.is_cancelled()` 確認
//! - R-6: 進捗は `tauri::ipc::Channel<T>` で送る
//! - R-7: 戻り値型は `Result<T, AppError>`、`tauri::Error` は `?` で AppError::JoinError に集約
//! - R-8: ScopedStorage を呼んでよいが writer mutex は短時間で
//! - R-9: 完了 / キャンセル直前に最終状態を 1 件 send (send 失敗は warn ログのみ)
//! - R-10: `Ok(...)` 返却直前にも最終 `is_cancelled()` 確認

use std::collections::HashMap;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

use crate::error::AppError;

/// 操作レジストリ。`AppState.operations` で `Arc<Self>` として保持される。
#[derive(Default)]
pub struct OperationRegistry {
    /// `operation_id` (フロント発行 UUID v4) → `CancellationToken` の対応表。
    /// `std::sync::Mutex` を選ぶ理由: ロック区間は HashMap 操作のみ (μs オーダ) /
    /// await をまたいで保持しない / spawn_blocking からも安全に取得できる
    /// (ADR-0009 §2.2)。
    inner: Mutex<HashMap<String, CancellationToken>>,
}

impl OperationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 新規登録。同 ID が既存の場合は `AppError::OperationAlreadyExists` を返す
    /// (実装ミスの早期検出、ADR-0009 §2.2 / §5)。
    ///
    /// 通常運用では `crate::commands::cancel::OperationGuard` (RAII) で確実に
    /// `deregister` される。
    ///
    /// # Panics
    /// 内部 Mutex が poison していた場合に panic (ADR-0009 §2.2: 通常運用では理論上発生しない)。
    pub fn register(&self, id: String) -> Result<CancellationToken, AppError> {
        let mut map = self.inner.lock().expect("operation registry poisoned");
        if map.contains_key(&id) {
            return Err(AppError::OperationAlreadyExists { operation_id: id });
        }
        let token = CancellationToken::new();
        map.insert(id, token.clone());
        Ok(token)
    }

    /// キャンセル。該当 ID なし / 既に完了済みでも no-op で何も返さない
    /// (ADR-0009 §2 表: `core_cancel_operation` の冪等性。フロントが連打しても安全)。
    pub fn cancel(&self, id: &str) {
        if let Ok(map) = self.inner.lock() {
            if let Some(token) = map.get(id) {
                token.cancel();
            }
        }
        // poison 時はログのみ。Drop 中の panic 二重化を避けるため (ADR-0009 §2.2)
    }

    /// 削除。`OperationGuard::drop` から呼ばれる (RAII)。
    /// poison 時もログのみで panic させない (Drop 中 panic 二重化回避、ADR-0009 §2.2)。
    pub fn deregister(&self, id: &str) {
        match self.inner.lock() {
            Ok(mut map) => {
                map.remove(id);
            }
            Err(_) => {
                tracing::error!(
                    operation_id = %id,
                    "operation registry poisoned during deregister; leaking id"
                );
            }
        }
    }

    /// 現在登録されているオペレーション数 (主にテスト用)。
    pub fn len(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }

    /// `len() == 0` の便宜 (clippy::len_without_is_empty 抑止)。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl std::fmt::Debug for OperationRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n = self.len();
        f.debug_struct("OperationRegistry")
            .field("active_count", &n)
            .finish()
    }
}

/// RAII ガード。Tauri コマンドの先頭で生成し、関数 Drop 時 (正常終了 / 早期 return / panic)
/// に `OperationRegistry::deregister` を呼ぶ (ADR-0009 §2.1 (2) / §6.2 受入条件)。
pub struct OperationGuard<'a> {
    registry: &'a OperationRegistry,
    operation_id: String,
}

impl<'a> OperationGuard<'a> {
    /// `register` 直後にこの Guard を生成すれば deregister 漏れがない。
    /// `id` は呼び出し側 (Tauri コマンド) が `register(id.clone())` で渡した値の clone を入れる。
    pub fn new(registry: &'a OperationRegistry, operation_id: String) -> Self {
        Self {
            registry,
            operation_id,
        }
    }
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.registry.deregister(&self.operation_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_unique_id_succeeds() {
        let r = OperationRegistry::new();
        let token = r.register("op-1".into()).unwrap();
        assert!(!token.is_cancelled());
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn register_duplicate_id_returns_already_exists() {
        let r = OperationRegistry::new();
        let _t = r.register("op-1".into()).unwrap();
        let err = r.register("op-1".into()).unwrap_err();
        match err {
            AppError::OperationAlreadyExists { operation_id } => {
                assert_eq!(operation_id, "op-1");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn cancel_marks_token_cancelled() {
        let r = OperationRegistry::new();
        let token = r.register("op-1".into()).unwrap();
        assert!(!token.is_cancelled());
        r.cancel("op-1");
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancel_unknown_id_is_noop() {
        let r = OperationRegistry::new();
        // ADR-0009 §2 表: 該当 ID なしでも `Ok(())` (冪等性)
        r.cancel("nonexistent");
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn cancel_after_deregister_is_noop() {
        let r = OperationRegistry::new();
        let _ = r.register("op-1".into()).unwrap();
        r.deregister("op-1");
        // 完了済 ID への cancel も no-op (連打耐性)
        r.cancel("op-1");
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn deregister_removes_id() {
        let r = OperationRegistry::new();
        let _ = r.register("op-1".into()).unwrap();
        assert_eq!(r.len(), 1);
        r.deregister("op-1");
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn deregister_unknown_id_is_noop() {
        let r = OperationRegistry::new();
        r.deregister("nonexistent");
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn register_after_deregister_is_allowed() {
        let r = OperationRegistry::new();
        let _ = r.register("op-1".into()).unwrap();
        r.deregister("op-1");
        // 一度 deregister すれば同 ID で再 register できる
        let token = r.register("op-1".into()).unwrap();
        assert!(!token.is_cancelled());
    }

    #[test]
    fn operation_guard_drops_with_deregister() {
        let r = OperationRegistry::new();
        {
            let _t = r.register("op-1".into()).unwrap();
            let _guard = OperationGuard::new(&r, "op-1".into());
            assert_eq!(r.len(), 1);
        } // _guard drops here → deregister
        assert_eq!(r.len(), 0);
    }

    #[test]
    fn operation_guard_drops_during_panic_unwinding() {
        let r = OperationRegistry::new();

        // panic を catch_unwind でキャッチして deregister が呼ばれることを確認
        // (ADR-0009 §6.2 受入条件)
        let r_ref: &OperationRegistry = &r;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _t = r_ref.register("op-1".into()).unwrap();
            let _guard = OperationGuard::new(r_ref, "op-1".into());
            panic!("intentional");
        }));
        assert!(result.is_err());
        assert_eq!(r.len(), 0, "guard should deregister during unwind");
    }

    #[test]
    fn cancel_propagates_to_cloned_token() {
        // spawn_blocking 内で token.clone() を持って is_cancelled() を見る使い方の確認
        let r = OperationRegistry::new();
        let parent = r.register("op-1".into()).unwrap();
        let child = parent.clone();
        assert!(!child.is_cancelled());
        r.cancel("op-1");
        // clone は同じ内部状態を共有するので、片方を cancel すると両方 is_cancelled
        assert!(parent.is_cancelled());
        assert!(child.is_cancelled());
    }

    #[test]
    fn child_token_cancelled_when_parent_cancelled() {
        // ADR-0009 §4.1 / §7.1: child_token を export/import の per-item サブタスクで使う
        let r = OperationRegistry::new();
        let parent = r.register("op-1".into()).unwrap();
        let child1 = parent.child_token();
        let child2 = parent.child_token();
        r.cancel("op-1");
        assert!(child1.is_cancelled());
        assert!(child2.is_cancelled());
    }

    #[test]
    fn child_token_does_not_cancel_parent() {
        let r = OperationRegistry::new();
        let parent = r.register("op-1".into()).unwrap();
        let child = parent.child_token();
        child.cancel();
        // child キャンセルは parent に伝播しない
        assert!(!parent.is_cancelled());
    }
}
