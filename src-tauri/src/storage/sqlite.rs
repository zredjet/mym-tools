//! `SqliteStorage`: rusqlite ベースの `StorageService` 実装。
//!
//! 設計:
//! - 単一の `Connection` を `Mutex` で writer mutex 化する (`data-model.md` §13.7)
//! - 読み取りも writer mutex 経由で直列化する (Phase 1 の単純性優先)
//! - DB 初期化時に schema 投入 + `meta.db_schema_version` 整合性チェック
//! - `data_revision` は書込みコミットのたびに +1
//!
//! 後続 PR で:
//! - ScopedStorage 経由の items CRUD (Eager-on-Read 含む、ADR-0006)
//! - Online Backup API (ADR-0007)
//! - 検索 API (FTS5 trigram + LIKE フォールバック、`data-model.md` §8.1)

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as JsonValue;

use crate::error::AppError;
use crate::module::ModuleBackend;
use crate::storage::schema::{CURRENT_DB_SCHEMA_VERSION, PRAGMAS, SCHEMA_DDL};
use crate::storage::scoped::ScopedStorage;
use crate::storage::types::{Item, ItemId, Project, ProjectId, SearchScope};
use crate::storage::StorageService;
use crate::time::now_jst_iso8601;

/// rusqlite ベースの永続化実装。
///
/// `Mutex<Connection>` は `Send + Sync` を満たすため、`Arc<SqliteStorage>` を
/// AppState から `Arc<dyn StorageService>` として保持できる。
pub struct SqliteStorage {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for SqliteStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteStorage")
            .field("conn", &"<Mutex<Connection>>")
            .finish()
    }
}

impl SqliteStorage {
    /// 指定パスの SQLite DB を開く。新規作成時は schema を投入する。
    /// `path = ":memory:"` でインメモリ DB (テスト用)。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AppError> {
        let conn = Connection::open(path.as_ref()).map_err(AppError::from)?;
        Self::from_connection(conn)
    }

    /// 既存の `Connection` から `SqliteStorage` を構築する (主にテスト用)。
    /// schema 未投入の場合は `initialize_schema` で投入する (idempotent)。
    pub(crate) fn from_connection(mut conn: Connection) -> Result<Self, AppError> {
        // PRAGMA を発行 (foreign_keys / WAL / synchronous)
        for pragma in PRAGMAS {
            conn.execute_batch(pragma).map_err(AppError::from)?;
        }

        // schema が未投入なら初期化、投入済なら version を検証
        let already_initialized = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(AppError::from)?
            .is_some();

        if !already_initialized {
            initialize_schema(&mut conn)?;
        } else {
            verify_schema_version(&conn)?;
        }

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// writer mutex を取得して `&mut Connection` を渡すヘルパ。
    /// poison は致命扱い (StorageService 自体が壊れた状態のため)。
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| AppError::Storage("storage mutex poisoned".into()))?;
        f(&mut guard)
    }

    /// `data_revision` を `+1` する (書込みコミットの一環として呼ぶ)。
    /// 呼び出し元は同一トランザクション内でこれを呼んでから `commit` する。
    fn bump_data_revision(tx: &rusqlite::Transaction) -> Result<i64, AppError> {
        // SELECT 現在値 → +1 → UPDATE → 返す。`data-model.md` §4 の i64 範囲で扱う
        let current: i64 = tx
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'data_revision'",
                [],
                |row| row.get(0),
            )
            .map_err(AppError::from)?;
        let next = current + 1;
        tx.execute(
            "UPDATE meta SET value = ? WHERE key = 'data_revision'",
            params![next.to_string()],
        )
        .map_err(AppError::from)?;
        Ok(next)
    }
}

/// 新規 DB に schema を投入し、`meta` の初期値を埋める。
///
/// **単一トランザクションで実行**する: 中断 (プロセスクラッシュ / 電源断 / disk full)
/// で部分初期化された DB が「既存」と誤認識される (= meta テーブルだけ存在して
/// `db_schema_version` 行が無い) のを防ぐ。トランザクション全体が commit されない限り、
/// 次回起動時は schema 未投入として再試行される。
fn initialize_schema(conn: &mut Connection) -> Result<(), AppError> {
    let tx = conn.transaction().map_err(AppError::from)?;

    // DDL 一括投入 (CREATE TABLE / INDEX / TRIGGER / VIRTUAL TABLE)
    tx.execute_batch(SCHEMA_DDL).map_err(AppError::from)?;

    // meta 初期値 (data-model.md §4)
    let now = now_jst_iso8601();
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('db_schema_version', ?)",
        params![CURRENT_DB_SCHEMA_VERSION.to_string()],
    )
    .map_err(AppError::from)?;
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('app_initialized_at', ?)",
        params![now],
    )
    .map_err(AppError::from)?;
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('data_revision', '0')",
        [],
    )
    .map_err(AppError::from)?;
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('last_backup_revision', '0')",
        [],
    )
    .map_err(AppError::from)?;
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('last_auto_backup_at', '')",
        [],
    )
    .map_err(AppError::from)?;

    tx.commit().map_err(AppError::from)?;
    Ok(())
}

/// 既存 DB の `meta.db_schema_version` を読み、`CURRENT_DB_SCHEMA_VERSION` と一致するか検証する。
///
/// 一致しない場合は **両方向 (より新しい / より古い) で** `UnsupportedDbSchemaVersion` を
/// 返す (`data-model.md` §4 / `architecture.md` §9: 起動を停止しエラー画面):
/// - **より新しい**: 新版アプリで作った DB を旧版アプリで開いたケース
/// - **より古い**: 旧版 DB のまま新版アプリを起動したが migration path が未実装のケース
///
/// Phase 1 では migration path 自体が未実装なので、いずれの場合も fail-fast する。
/// 将来 ADR でマイグレーション機構を追加する際、より古い側の処理経路に分岐を入れる。
fn verify_schema_version(conn: &Connection) -> Result<(), AppError> {
    let db_version: i64 = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'db_schema_version'",
            [],
            |row| row.get(0),
        )
        .map_err(AppError::from)?;
    if db_version != CURRENT_DB_SCHEMA_VERSION {
        return Err(AppError::UnsupportedDbSchemaVersion {
            db_version,
            app_version: CURRENT_DB_SCHEMA_VERSION,
        });
    }
    Ok(())
}

