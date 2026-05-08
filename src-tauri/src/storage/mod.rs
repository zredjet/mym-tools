//! Storage 層 (`module-contract.md` §5.1 / `data-model.md` §6 / §13)。
//!
//! - `StorageService` trait: コア機能 (project / items / 検索) の境界
//! - `ScopedStorage`: モジュールにスコープされた items CRUD (PR-E で追加)
//! - `SqliteStorage`: rusqlite ベースの実装。writer mutex で書込みを直列化
//!   (`data-model.md` §13.7)
//! - `schema`: SQLite DDL の文字列定数 (CREATE TABLE / TRIGGER / INDEX)
//! - `types`: `Project` / `Item` / `SearchScope` 等のドメイン型
//!
//! ## モジュール経由の items CRUD
//!
//! `StorageService::scoped_for(module)` で `ScopedStorage` を取得し、その上で
//! `create_item` / `update_item` / `delete_item` / `get_item` / `list_items` を呼ぶ。
//! `ScopedStorage` 内で `module_id` を自動絞り込みするため、他モジュールの items に
//! アクセス不能 (`module-contract.md` §6.2)。`get_item` は ADR-0006 の Eager-on-Read
//! を発火する。

pub mod schema;
pub mod scoped;
pub mod sqlite;
pub mod types;

use std::sync::Arc;

use serde_json::Value as JsonValue;

use crate::error::AppError;
use crate::module::ModuleBackend;

pub use scoped::ScopedStorage;
pub use sqlite::SqliteStorage;
pub use types::{Item, ItemId, Project, ProjectId, SearchScope};

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

    // -------- ScopedStorage 取得 --------

    /// 指定モジュールにスコープされたストレージハンドルを返す
    /// (`module-contract.md` §5.1 / scoped.rs)。
    ///
    /// **`Arc<Self>` レシーバ**: `ScopedStorage` 内部で `Arc<dyn StorageService>` を
    /// clone 保持するため、`Arc<dyn StorageService>` または `Arc<SqliteStorage>` に
    /// 直接生やす形にしてある。`AppState.storage: Arc<dyn StorageService>` から呼べる。
    fn scoped_for(self: Arc<Self>, module: Arc<dyn ModuleBackend>) -> ScopedStorage;

    // -------- items CRUD (低レベル、`ScopedStorage` 経由で呼ぶ) --------
    //
    // これらは `ScopedStorage` から `module_id` 等を渡して呼ぶ低レベル API。
    // 通常は `ScopedStorage::create_item` などの上位 API を使う。

    /// items の新規作成。`data_revision` を **+1**。
    /// 引数が多いのは items テーブルのカラム数に対応するため意図的。
    #[allow(clippy::too_many_arguments)]
    fn create_item(
        &self,
        module_id: &str,
        project_id: &ProjectId,
        title: &str,
        tags: &[String],
        payload_schema_version: u32,
        payload: &JsonValue,
        search_text: &str,
    ) -> Result<ItemId, AppError>;

    /// items のユーザー編集更新。`data_revision` を **+1** (`data-model.md` §7.2)。
    /// 引数が多いのは items テーブルのカラム数に対応するため意図的。
    #[allow(clippy::too_many_arguments)]
    fn update_item(
        &self,
        module_id: &str,
        id: &ItemId,
        title: &str,
        tags: &[String],
        payload_schema_version: u32,
        payload: &JsonValue,
        search_text: &str,
    ) -> Result<(), AppError>;

    /// items の物理削除。`data_revision` を **+1**。
    fn delete_item(&self, module_id: &str, id: &ItemId) -> Result<(), AppError>;

    /// item を 1 件取得し、必要なら Eager-on-Read (ADR-0006 / `data-model.md` §7.2)
    /// で payload をアップグレードして返す。アップグレード時の UPDATE では
    /// `data_revision` を **増やさない** (ADR-0006 §2.2)。
    fn get_item_eager(
        &self,
        module_id: &str,
        id: &ItemId,
        module: &dyn ModuleBackend,
    ) -> Result<Item, AppError>;

    /// プロジェクト内のモジュール item を一覧取得 (Eager-on-Read を**発火させない**、
    /// `data-model.md` §7.2 注)。`updated_at DESC, id DESC` 順。
    fn list_items(
        &self,
        module_id: &str,
        project_id: &ProjectId,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError>;

    // -------- 検索 (`data-model.md` §8) --------

    /// 検索 API。`scope` で範囲を、`module_filter` で対象モジュール ID を絞る。
    ///
    /// **3 文字未満は LIKE フォールバック** (`data-model.md` §8.1 制限事項):
    /// trigram tokenizer は 3-gram のため 3 文字未満は MATCH しない。短い検索語は
    /// `items` テーブル直接の `LIKE '%query%'` で代替する (`title` / `tags` /
    /// `search_text` 対象、テーブル全スキャン)。
    ///
    /// `module_filter` が空 / None の場合は全モジュールが対象。
    fn search(
        &self,
        scope: &SearchScope,
        query: &str,
        module_filter: Option<&[String]>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError>;

    // -------- Meta --------

    /// `meta.data_revision` を返す (`data-model.md` §13.2)。バックアップ判定で使う。
    fn data_revision(&self) -> Result<i64, AppError>;
}
