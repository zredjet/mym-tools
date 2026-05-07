//! Storage 層 (`module-contract.md` §5.1 / `data-model.md` §6 / §13)。
//!
//! - `StorageService` trait: コア機能 (project CRUD / 後続で item CRUD など) の境界
//! - `SqliteStorage`: rusqlite ベースの実装。writer mutex で書込みを直列化
//!   (`data-model.md` §13.7)
//! - `schema`: SQLite DDL の文字列定数 (CREATE TABLE / TRIGGER / INDEX)
//! - `types`: `Project` / `ProjectId` 等のドメイン型
//!
//! ## ScopedStorage は別 PR で追加予定
//!
//! 永続データを持つモジュール (M-Color / M-LinkMemo / M-Prompt) の本実装に入る PR で、
//! `module-contract.md` §5.1 の `ScopedStorage` (モジュール ID で自動絞り込み)
//! を `StorageService::scoped_for(module)` として追加する。本 PR は project 部分のみ。

pub mod schema;
pub mod sqlite;
pub mod types;

use crate::error::AppError;

pub use sqlite::SqliteStorage;
pub use types::{Project, ProjectId};

/// コアの永続化境界。`AppState.storage: Arc<dyn StorageService>` 経由で各 Tauri command が利用する。
///
/// すべて **同期 (`fn`、`async fn` でない)**: 内部で `rusqlite::Connection` を writer mutex
/// で握る。Tauri コマンド側は `tauri::async_runtime::spawn_blocking` でラップする
/// (ADR-0009 §2.3 R-1 / R-8)。
///
/// 変更時の注意:
/// - **メソッド追加は OK** (既存実装に default impl で済むなら)
/// - **メソッド削除 / シグネチャ変更は ADR**(`module-contract.md` §13.1 の精神)
pub trait StorageService: Send + Sync + std::fmt::Debug {
    // -------- Project CRUD --------

    /// 新規プロジェクトを作成する。`id` は UUID v4 で自動生成、`created_at` / `updated_at`
    /// は `time::now_jst_iso8601()` で現在 JST が入る (`data-model.md` §6.4)。
    /// `position` は既存 `MAX(position) + 1` で末尾追加 (UI 並び替えで上書き可)。
    fn create_project(&self, name: &str, description: Option<&str>) -> Result<Project, AppError>;

    /// 全プロジェクトを `position ASC, id DESC` 順で返す (UI 一覧用)。
    fn list_projects(&self) -> Result<Vec<Project>, AppError>;

    /// `id` で 1 件取得。見つからなければ `AppError::NotFound`。
    fn get_project(&self, id: &ProjectId) -> Result<Project, AppError>;

    /// `id` のプロジェクトの `name` / `description` を更新する。
    /// `updated_at` は現在 JST に上書きされる。
    fn update_project(
        &self,
        id: &ProjectId,
        name: &str,
        description: Option<&str>,
    ) -> Result<(), AppError>;

    /// `id` のプロジェクトを物理削除する。配下の items は `ON DELETE CASCADE` で自動削除
    /// される (`data-model.md` §9.1)。
    fn delete_project(&self, id: &ProjectId) -> Result<(), AppError>;

    // -------- Meta --------

    /// `meta.data_revision` を返す (`data-model.md` §13.2)。バックアップ判定で使う。
    fn data_revision(&self) -> Result<i64, AppError>;
}