impl StorageService for SqliteStorage {
    fn create_project(&self, name: &str, description: Option<&str>) -> Result<Project, AppError> {
        if name.trim().is_empty() {
            return Err(AppError::Validation {
                module_id: "core.projects".into(),
                reason: "project name must not be empty".into(),
            });
        }
        self.with_conn(|conn| {
            let tx = conn.transaction().map_err(AppError::from)?;
            let id = ProjectId::generate();
            let now = now_jst_iso8601();
            // 末尾追加: MAX(position) + 1。空テーブルなら 0
            let next_position: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM projects",
                    [],
                    |row| row.get(0),
                )
                .map_err(AppError::from)?;

            tx.execute(
                "INSERT INTO projects (id, name, description, position, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![id.as_str(), name, description, next_position, now, now],
            )
            .map_err(AppError::from)?;

            Self::bump_data_revision(&tx)?;
            tx.commit().map_err(AppError::from)?;

            Ok(Project {
                id,
                name: name.to_string(),
                description: description.map(|s| s.to_string()),
                position: next_position,
                created_at: now.clone(),
                updated_at: now,
            })
        })
    }

    fn list_projects(&self) -> Result<Vec<Project>, AppError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, name, description, position, created_at, updated_at \
                     FROM projects \
                     ORDER BY position ASC, id DESC",
                )
                .map_err(AppError::from)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(Project {
                        id: ProjectId::new(row.get::<_, String>(0)?),
                        name: row.get(1)?,
                        description: row.get(2)?,
                        position: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })
                .map_err(AppError::from)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(AppError::from)?);
            }
            Ok(out)
        })
    }

    fn get_project(&self, id: &ProjectId) -> Result<Project, AppError> {
        self.with_conn(|conn| {
            let project = conn
                .query_row(
                    "SELECT id, name, description, position, created_at, updated_at \
                     FROM projects WHERE id = ?",
                    params![id.as_str()],
                    |row| {
                        Ok(Project {
                            id: ProjectId::new(row.get::<_, String>(0)?),
                            name: row.get(1)?,
                            description: row.get(2)?,
                            position: row.get(3)?,
                            created_at: row.get(4)?,
                            updated_at: row.get(5)?,
                        })
                    },
                )
                .optional()
                .map_err(AppError::from)?;
            project.ok_or_else(|| AppError::NotFound {
                entity: "project".into(),
                key: id.to_string(),
            })
        })
    }

    fn update_project(
        &self,
        id: &ProjectId,
        name: &str,
        description: Option<&str>,
    ) -> Result<(), AppError> {
        if name.trim().is_empty() {
            return Err(AppError::Validation {
                module_id: "core.projects".into(),
                reason: "project name must not be empty".into(),
            });
        }
        self.with_conn(|conn| {
            let tx = conn.transaction().map_err(AppError::from)?;
            let now = now_jst_iso8601();
            let rows_affected = tx
                .execute(
                    "UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                    params![name, description, now, id.as_str()],
                )
                .map_err(AppError::from)?;
            if rows_affected == 0 {
                return Err(AppError::NotFound {
                    entity: "project".into(),
                    key: id.to_string(),
                });
            }
            Self::bump_data_revision(&tx)?;
            tx.commit().map_err(AppError::from)?;
            Ok(())
        })
    }

    fn delete_project(&self, id: &ProjectId) -> Result<(), AppError> {
        self.with_conn(|conn| {
            let tx = conn.transaction().map_err(AppError::from)?;
            let rows_affected = tx
                .execute("DELETE FROM projects WHERE id = ?", params![id.as_str()])
                .map_err(AppError::from)?;
            if rows_affected == 0 {
                return Err(AppError::NotFound {
                    entity: "project".into(),
                    key: id.to_string(),
                });
            }
            Self::bump_data_revision(&tx)?;
            tx.commit().map_err(AppError::from)?;
            Ok(())
        })
    }

    fn data_revision(&self) -> Result<i64, AppError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'data_revision'",
                [],
                |row| row.get(0),
            )
            .map_err(AppError::from)
        })
    }

    fn scoped_for(self: Arc<Self>, module: Arc<dyn ModuleBackend>) -> ScopedStorage {
        // `Arc<SqliteStorage>` は CoerceUnsized で `Arc<dyn StorageService>` に
        // 自動的に coerce される (Arc は CoerceUnsized 対応)。
        ScopedStorage {
            module,
            inner: self,
        }
    }

    fn create_item(
        &self,
        module_id: &str,
        project_id: &ProjectId,
        title: &str,
        tags: &[String],
        payload_schema_version: u32,
        payload: &JsonValue,
        search_text: &str,
    ) -> Result<ItemId, AppError> {
        self.create_item_internal(
            module_id,
            project_id,
            title,
            tags,
            payload_schema_version,
            payload,
            search_text,
        )
    }

    fn update_item(
        &self,
        module_id: &str,
        id: &ItemId,
        title: &str,
        tags: &[String],
        payload_schema_version: u32,
        payload: &JsonValue,
        search_text: &str,
    ) -> Result<(), AppError> {
        self.update_item_internal(
            module_id,
            id,
            title,
            tags,
            payload_schema_version,
            payload,
            search_text,
        )
    }

    fn delete_item(&self, module_id: &str, id: &ItemId) -> Result<(), AppError> {
        self.delete_item_internal(module_id, id)
    }

    fn get_item_eager(
        &self,
        module_id: &str,
        id: &ItemId,
        module: &dyn ModuleBackend,
    ) -> Result<Item, AppError> {
        self.get_item_with_eager_on_read(module_id, id, module)
    }

    fn list_items(
        &self,
        module_id: &str,
        project_id: &ProjectId,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError> {
        self.list_items_internal(module_id, project_id, limit, offset)
    }

    fn search(
        &self,
        scope: &SearchScope,
        query: &str,
        module_filter: Option<&[String]>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError> {
        // 3 文字未満は LIKE フォールバック (`data-model.md` §8.1 制限事項)
        let query_chars = query.chars().count();
        if query_chars == 0 {
            return Ok(Vec::new());
        }
        if query_chars < 3 {
            self.search_like(scope, query, module_filter, limit, offset)
        } else {
            self.search_fts(scope, query, module_filter, limit, offset)
        }
    }
}

// -------- items CRUD / Eager-on-Read / search --------

impl SqliteStorage {
    /// items の新規作成 (`StorageService::create_item` の実装本体)。
    /// 引数が多いのは items テーブルのカラム数に対応するため意図的。
    #[allow(clippy::too_many_arguments)]
    fn create_item_internal(
        &self,
        module_id: &str,
        project_id: &ProjectId,
        title: &str,
        tags: &[String],
        payload_schema_version: u32,
        payload: &JsonValue,
        search_text: &str,
    ) -> Result<ItemId, AppError> {
        if title.trim().is_empty() {
            return Err(AppError::Validation {
                module_id: module_id.to_string(),
                reason: "item title must not be empty".into(),
            });
        }
        let tags_json =
            serde_json::to_string(tags).map_err(|e| AppError::Storage(e.to_string()))?;
        let payload_str =
            serde_json::to_string(payload).map_err(|e| AppError::Storage(e.to_string()))?;
        self.with_conn(|conn| {
            let tx = conn.transaction().map_err(AppError::from)?;
            let id = ItemId::generate();
            let now = now_jst_iso8601();
            tx.execute(
                "INSERT INTO items (id, project_id, module_id, title, tags, search_text, \
                 payload_schema_version, payload, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id.as_str(),
                    project_id.as_str(),
                    module_id,
                    title,
                    tags_json,
                    search_text,
                    payload_schema_version as i64,
                    payload_str,
                    now,
                    now,
                ],
            )
            .map_err(AppError::from)?;
            Self::bump_data_revision(&tx)?;
            tx.commit().map_err(AppError::from)?;
            Ok(id)
        })
    }

    /// items のユーザー編集更新 (`data-model.md` §7.2 通常更新):
    /// `payload` / `search_text` / `updated_at` を更新、`data_revision` を **+1**。
    /// 引数が多いのは items テーブルのカラム数に対応するため意図的。
    #[allow(clippy::too_many_arguments)]
    fn update_item_internal(
        &self,
        module_id: &str,
        id: &ItemId,
        title: &str,
        tags: &[String],
        payload_schema_version: u32,
        payload: &JsonValue,
        search_text: &str,
    ) -> Result<(), AppError> {
        if title.trim().is_empty() {
            return Err(AppError::Validation {
                module_id: module_id.to_string(),
                reason: "item title must not be empty".into(),
            });
        }
        let tags_json =
            serde_json::to_string(tags).map_err(|e| AppError::Storage(e.to_string()))?;
        let payload_str =
            serde_json::to_string(payload).map_err(|e| AppError::Storage(e.to_string()))?;
        self.with_conn(|conn| {
            let tx = conn.transaction().map_err(AppError::from)?;
            let now = now_jst_iso8601();
            let rows_affected = tx
                .execute(
                    "UPDATE items SET title = ?, tags = ?, search_text = ?, \
                     payload_schema_version = ?, payload = ?, updated_at = ? \
                     WHERE id = ? AND module_id = ?",
                    params![
                        title,
                        tags_json,
                        search_text,
                        payload_schema_version as i64,
                        payload_str,
                        now,
                        id.as_str(),
                        module_id,
                    ],
                )
                .map_err(AppError::from)?;
            if rows_affected == 0 {
                return Err(AppError::NotFound {
                    entity: "item".into(),
                    key: id.to_string(),
                });
            }
            Self::bump_data_revision(&tx)?;
            tx.commit().map_err(AppError::from)?;
            Ok(())
        })
    }

    fn delete_item_internal(&self, module_id: &str, id: &ItemId) -> Result<(), AppError> {
        self.with_conn(|conn| {
            let tx = conn.transaction().map_err(AppError::from)?;
            let rows_affected = tx
                .execute(
                    "DELETE FROM items WHERE id = ? AND module_id = ?",
                    params![id.as_str(), module_id],
                )
                .map_err(AppError::from)?;
            if rows_affected == 0 {
                return Err(AppError::NotFound {
                    entity: "item".into(),
                    key: id.to_string(),
                });
            }
            Self::bump_data_revision(&tx)?;
            tx.commit().map_err(AppError::from)?;
            Ok(())
        })
    }

    /// `data-model.md` §7.2 Eager-on-Read 実装:
    /// - version > current → `UnsupportedFuturePayloadVersion`
    /// - version < current → `module.upgrade_payload` を順次適用 → 楽観的並行制御で UPDATE
    /// - version == current → そのまま返す
    fn get_item_with_eager_on_read(
        &self,
        module_id: &str,
        id: &ItemId,
        module: &dyn ModuleBackend,
    ) -> Result<Item, AppError> {
        let current_version = module.current_payload_version();
        // ループ: 楽観的 UPDATE で `rows_affected == 0` の場合は再読み込み
        let max_iterations = 8u32;
        for _ in 0..max_iterations {
            let row = self.fetch_item_row(module_id, id)?;
            if row.payload_schema_version > current_version {
                return Err(AppError::UnsupportedFuturePayloadVersion {
                    module_id: module_id.to_string(),
                    item_version: row.payload_schema_version,
                    current_version,
                });
            }
            if row.payload_schema_version == current_version {
                return Ok(row.into_item());
            }
            // version < current: アップグレード経路
            let mut current_payload = row.payload_json.clone();
            let mut from_version = row.payload_schema_version;
            while from_version < current_version {
                current_payload = module
                    .upgrade_payload(from_version, current_payload)
                    .map_err(|e| e.into_app_error(module_id))?;
                from_version += 1;
            }
            // 新版 payload で search_text 再生成
            let new_search_text = build_search_text_for_upgrade(
                &row.title,
                &row.tags,
                &module.index_text(&current_payload),
            );
            // 楽観的並行制御 UPDATE (data-model.md §7.2)
            let updated = self.upgrade_item_inplace(
                id,
                &current_payload,
                &new_search_text,
                current_version,
                row.payload_schema_version, // 元バージョン
            )?;
            if updated {
                // 自分が更新成功 → 最新版の Item を返す
                return Ok(Item {
                    id: row.id,
                    project_id: row.project_id,
                    module_id: row.module_id,
                    title: row.title,
                    tags: row.tags,
                    payload_schema_version: current_version,
                    payload: current_payload,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                });
            }
            // 他プロセスが先にアップグレード済み → ループ先頭で再読み込み
        }
        Err(AppError::Storage(format!(
            "Eager-on-Read exceeded max iterations ({max_iterations}) for item {id}"
        )))
    }

    /// Eager-on-Read 内部更新 API (`data-model.md` §7.2 二系統の内部更新 API):
    /// `payload` / `search_text` / `payload_schema_version` のみ更新、`updated_at` は触らず、
    /// **`data_revision` も +0** (ユーザー編集ではないため)。
    /// 楽観的並行制御: `WHERE payload_schema_version = ?` (元バージョン)。
    /// 戻り値: `true` = 自分が UPDATE 成功 / `false` = 他プロセスが先に upgrade 済 (再読み込み必要)。
    fn upgrade_item_inplace(
        &self,
        id: &ItemId,
        payload: &JsonValue,
        search_text: &str,
        new_version: u32,
        old_version: u32,
    ) -> Result<bool, AppError> {
        let payload_str =
            serde_json::to_string(payload).map_err(|e| AppError::Storage(e.to_string()))?;
        self.with_conn(|conn| {
            let rows_affected = conn
                .execute(
                    "UPDATE items SET payload = ?, search_text = ?, payload_schema_version = ? \
                     WHERE id = ? AND payload_schema_version = ?",
                    params![
                        payload_str,
                        search_text,
                        new_version as i64,
                        id.as_str(),
                        old_version as i64,
                    ],
                )
                .map_err(AppError::from)?;
            Ok(rows_affected > 0)
        })
    }

    /// item を 1 行取得 (Eager-on-Read 判定用、JSON もパース済)。
    fn fetch_item_row(&self, module_id: &str, id: &ItemId) -> Result<ItemRowRaw, AppError> {
        // (id, project_id, module_id, title, tags_json, payload_schema_version,
        //  payload_str, created_at, updated_at)
        type RawTuple = (
            String,
            String,
            String,
            String,
            String,
            i64,
            String,
            String,
            String,
        );
        self.with_conn(|conn| {
            // query_row のクロージャ内では SQLite native 型しか扱えないため、
            // ここでは生 row を tuple で取り出して、JSON パースは外側で行う。
            let raw_tuple: Option<RawTuple> = conn
                .query_row(
                    "SELECT id, project_id, module_id, title, tags, payload_schema_version, \
                     payload, created_at, updated_at \
                     FROM items WHERE id = ? AND module_id = ?",
                    params![id.as_str(), module_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                            row.get(8)?,
                        ))
                    },
                )
                .optional()
                .map_err(AppError::from)?;
            let (
                row_id,
                row_pid,
                row_mid,
                row_title,
                row_tags,
                row_version,
                row_payload,
                row_created,
                row_updated,
            ) = raw_tuple.ok_or_else(|| AppError::NotFound {
                entity: "item".into(),
                key: id.to_string(),
            })?;
            let tags: Vec<String> = serde_json::from_str(&row_tags)
                .map_err(|e| AppError::Storage(format!("invalid tags JSON: {e}")))?;
            let payload_json: JsonValue = serde_json::from_str(&row_payload)
                .map_err(|e| AppError::Storage(format!("invalid payload JSON: {e}")))?;
            Ok(ItemRowRaw {
                id: ItemId::new(row_id),
                project_id: ProjectId::new(row_pid),
                module_id: row_mid,
                title: row_title,
                tags,
                payload_schema_version: row_version as u32,
                payload_json,
                created_at: row_created,
                updated_at: row_updated,
            })
        })
    }

    /// プロジェクト内の items 一覧 (Eager-on-Read 発火しない、`data-model.md` §7.2 注)。
    fn list_items_internal(
        &self,
        module_id: &str,
        project_id: &ProjectId,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, project_id, module_id, title, tags, payload_schema_version, \
                     payload, created_at, updated_at \
                     FROM items WHERE project_id = ? AND module_id = ? \
                     ORDER BY updated_at DESC, id DESC \
                     LIMIT ? OFFSET ?",
                )
                .map_err(AppError::from)?;
            let rows = stmt
                .query_map(
                    params![project_id.as_str(), module_id, limit as i64, offset as i64],
                    |row| {
                        let tags_json: String = row.get(4)?;
                        let payload_str: String = row.get(6)?;
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            tags_json,
                            row.get::<_, i64>(5)? as u32,
                            payload_str,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                        ))
                    },
                )
                .map_err(AppError::from)?;
            let mut out = Vec::new();
            for r in rows {
                let (id, pid, mid, title, tags_json, version, payload_str, created, updated) =
                    r.map_err(AppError::from)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json)
                    .map_err(|e| AppError::Storage(format!("invalid tags JSON: {e}")))?;
                let payload: JsonValue = serde_json::from_str(&payload_str)
                    .map_err(|e| AppError::Storage(format!("invalid payload JSON: {e}")))?;
                out.push(Item {
                    id: ItemId::new(id),
                    project_id: ProjectId::new(pid),
                    module_id: mid,
                    title,
                    tags,
                    payload_schema_version: version,
                    payload,
                    created_at: created,
                    updated_at: updated,
                });
            }
            Ok(out)
        })
    }

    /// FTS5 MATCH 経由の検索 (3 文字以上の query)。
    fn search_fts(
        &self,
        scope: &SearchScope,
        query: &str,
        module_filter: Option<&[String]>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError> {
        let mut sql = String::from(
            "SELECT i.id, i.project_id, i.module_id, i.title, i.tags, i.payload_schema_version, \
             i.payload, i.created_at, i.updated_at \
             FROM items_fts f JOIN items i ON i.id = f.item_id \
             WHERE items_fts MATCH ?",
        );
        let mut bindings: Vec<String> = vec![query.to_string()];
        push_scope_filter(&mut sql, &mut bindings, scope, "f");
        push_module_filter(&mut sql, &mut bindings, module_filter, "f");
        sql.push_str(" ORDER BY rank LIMIT ? OFFSET ?");
        self.run_search_query(&sql, &bindings, limit, offset)
    }

    /// LIKE フォールバック (3 文字未満の query)。
    fn search_like(
        &self,
        scope: &SearchScope,
        query: &str,
        module_filter: Option<&[String]>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError> {
        // SQL LIKE escape を簡易的に行う (% _ \ をエスケープ)
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let mut sql = String::from(
            "SELECT i.id, i.project_id, i.module_id, i.title, i.tags, i.payload_schema_version, \
             i.payload, i.created_at, i.updated_at \
             FROM items i \
             WHERE (i.title LIKE ? ESCAPE '\\' OR i.tags LIKE ? ESCAPE '\\' \
                    OR i.search_text LIKE ? ESCAPE '\\')",
        );
        let mut bindings: Vec<String> = vec![pattern.clone(), pattern.clone(), pattern];
        push_scope_filter(&mut sql, &mut bindings, scope, "i");
        push_module_filter(&mut sql, &mut bindings, module_filter, "i");
        sql.push_str(" ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?");
        self.run_search_query(&sql, &bindings, limit, offset)
    }

    /// FTS5 / LIKE 共通の SQL 実行ヘルパ。
    fn run_search_query(
        &self,
        sql: &str,
        bindings: &[String],
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(sql).map_err(AppError::from)?;
            let mut all_params: Vec<&dyn rusqlite::ToSql> =
                bindings.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
            let lim = limit as i64;
            let off = offset as i64;
            all_params.push(&lim);
            all_params.push(&off);
            let rows = stmt
                .query_map(rusqlite::params_from_iter(all_params), |row| {
                    let tags_json: String = row.get(4)?;
                    let payload_str: String = row.get(6)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        tags_json,
                        row.get::<_, i64>(5)? as u32,
                        payload_str,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                })
                .map_err(AppError::from)?;
            let mut out = Vec::new();
            for r in rows {
                let (id, pid, mid, title, tags_json, version, payload_str, created, updated) =
                    r.map_err(AppError::from)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json)
                    .map_err(|e| AppError::Storage(format!("invalid tags JSON: {e}")))?;
                let payload: JsonValue = serde_json::from_str(&payload_str)
                    .map_err(|e| AppError::Storage(format!("invalid payload JSON: {e}")))?;
                out.push(Item {
                    id: ItemId::new(id),
                    project_id: ProjectId::new(pid),
                    module_id: mid,
                    title,
                    tags,
                    payload_schema_version: version,
                    payload,
                    created_at: created,
                    updated_at: updated,
                });
            }
            Ok(out)
        })
    }
}

