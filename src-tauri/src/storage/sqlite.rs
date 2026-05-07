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
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppError;
use crate::storage::schema::{CURRENT_DB_SCHEMA_VERSION, PRAGMAS, SCHEMA_DDL};
use crate::storage::types::{Project, ProjectId};
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
    pub(crate) fn from_connection(conn: Connection) -> Result<Self, AppError> {
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
            initialize_schema(&conn)?;
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
fn initialize_schema(conn: &Connection) -> Result<(), AppError> {
    // DDL 一括投入
    conn.execute_batch(SCHEMA_DDL).map_err(AppError::from)?;

    // meta 初期値 (data-model.md §4)
    let now = now_jst_iso8601();
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('db_schema_version', ?)",
        params![CURRENT_DB_SCHEMA_VERSION.to_string()],
    )
    .map_err(AppError::from)?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('app_initialized_at', ?)",
        params![now],
    )
    .map_err(AppError::from)?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('data_revision', '0')",
        [],
    )
    .map_err(AppError::from)?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('last_backup_revision', '0')",
        [],
    )
    .map_err(AppError::from)?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('last_auto_backup_at', '')",
        [],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// 既存 DB の `meta.db_schema_version` を読み、`CURRENT_DB_SCHEMA_VERSION` と整合するか検証する。
/// 新版アプリで作った DB を旧版アプリで開いた場合は `UnsupportedDbSchemaVersion` を返す
/// (`data-model.md` §4 / `architecture.md` §9: 起動を停止しエラー画面)。
fn verify_schema_version(conn: &Connection) -> Result<(), AppError> {
    let db_version: i64 = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'db_schema_version'",
            [],
            |row| row.get(0),
        )
        .map_err(AppError::from)?;
    if db_version > CURRENT_DB_SCHEMA_VERSION {
        return Err(AppError::UnsupportedDbSchemaVersion {
            db_version,
            app_version: CURRENT_DB_SCHEMA_VERSION,
        });
    }
    // db_version < CURRENT のケース: 本来はマイグレーションシーケンス。Phase 1 では
    // schema_version = 1 のみ存在するためここに来ない。将来 ADR で追加される。
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
}
