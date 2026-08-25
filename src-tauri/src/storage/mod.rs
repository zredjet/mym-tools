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

pub mod bootstrap;
pub(crate) mod data_migrations;
pub mod schema;
pub mod scoped;
pub mod sqlite;
pub mod types;

use std::path::Path;
use std::sync::Arc;

use serde_json::Value as JsonValue;

use crate::error::AppError;
use crate::module::ModuleBackend;

pub use scoped::ScopedStorage;
pub use sqlite::SqliteStorage;
pub use types::{ImportOutcome, Item, ItemId, Project, ProjectId, SearchScope};

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

    /// プロジェクトの `position` 列を `ordered_ids` の順序で再付番する (D&D 並び替え)。
    ///
    /// **要件 (data-model.md §5)**:
    /// - `ordered_ids` には **既存全プロジェクトの ID が過不足なく含まれていなければならない**
    ///   (欠損 / 余分 / 未知 ID は `AppError::Validation` で reject)。これにより、
    ///   同時編集や stale state による予期せぬ position 上書きを防ぐ
    /// - 1 トランザクション内で全 UPDATE → コミット → `data_revision +1`
    /// - `position` は `0..ordered_ids.len() as i64 - 1` の連番
    fn reorder_projects(&self, ordered_ids: &[ProjectId]) -> Result<(), AppError>;

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
    /// `data-model.md` §7.2 注)。`ORDER BY position ASC, updated_at DESC, id DESC` 順。
    ///
    /// **未編集スコープ (全行 `position = 0`) はタイブレーカーで updated_at DESC が効く**
    /// (`data-model.md` §6.5)。reorder 後のスコープは 0..N-1 の連番により position が優先される。
    fn list_items(
        &self,
        module_id: &str,
        project_id: &ProjectId,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError>;

    /// `(project_id, module_id)` スコープ内の item を `ordered_ids` の順序で `position`
    /// 列に再付番する (`data-model.md` §6.5、D&D 並び替えの永続化)。
    ///
    /// **要件**:
    /// - `ordered_ids` は当該スコープの **全 item ID が過不足なく** 含まれていなければならない
    ///   (欠損 / 余分 / 未知 ID は `AppError::Validation` で reject、`reorder_projects` と同じ厳格性)
    /// - **二重ガード SQL**: ① SELECT で取得した集合と一致を検証、② UPDATE 句は
    ///   `WHERE id=? AND project_id=? AND module_id=?` の三条件で他スコープへの誤書き込みを物理的に防止
    /// - 1 トランザクション内で全 UPDATE → `data_revision +1`
    /// - `updated_at` は **触らない** (並び替えは「内容」変更ではないため、§6.5)
    fn reorder_items(
        &self,
        project_id: &ProjectId,
        module_id: &str,
        ordered_ids: &[ItemId],
    ) -> Result<(), AppError>;

    /// `(project_id, module_id)` スコープ内の `position` 列を **現在値順** で
    /// `ROW_NUMBER() - 1` (= `0..N-1`) に詰め直す (`data-model.md` §6.5 / §12.4 step 9)。
    ///
    /// **import 後の補正専用**: 投入された JSON の position と既存 item の position が
    /// 衝突する状況を解消するため、`apply_import` が末尾で呼ぶ。`reorder_items` と違い
    /// ordered_ids を受け取らず、現在の `(position, created_at, id)` 順をそのまま採用する
    /// (元 export の意図順序を可能な限り保つ)。
    ///
    /// - 1 トランザクション内で全 UPDATE → `data_revision +1`
    /// - `updated_at` は **触らない** (reorder_items と同じ)
    /// - スコープが空 (該当 item 無し) なら何もしない (data_revision も変えない)
    fn normalize_item_positions(
        &self,
        project_id: &ProjectId,
        module_id: &str,
    ) -> Result<(), AppError>;

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

    /// `meta.last_backup_revision` を返す (`data-model.md` §13.2 / ADR-0007 §2.2)。
    /// 種別を問わず最後に成功したバックアップ時点の `data_revision`。
    /// 未取得時は `0` を返す (初期値、`schema.rs` で INSERT 済み)。
    fn last_backup_revision(&self) -> Result<i64, AppError>;

    /// `meta.last_backup_revision` を更新する。バックアップ取得成功時に呼ぶ。
    /// **`data_revision` は増分しない** (`data-model.md` §13.2 / ADR-0007 §2.2)。
    fn set_last_backup_revision(&self, revision: i64) -> Result<(), AppError>;

    /// `meta.last_auto_backup_at` を返す (`data-model.md` §13.2 / ADR-0007 §2.2)。
    /// 直近の **auto** バックアップ取得時刻 (`JST_ISO8601`)。
    /// 未取得時は `None` を返す (内部の空文字 `""` は `None` に変換)。
    fn last_auto_backup_at(&self) -> Result<Option<String>, AppError>;

    /// `meta.last_auto_backup_at` を更新する。**auto バックアップ取得時のみ**呼ぶ
    /// (`data-model.md` §13.2 設計意図: pre-op / manual で 24 時間ゲートを巻き戻さない)。
    /// **`data_revision` は増分しない**。
    fn set_last_auto_backup_at(&self, ts: &str) -> Result<(), AppError>;

    // -------- バックアップ I/O (ADR-0007 §2.1 / `data-model.md` §13.1) --------

    /// SQLite Online Backup API (`rusqlite::backup`) を使い、現在の DB 内容を
    /// `dst_path` の SQLite ファイルに書き出す。WAL を含めた整合性のあるスナップショットが
    /// 得られる (単純なファイルコピー禁止 — `data-model.md` §2)。
    ///
    /// 取得中もアプリの読み書きは継続可能だが、本実装では writer mutex を握ったまま
    /// `Backup::run_to_completion` を回すため短時間 (~数百 ms〜数秒) のロックが入る。
    fn take_online_backup_to(&self, dst_path: &Path) -> Result<(), AppError>;

    /// SQLite Online Backup API でバックアップファイル `src_path` の内容を **現在の DB
    /// に書き戻す** (`data-model.md` §13.6 / ADR-0007 §2.4.2 ステップ 4)。
    ///
    /// 呼び出し前提:
    /// - `src_path` の整合性検証 (`PRAGMA integrity_check`) は呼び出し側で完了している
    /// - リストアの全体オーケストレーション (pre-restore 取得 / アプリ再起動) は
    ///   呼び出し側 (Tauri command / UI) の責務。本メソッドは Online Backup API の
    ///   **「読み書き」コア部分のみ**を担当
    ///
    /// 完了後の再起動はメソッド外で実施する (`data-model.md` §13.6 step 7)。
    fn restore_online_backup_from(&self, src_path: &Path) -> Result<(), AppError>;

    // -------- インポート (`data-model.md` §12) --------

    /// プロジェクトを **ID 指定で** INSERT する (Import 用、`data-model.md` §12.4)。
    ///
    /// - `id` が既存と衝突する場合は `ImportOutcome::Skipped` を返し書き込みは行わない
    /// - 新規 INSERT 成功時は `data_revision` を **+1**
    /// - `created_at` / `updated_at` / `position` は引数の値をそのまま使う
    ///   (時刻の再生成は行わない — エクスポート時の値を保存する意味があるため)
    ///
    /// 衝突は ID 単位の判定で、`name` の重複は許容する (`data-model.md` §3.3、§12.2)。
    fn import_project(&self, project: &Project) -> Result<ImportOutcome, AppError>;

    /// アイテムを **ID 指定で** INSERT する (Import 用、`data-model.md` §12.4)。
    ///
    /// - `id` が既存と衝突する場合は `ImportOutcome::Skipped` を返し書き込みは行わない
    /// - 新規 INSERT 成功時は `data_revision` を **+1**
    /// - `payload` は呼び出し前に **Eager-on-Read 相当のアップグレード + validate** を済ませた
    ///   状態であること (`data-model.md` §12.4 step 4-5)
    /// - `search_text` は同様にアップグレード後の payload で `index_text()` を実行した
    ///   結果を渡すこと (step 6)
    ///
    /// `project_id` が存在しない場合は FK 制約で失敗する (呼び出し側で project の投入順を
    /// 守る)。
    #[allow(clippy::too_many_arguments)]
    fn import_item(
        &self,
        id: &ItemId,
        project_id: &ProjectId,
        module_id: &str,
        title: &str,
        tags: &[String],
        payload_schema_version: u32,
        payload: &JsonValue,
        search_text: &str,
        position: i64,
        created_at: &str,
        updated_at: &str,
    ) -> Result<ImportOutcome, AppError>;
}