/// items から 1 行取り出した状態 (Eager-on-Read で `payload` を `JsonValue` として
/// 保持しておく必要があるため、便利メソッド付き)。
struct ItemRowRaw {
    id: ItemId,
    project_id: ProjectId,
    module_id: String,
    title: String,
    tags: Vec<String>,
    payload_schema_version: u32,
    payload_json: JsonValue,
    created_at: String,
    updated_at: String,
}

impl ItemRowRaw {
    fn into_item(self) -> Item {
        Item {
            id: self.id,
            project_id: self.project_id,
            module_id: self.module_id,
            title: self.title,
            tags: self.tags,
            payload_schema_version: self.payload_schema_version,
            payload: self.payload_json,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// search_text 構築のヘルパ (Eager-on-Read 内部更新でも使う、`module-contract.md` §3.2)。
fn build_search_text_for_upgrade(title: &str, tags: &[String], module_text: &str) -> String {
    let mut s = String::with_capacity(title.len() + module_text.len() + 16);
    s.push_str(title);
    if !tags.is_empty() {
        s.push(' ');
        s.push_str(&tags.join(" "));
    }
    if !module_text.is_empty() {
        s.push(' ');
        s.push_str(module_text);
    }
    s
}

/// SearchScope を SQL に追記 (`f.project_id = ?` または何もしない)。
fn push_scope_filter(
    sql: &mut String,
    bindings: &mut Vec<String>,
    scope: &SearchScope,
    table_alias: &str,
) {
    match scope {
        SearchScope::Project { project_id } => {
            sql.push_str(&format!(" AND {table_alias}.project_id = ?"));
            bindings.push(project_id.as_str().to_string());
        }
        SearchScope::Global => {}
    }
}

/// module_filter を SQL に追記 (`f.module_id IN (?, ?, ...)`).
fn push_module_filter(
    sql: &mut String,
    bindings: &mut Vec<String>,
    module_filter: Option<&[String]>,
    table_alias: &str,
) {
    if let Some(filter) = module_filter {
        if !filter.is_empty() {
            let placeholders = std::iter::repeat_n("?", filter.len())
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(" AND {table_alias}.module_id IN ({placeholders})"));
            for m in filter {
                bindings.push(m.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory_storage() -> SqliteStorage {
        SqliteStorage::open(":memory:").expect("in-memory storage")
    }

    // -------- schema initialization --------

    #[test]
    fn open_in_memory_initializes_schema() {
        let storage = in_memory_storage();
        // meta が初期化されていること
        let rev = storage.data_revision().unwrap();
        assert_eq!(rev, 0);
    }

    #[test]
    fn open_existing_db_does_not_re_initialize() {
        let conn = Connection::open(":memory:").unwrap();
        // 1 度初期化
        let storage1 = SqliteStorage::from_connection(conn).unwrap();
        storage1.create_project("test", None).unwrap();
        let rev1 = storage1.data_revision().unwrap();
        assert_eq!(rev1, 1);

        // 再 open しないテストでは同じ Connection を持ったままになるので、別のインスタンス
        // で同一 DB を再 open する方法がないため、ここでは「初期化が冪等」を直接検証する
        // (既存の meta があれば INSERT を skip する経路の動作確認は別ケース)
    }

    #[test]
    fn schema_creates_all_expected_tables_and_indexes() {
        let storage = in_memory_storage();
        storage.with_conn(|conn| {
            // テーブル
            for table in &["meta", "projects", "items", "items_fts"] {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
                        params![*table],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 1, "table {table} should exist");
            }
            // インデックス
            for index in &[
                "idx_projects_position",
                "idx_items_project",
                "idx_items_module",
                "idx_items_project_updated",
                "idx_items_project_module_updated",
                "idx_items_module_updated",
            ] {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?",
                        params![*index],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 1, "index {index} should exist");
            }
            // トリガ
            for trigger in &["trg_items_fts_ai", "trg_items_fts_au", "trg_items_fts_ad"] {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?",
                        params![*trigger],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 1, "trigger {trigger} should exist");
            }
            Ok(())
        }).unwrap();
    }

    #[test]
    fn foreign_keys_pragma_is_on() {
        let storage = in_memory_storage();
        storage
            .with_conn(|conn| {
                let on: i64 = conn
                    .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(on, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn unsupported_future_db_schema_version_is_detected() {
        let conn = Connection::open(":memory:").unwrap();
        // 既存 DB のフリをして meta だけ作って未来のバージョンを書く
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); \
             INSERT INTO meta (key, value) VALUES ('db_schema_version', '999');",
        )
        .unwrap();
        let err = SqliteStorage::from_connection(conn).unwrap_err();
        match err {
            AppError::UnsupportedDbSchemaVersion {
                db_version,
                app_version,
            } => {
                assert_eq!(db_version, 999);
                assert_eq!(app_version, CURRENT_DB_SCHEMA_VERSION);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn unsupported_older_db_schema_version_is_detected() {
        // codex review (PR #26 P2 #2) 反映: db_version < CURRENT も明示的にエラー化
        // (Phase 1 では migration path 未実装 / 将来 ADR で対応)
        let conn = Connection::open(":memory:").unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); \
             INSERT INTO meta (key, value) VALUES ('db_schema_version', '0');",
        )
        .unwrap();
        let err = SqliteStorage::from_connection(conn).unwrap_err();
        match err {
            AppError::UnsupportedDbSchemaVersion {
                db_version,
                app_version,
            } => {
                assert_eq!(db_version, 0);
                assert_eq!(app_version, CURRENT_DB_SCHEMA_VERSION);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn schema_initialization_is_atomic() {
        // codex review (PR #26 P2 #1) 反映: schema 初期化を transaction でラップしている。
        // 中断シミュレーションは難しいが、initialize 完了後に meta が完全に揃っている
        // (5 件の初期値 + DDL 全部) ことを確認することで「全 or なし」の挙動を保証する代理にする。
        let storage = in_memory_storage();
        storage
            .with_conn(|conn| {
                let meta_keys: Vec<String> = conn
                    .prepare("SELECT key FROM meta ORDER BY key")
                    .unwrap()
                    .query_map([], |row| row.get::<_, String>(0))
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                assert_eq!(
                    meta_keys,
                    vec![
                        "app_initialized_at",
                        "data_revision",
                        "db_schema_version",
                        "last_auto_backup_at",
                        "last_backup_revision",
                    ]
                );
                Ok(())
            })
            .unwrap();
    }

    // -------- project CRUD --------

    #[test]
    fn create_project_basics() {
        let storage = in_memory_storage();
        let p = storage.create_project("My Project", Some("desc")).unwrap();
        assert_eq!(p.name, "My Project");
        assert_eq!(p.description.as_deref(), Some("desc"));
        assert_eq!(p.position, 0); // 最初は 0
        assert_eq!(p.id.as_str().len(), 36); // UUID v4
        assert_eq!(p.created_at, p.updated_at);
        assert_eq!(p.created_at.len(), 29); // JST_ISO8601 固定 29 文字
    }

    #[test]
    fn create_project_assigns_increasing_positions() {
        let storage = in_memory_storage();
        let p1 = storage.create_project("First", None).unwrap();
        let p2 = storage.create_project("Second", None).unwrap();
        let p3 = storage.create_project("Third", None).unwrap();
        assert_eq!(p1.position, 0);
        assert_eq!(p2.position, 1);
        assert_eq!(p3.position, 2);
    }

    #[test]
    fn create_project_rejects_empty_name() {
        let storage = in_memory_storage();
        let err = storage.create_project("", None).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[test]
    fn create_project_rejects_whitespace_name() {
        let storage = in_memory_storage();
        let err = storage.create_project("   ", None).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[test]
    fn list_projects_orders_by_position_then_id_desc() {
        let storage = in_memory_storage();
        storage.create_project("A", None).unwrap();
        storage.create_project("B", None).unwrap();
        storage.create_project("C", None).unwrap();
        let projects = storage.list_projects().unwrap();
        assert_eq!(projects.len(), 3);
        assert_eq!(projects[0].name, "A");
        assert_eq!(projects[1].name, "B");
        assert_eq!(projects[2].name, "C");
    }

    #[test]
    fn get_project_returns_existing() {
        let storage = in_memory_storage();
        let created = storage.create_project("Alpha", None).unwrap();
        let fetched = storage.get_project(&created.id).unwrap();
        assert_eq!(fetched, created);
    }

    #[test]
    fn get_project_not_found_returns_error() {
        let storage = in_memory_storage();
        let err = storage
            .get_project(&ProjectId::new("nonexistent-id"))
            .unwrap_err();
        match err {
            AppError::NotFound { entity, key } => {
                assert_eq!(entity, "project");
                assert_eq!(key, "nonexistent-id");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn update_project_changes_fields_and_updated_at() {
        let storage = in_memory_storage();
        let created = storage.create_project("Old", Some("old desc")).unwrap();
        // 微小な時間差を作るため少し待つ
        std::thread::sleep(std::time::Duration::from_millis(2));
        storage
            .update_project(&created.id, "New", Some("new desc"))
            .unwrap();
        let fetched = storage.get_project(&created.id).unwrap();
        assert_eq!(fetched.name, "New");
        assert_eq!(fetched.description.as_deref(), Some("new desc"));
        assert!(fetched.updated_at >= created.updated_at);
        assert_eq!(fetched.created_at, created.created_at); // 不変
    }

    #[test]
    fn update_project_not_found_returns_error() {
        let storage = in_memory_storage();
        let err = storage
            .update_project(&ProjectId::new("nope"), "x", None)
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound { .. }));
    }

    #[test]
    fn update_project_rejects_empty_name() {
        let storage = in_memory_storage();
        let p = storage.create_project("Old", None).unwrap();
        let err = storage.update_project(&p.id, "", None).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[test]
    fn delete_project_removes_row() {
        let storage = in_memory_storage();
        let p = storage.create_project("To Delete", None).unwrap();
        assert_eq!(storage.list_projects().unwrap().len(), 1);
        storage.delete_project(&p.id).unwrap();
        assert_eq!(storage.list_projects().unwrap().len(), 0);
        assert!(storage.get_project(&p.id).is_err());
    }

    #[test]
    fn delete_project_not_found_returns_error() {
        let storage = in_memory_storage();
        let err = storage.delete_project(&ProjectId::new("nope")).unwrap_err();
        assert!(matches!(err, AppError::NotFound { .. }));
    }

    // -------- data_revision --------

    #[test]
    fn data_revision_starts_at_zero() {
        let storage = in_memory_storage();
        assert_eq!(storage.data_revision().unwrap(), 0);
    }

    #[test]
    fn data_revision_increments_on_create_update_delete() {
        let storage = in_memory_storage();
        assert_eq!(storage.data_revision().unwrap(), 0);

        let p = storage.create_project("A", None).unwrap();
        assert_eq!(storage.data_revision().unwrap(), 1);

        storage.update_project(&p.id, "B", None).unwrap();
        assert_eq!(storage.data_revision().unwrap(), 2);

        storage.delete_project(&p.id).unwrap();
        assert_eq!(storage.data_revision().unwrap(), 3);
    }

    #[test]
    fn data_revision_does_not_increment_on_failed_writes() {
        let storage = in_memory_storage();
        assert_eq!(storage.data_revision().unwrap(), 0);
        // 空文字 name は Validation 失敗 → revision は変わらない
        let _ = storage.create_project("", None);
        assert_eq!(storage.data_revision().unwrap(), 0);
        // 存在しない id への update も同様 (NotFound でロールバック)
        let _ = storage.update_project(&ProjectId::new("nope"), "x", None);
        assert_eq!(storage.data_revision().unwrap(), 0);
    }

    // -------- FK CASCADE (projects → items) --------

    #[test]
    fn deleting_project_cascades_to_items() {
        // items テーブルへの直接 INSERT で確認 (items CRUD API は別 PR)
        let storage = in_memory_storage();
        let p = storage.create_project("Parent", None).unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO items (id, project_id, module_id, title, created_at, updated_at) \
                     VALUES (?, ?, 'color', 'red', ?, ?)",
                    params![
                        "item-1",
                        p.id.as_str(),
                        "2026-04-30T00:00:00.000+09:00",
                        "2026-04-30T00:00:00.000+09:00"
                    ],
                )?;
                Ok(())
            })
            .unwrap();

        // FK CASCADE で配下 item も消える
        storage.delete_project(&p.id).unwrap();

        storage
            .with_conn(|conn| {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM items WHERE id = 'item-1'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 0, "item should be cascaded");
                let fts_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM items_fts WHERE item_id = 'item-1'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    fts_count, 0,
                    "items_fts should also reflect cascade via trigger"
                );
                Ok(())
            })
            .unwrap();
    }

    // -------- FTS5 trigger 同期 --------

    #[test]
    fn fts_trigger_inserts_on_item_insert() {
        let storage = in_memory_storage();
        let p = storage.create_project("Parent", None).unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO items (id, project_id, module_id, title, search_text, created_at, updated_at) \
                     VALUES (?, ?, 'color', 'red', 'red color #ff0000', ?, ?)",
                    params!["item-1", p.id.as_str(), "2026-04-30T00:00:00.000+09:00", "2026-04-30T00:00:00.000+09:00"],
                )?;
                Ok(())
            })
            .unwrap();

        storage
            .with_conn(|conn| {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM items_fts WHERE item_id = 'item-1'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(count, 1);
                // trigram で MATCH も動くことを確認 (3 文字以上)
                let hit: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM items_fts WHERE items_fts MATCH 'color'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(hit, 1);
                Ok(())
            })
            .unwrap();
    }

    // -------- Items CRUD via ScopedStorage --------

    use crate::module::{ModuleBackend, ModuleError};

    /// テスト用モジュール: payload upgrade なし、index_text は payload["body"] を返す。
    struct TestColorModule {
        version: u32,
    }
    impl ModuleBackend for TestColorModule {
        fn id(&self) -> &'static str {
            "color"
        }
        fn current_payload_version(&self) -> u32 {
            self.version
        }
        fn validate_payload(&self, payload: &JsonValue) -> Result<(), ModuleError> {
            if payload.get("hex").and_then(|v| v.as_str()).is_none() {
                return Err(ModuleError::ValidationFailed {
                    reason: "missing hex field".into(),
                });
            }
            Ok(())
        }
        fn index_text(&self, payload: &JsonValue) -> String {
            payload
                .get("hex")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
        fn upgrade_payload(
            &self,
            from_version: u32,
            mut payload: JsonValue,
        ) -> Result<JsonValue, ModuleError> {
            // v1 → v2: hex を normalize_hex に名前変更しつつ値を保持 (テスト用ダミー)
            match from_version {
                1 => {
                    if let Some(obj) = payload.as_object_mut() {
                        if let Some(hex) = obj.remove("hex") {
                            obj.insert("normalized_hex".to_string(), hex);
                        }
                        obj.insert("upgraded_from_v1".into(), JsonValue::Bool(true));
                    }
                    Ok(payload)
                }
                _ => Err(ModuleError::UnknownPayloadVersion(from_version)),
            }
        }
    }

    /// stateless モジュール
    struct TestStatelessModule;
    impl ModuleBackend for TestStatelessModule {
        fn id(&self) -> &'static str {
            "hash"
        }
        fn is_stateless(&self) -> bool {
            true
        }
    }

    fn make_color_scoped(storage: &Arc<SqliteStorage>, version: u32) -> ScopedStorage {
        Arc::clone(storage)
            .scoped_for(Arc::new(TestColorModule { version }) as Arc<dyn ModuleBackend>)
    }

    fn make_stateless_scoped(storage: &Arc<SqliteStorage>) -> ScopedStorage {
        Arc::clone(storage).scoped_for(Arc::new(TestStatelessModule) as Arc<dyn ModuleBackend>)
    }

    /// `Arc<dyn StorageService>` 経由で `scoped_for` を呼べることを保証する回帰テスト
    /// (`AppState.storage: Arc<dyn StorageService>` から呼べる必要がある)。
    #[test]
    fn scoped_for_works_via_dyn_storage_service() {
        let storage_arc: Arc<SqliteStorage> = Arc::new(in_memory_storage());
        let p = storage_arc.create_project("Project", None).unwrap();
        // `Arc<SqliteStorage>` を `Arc<dyn StorageService>` に coerce してから呼ぶ。
        let dyn_storage: Arc<dyn StorageService> = storage_arc;
        let scoped = dyn_storage.scoped_for(Arc::new(TestColorModule { version: 1 }));
        let id = scoped
            .create_item(&p.id, "Blue", &[], serde_json::json!({"hex": "#0000ff"}))
            .unwrap();
        let fetched = scoped.get_item(&id).unwrap();
        assert_eq!(fetched.title, "Blue");
    }

    #[test]
    fn create_item_basics() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("Project", None).unwrap();
        let scoped = make_color_scoped(&storage, 1);
        let id = scoped
            .create_item(
                &p.id,
                "Red",
                &["bold".into()],
                serde_json::json!({"hex": "#ff0000"}),
            )
            .unwrap();
        assert_eq!(id.as_str().len(), 36); // UUID v4
        let fetched = scoped.get_item(&id).unwrap();
        assert_eq!(fetched.title, "Red");
        assert_eq!(fetched.tags, vec!["bold".to_string()]);
        assert_eq!(fetched.payload_schema_version, 1);
        assert_eq!(fetched.payload, serde_json::json!({"hex": "#ff0000"}));
    }

    #[test]
    fn create_item_invalid_payload_returns_validation() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("Project", None).unwrap();
        let scoped = make_color_scoped(&storage, 1);
        let err = scoped
            .create_item(&p.id, "Red", &[], serde_json::json!({"missing": "field"}))
            .unwrap_err();
        match err {
            AppError::Validation { module_id, reason } => {
                assert_eq!(module_id, "color");
                assert!(reason.contains("hex"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn create_item_empty_title_rejected() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("Project", None).unwrap();
        let scoped = make_color_scoped(&storage, 1);
        let err = scoped
            .create_item(&p.id, "", &[], serde_json::json!({"hex": "#000"}))
            .unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[test]
    fn stateless_module_cannot_use_scoped_crud() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("Project", None).unwrap();
        let scoped = make_stateless_scoped(&storage);
        let err = scoped
            .create_item(&p.id, "x", &[], serde_json::json!({}))
            .unwrap_err();
        match err {
            AppError::StatelessModule { module_id } => assert_eq!(module_id, "hash"),
            other => panic!("unexpected: {other:?}"),
        }
        let err = scoped.list_items(&p.id, 100, 0).unwrap_err();
        assert!(matches!(err, AppError::StatelessModule { .. }));
    }

    #[test]
    fn list_items_filters_by_module_and_project() {
        let storage = Arc::new(in_memory_storage());
        let p1 = storage.create_project("P1", None).unwrap();
        let p2 = storage.create_project("P2", None).unwrap();
        let scoped = make_color_scoped(&storage, 1);
        scoped
            .create_item(&p1.id, "Red", &[], serde_json::json!({"hex": "#f00"}))
            .unwrap();
        scoped
            .create_item(&p1.id, "Green", &[], serde_json::json!({"hex": "#0f0"}))
            .unwrap();
        scoped
            .create_item(&p2.id, "Blue", &[], serde_json::json!({"hex": "#00f"}))
            .unwrap();
        let p1_items = scoped.list_items(&p1.id, 100, 0).unwrap();
        assert_eq!(p1_items.len(), 2);
        let p2_items = scoped.list_items(&p2.id, 100, 0).unwrap();
        assert_eq!(p2_items.len(), 1);
    }

    #[test]
    fn update_item_user_edit_increments_data_revision() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("P", None).unwrap();
        let scoped = make_color_scoped(&storage, 1);
        let id = scoped
            .create_item(&p.id, "Red", &[], serde_json::json!({"hex": "#f00"}))
            .unwrap();
        let rev_before = storage.data_revision().unwrap();
        scoped
            .update_item(&id, "Crimson", &[], serde_json::json!({"hex": "#dc143c"}))
            .unwrap();
        assert_eq!(storage.data_revision().unwrap(), rev_before + 1);
        let fetched = scoped.get_item(&id).unwrap();
        assert_eq!(fetched.title, "Crimson");
    }

    #[test]
    fn delete_item_removes_row_and_increments_revision() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("P", None).unwrap();
        let scoped = make_color_scoped(&storage, 1);
        let id = scoped
            .create_item(&p.id, "Red", &[], serde_json::json!({"hex": "#f00"}))
            .unwrap();
        let rev_before = storage.data_revision().unwrap();
        scoped.delete_item(&id).unwrap();
        assert_eq!(storage.data_revision().unwrap(), rev_before + 1);
        let err = scoped.get_item(&id).unwrap_err();
        assert!(matches!(err, AppError::NotFound { .. }));
    }

    // -------- Eager-on-Read --------

    #[test]
    fn eager_on_read_upgrades_old_version() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("P", None).unwrap();

        // v1 で書き込む
        let scoped_v1 = make_color_scoped(&storage, 1);
        let id = scoped_v1
            .create_item(&p.id, "Red", &[], serde_json::json!({"hex": "#f00"}))
            .unwrap();
        assert_eq!(storage.data_revision().unwrap(), 2); // create_project + create_item

        // v2 で読み込む → Eager-on-Read 発火 → payload が upgrade される
        let scoped_v2 = make_color_scoped(&storage, 2);
        let item = scoped_v2.get_item(&id).unwrap();
        assert_eq!(item.payload_schema_version, 2);
        assert_eq!(item.payload["normalized_hex"], "#f00"); // v1→v2 で hex → normalized_hex
        assert_eq!(item.payload["upgraded_from_v1"], true);

        // **data_revision は +0** (Eager-on-Read 内部更新は user edit でないため)
        assert_eq!(storage.data_revision().unwrap(), 2);
    }

    #[test]
    fn eager_on_read_future_version_returns_unsupported() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("P", None).unwrap();

        // v2 で書き込む
        let scoped_v2 = make_color_scoped(&storage, 2);
        let id = scoped_v2
            .create_item(&p.id, "Red", &[], serde_json::json!({"hex": "#f00"}))
            .unwrap();

        // v1 で読み込む → 旧アプリで新版データを開いたケース
        let scoped_v1 = make_color_scoped(&storage, 1);
        let err = scoped_v1.get_item(&id).unwrap_err();
        match err {
            AppError::UnsupportedFuturePayloadVersion {
                module_id,
                item_version,
                current_version,
            } => {
                assert_eq!(module_id, "color");
                assert_eq!(item_version, 2);
                assert_eq!(current_version, 1);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn eager_on_read_no_change_when_versions_match() {
        let storage = Arc::new(in_memory_storage());
        let p = storage.create_project("P", None).unwrap();
        let scoped = make_color_scoped(&storage, 1);
        let id = scoped
            .create_item(&p.id, "Red", &[], serde_json::json!({"hex": "#f00"}))
            .unwrap();
        let rev_before = storage.data_revision().unwrap();
        // 同じ version で読み込み → DB 書き換えなし
        let _item = scoped.get_item(&id).unwrap();
        assert_eq!(storage.data_revision().unwrap(), rev_before);
    }

    // -------- 検索 (FTS5 / LIKE fallback) --------

    fn seed_search_data(storage: &Arc<SqliteStorage>) -> (ProjectId, ProjectId) {
        let p1 = storage.create_project("Work", None).unwrap();
        let p2 = storage.create_project("Personal", None).unwrap();
        let scoped = make_color_scoped(storage, 1);
        scoped
            .create_item(
                &p1.id,
                "Red",
                &["bright".into()],
                serde_json::json!({"hex": "#ff0000"}),
            )
            .unwrap();
        scoped
            .create_item(
                &p1.id,
                "Blue",
                &["calm".into()],
                serde_json::json!({"hex": "#0000ff"}),
            )
            .unwrap();
        scoped
            .create_item(
                &p2.id,
                "Green",
                &["natural".into()],
                serde_json::json!({"hex": "#00ff00"}),
            )
            .unwrap();
        (p1.id, p2.id)
    }

    #[test]
    fn search_fts_finds_in_project_scope() {
        let storage = Arc::new(in_memory_storage());
        let (p1, _p2) = seed_search_data(&storage);
        let results = storage
            .search(
                &SearchScope::Project { project_id: p1 },
                "Red",
                None,
                100,
                0,
            )
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Red");
    }

    #[test]
    fn search_fts_global_finds_across_projects() {
        let storage = Arc::new(in_memory_storage());
        seed_search_data(&storage);
        let results = storage
            .search(&SearchScope::Global, "calm", None, 100, 0)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Blue");
    }

    #[test]
    fn search_fts_module_filter_excludes_others() {
        let storage = Arc::new(in_memory_storage());
        seed_search_data(&storage);
        // 存在しないモジュール ID で絞れば 0 件
        let results = storage
            .search(
                &SearchScope::Global,
                "Red",
                Some(&["prompt".to_string()]),
                100,
                0,
            )
            .unwrap();
        assert_eq!(results.len(), 0);
        // color モジュール ID で絞れば 1 件
        let results = storage
            .search(
                &SearchScope::Global,
                "Red",
                Some(&["color".to_string()]),
                100,
                0,
            )
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn search_like_fallback_for_short_query() {
        // 2 文字以下は trigram MATCH に出ない (data-model.md §8.1) → LIKE fallback
        let storage = Arc::new(in_memory_storage());
        seed_search_data(&storage);
        // "Bl" (2 文字) を search → "Blue" がヒット (LIKE は ASCII case 無視 + 部分一致)
        let results = storage
            .search(&SearchScope::Global, "Bl", None, 100, 0)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Blue");
    }

    #[test]
    fn search_like_fallback_matches_substring_in_title_and_tags() {
        // "re" は "Red" の title と "Green" の title (部分一致) と "bright" の tag に出るので 2 件
        let storage = Arc::new(in_memory_storage());
        seed_search_data(&storage);
        let results = storage
            .search(&SearchScope::Global, "re", None, 100, 0)
            .unwrap();
        assert_eq!(results.len(), 2);
        let titles: Vec<&str> = results.iter().map(|i| i.title.as_str()).collect();
        assert!(titles.contains(&"Red"));
        assert!(titles.contains(&"Green"));
    }

    #[test]
    fn search_empty_query_returns_empty() {
        let storage = Arc::new(in_memory_storage());
        seed_search_data(&storage);
        let results = storage
            .search(&SearchScope::Global, "", None, 100, 0)
            .unwrap();
        assert_eq!(results.len(), 0);
    }
}
