//! DB bootstrap (起動シーケンス、ADR-0011 §2.4)。
//!
//! `SqliteStorage::open` の **外** で動く前処理。鶏卵問題回避のため:
//!
//! 1. `inspect_db_schema_version(&Path) -> i64` で軽量に現行版を読む (DB が無ければ skip)
//! 2. 旧版なら `take_pre_migration_backup(...)` で rusqlite Backup API を直接叩いて
//!    `<backups_root>/pre-op/pre-migration-v<N>-<ts>.sqlite` に書き出す
//! 3. `migrate_if_needed(&Path)` で `MIGRATIONS` を順次適用 (各 tx が末尾で
//!    `db_schema_version` を bump)
//! 4. その後で初めて `SqliteStorage::open` を呼ぶ → `verify_schema_version` が成立
//!
//! ## なぜ `LocalBackupService::take` を使わないか
//!
//! `LocalBackupService` は完成済 `Arc<dyn StorageService>` を要求するが、migration は
//! storage 完成 **前** に走らせる必要がある (storage は最新 schema を前提に開く)。
//! 鶏卵問題を回避するため、本モジュールは backup service に頼らず rusqlite の
//! `Backup::new(&Connection, &Connection)` を直接叩く独立ヘルパで pre-migration ファイルを
//! 書き出す。命名規則は `data-model.md` §13.4 / ADR-0007 §3.4 に従い、
//! `LocalBackupService::list()` から後で通常通り認識される。

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use tracing::info;

use crate::error::AppError;
use crate::storage::schema::{Migration, CURRENT_DB_SCHEMA_VERSION, MIGRATIONS};
use crate::time::now_jst_filename_timestamp;

/// pre-migration バックアップの命名 prefix (ADR-0011 §2.4 / `data-model.md` §13.4 / ADR-0007 §3.4)。
pub const PRE_MIGRATION_PREFIX: &str = "pre-migration-v";

/// pre-op バックアップを置くサブディレクトリ名 (`data-model.md` §13.4 既存規約)。
const PRE_OP_SUBDIR: &str = "pre-op";

/// DB ファイルから `meta.db_schema_version` を軽量に読む。
///
/// - DB ファイル自体が存在しない → `Ok(None)` (新規 DB として扱う)
/// - `meta` テーブル / `db_schema_version` 行が無い → `Ok(None)` (壊れた DB のため `SqliteStorage::open`
///   が後で再初期化を試みる)
/// - その他の I/O エラーは `Err`
///
/// 接続は read-only で開き、本関数の戻り直前に必ず close する (writer mutex を握る本接続と
/// 競合しないように)。
pub fn inspect_db_schema_version(db_path: &Path) -> Result<Option<i64>, AppError> {
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(AppError::from)?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'db_schema_version'",
            [],
            |row| row.get(0),
        )
        .ok();
    let parsed = value.and_then(|s| s.parse::<i64>().ok());
    Ok(parsed)
}

/// 起動時に必要なら migration を適用する (ADR-0011 §2.3 / §2.4)。
///
/// - DB が存在しない or `db_schema_version` が読めない → 何もせず `Ok(())` (新規 DB は
///   `SqliteStorage::open` が `SCHEMA_DDL` で立ち上げる)
/// - 現行版 = `CURRENT_DB_SCHEMA_VERSION` → 何もせず `Ok(())`
/// - 現行版 > `CURRENT_DB_SCHEMA_VERSION` (新版 DB を旧版アプリで開く) → 何もせず `Ok(())`
///   (`SqliteStorage::open` 内の `verify_schema_version` が `UnsupportedDbSchemaVersion` を返す)
/// - 現行版 < `CURRENT_DB_SCHEMA_VERSION` → **pre-migration backup を取った後**、
///   `MIGRATIONS[from..to]` を順次適用
///
/// 各 Migration エントリは末尾で `UPDATE meta SET db_schema_version = '<to>'` を含むため、
/// 途中失敗時はその tx だけがロールバックされ、`db_schema_version` は最後に成功した値で止まる。
pub fn migrate_if_needed(db_path: &Path, backups_root: &Path) -> Result<(), AppError> {
    let current = match inspect_db_schema_version(db_path)? {
        Some(v) => v,
        None => return Ok(()), // 新規 DB or 壊れた DB
    };

    if current >= CURRENT_DB_SCHEMA_VERSION {
        // 完全一致 → migration 不要
        // 未来版 → ここでは何もせず、後段の verify_schema_version で UnsupportedDbSchemaVersion を返させる
        return Ok(());
    }

    info!(
        from = current,
        to = CURRENT_DB_SCHEMA_VERSION,
        "DB schema migration required, taking pre-migration backup first"
    );

    // pre-migration backup (失敗したら migration 中止 → 起動停止、ADR-0011 §2.5)
    take_pre_migration_backup(db_path, backups_root, CURRENT_DB_SCHEMA_VERSION)?;

    // MIGRATIONS を順次適用
    let mut conn = Connection::open(db_path).map_err(AppError::from)?;
    // foreign_keys は migration 中も ON にしておく (additive な migration では FK 影響なしが前提)
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(AppError::from)?;

    let mut applied_from = current;
    while applied_from < CURRENT_DB_SCHEMA_VERSION {
        let migration = find_migration(applied_from).ok_or_else(|| AppError::Storage(format!(
            "no migration found for from_version={applied_from} (target={CURRENT_DB_SCHEMA_VERSION})"
        )))?;
        apply_one(&mut conn, migration)?;
        applied_from = migration.to_version;
        info!(
            from = migration.from_version,
            to = migration.to_version,
            "DB schema migration step applied"
        );
    }
    Ok(())
}

/// `MIGRATIONS` から `from_version` 一致のエントリを 1 件取り出す。
fn find_migration(from_version: i64) -> Option<&'static Migration> {
    MIGRATIONS.iter().find(|m| m.from_version == from_version)
}

/// 1 件の Migration を単一トランザクションで適用する。
///
/// SQL は ADR-0011 §2.3 規約により末尾に `UPDATE meta SET db_schema_version = '<to>'` を含む。
/// 失敗時は tx 全体がロールバックされ、`db_schema_version` は変わらない (次回起動で再試行可能)。
fn apply_one(conn: &mut Connection, migration: &Migration) -> Result<(), AppError> {
    let tx = conn.transaction().map_err(AppError::from)?;
    tx.execute_batch(migration.sql).map_err(AppError::from)?;
    tx.commit().map_err(AppError::from)?;
    Ok(())
}

/// 適用前に DB スナップショットを取得する独立ヘルパ (ADR-0011 §2.4)。
///
/// `BackupService` を経由しない理由は本ファイル冒頭のコメント参照。命名規則は
/// `data-model.md` §13.4 既存規約: `<backups_root>/pre-op/pre-migration-v<N>-<ts>.sqlite`。
/// `<N>` は **適用後の `CURRENT_DB_SCHEMA_VERSION`** とする (複数段適用の場合も 1 ファイル
/// のみ、最終 to 値を入れる)。
///
/// 失敗時は `Err(AppError)` を返し、`migrate_if_needed` の呼び出し側は migration を中止する
/// (= 起動停止、`docs/ui-design.md` C-12 系のエラー画面に遷移する想定)。
pub fn take_pre_migration_backup(
    db_path: &Path,
    backups_root: &Path,
    target_version: i64,
) -> Result<PathBuf, AppError> {
    let pre_op_dir = backups_root.join(PRE_OP_SUBDIR);
    fs::create_dir_all(&pre_op_dir).map_err(|e| {
        AppError::Storage(format!(
            "cannot create pre-op backup dir {}: {e}",
            pre_op_dir.display()
        ))
    })?;

    let filename = format!(
        "{}{}-{}.sqlite",
        PRE_MIGRATION_PREFIX,
        target_version,
        now_jst_filename_timestamp()
    );
    let dst_path = pre_op_dir.join(filename);

    // rusqlite Backup API: ソース DB → 新規ファイルへフルコピー (WAL を含めた一貫スナップショット)
    let src_conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(AppError::from)?;
    let mut dst_conn = Connection::open(&dst_path).map_err(AppError::from)?;
    {
        let backup =
            rusqlite::backup::Backup::new(&src_conn, &mut dst_conn).map_err(AppError::from)?;
        backup
            .run_to_completion(1024, std::time::Duration::from_millis(0), None)
            .map_err(AppError::from)?;
    }
    Ok(dst_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::tempdir;

    /// v1 schema (position カラム無し) の DB を tempdir に作るヘルパ。
    /// `SCHEMA_DDL` は最新版を含むため、ここでは古い DDL を直接書き出す。
    fn create_v1_db(db_path: &Path) {
        let mut conn = Connection::open(db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE meta (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            INSERT INTO meta (key, value) VALUES ('db_schema_version', '1');
            INSERT INTO meta (key, value) VALUES ('app_initialized_at', '2026-05-01T00:00:00.000+09:00');
            INSERT INTO meta (key, value) VALUES ('data_revision', '0');
            INSERT INTO meta (key, value) VALUES ('last_backup_revision', '0');
            INSERT INTO meta (key, value) VALUES ('last_auto_backup_at', '');

            CREATE TABLE projects (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL,
              description TEXT,
              position    INTEGER NOT NULL DEFAULT 0,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL
            );
            CREATE INDEX idx_projects_position ON projects (position);

            CREATE TABLE items (
              id                     TEXT PRIMARY KEY,
              project_id             TEXT NOT NULL,
              module_id              TEXT NOT NULL,
              title                  TEXT NOT NULL,
              tags                   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
              search_text            TEXT NOT NULL DEFAULT '',
              payload_schema_version INTEGER NOT NULL DEFAULT 1,
              payload                TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
              created_at             TEXT NOT NULL,
              updated_at             TEXT NOT NULL,
              FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
            );
            CREATE INDEX idx_items_project_module_updated
              ON items (project_id, module_id, updated_at DESC, id DESC);
            "#,
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO projects (id, name, description, position, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                "p1",
                "Test Project",
                None::<String>,
                0,
                "2026-05-01T00:00:00.000+09:00",
                "2026-05-01T00:00:00.000+09:00"
            ],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO items (id, project_id, module_id, title, tags, search_text, \
             payload_schema_version, payload, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                "i1",
                "p1",
                "prompt",
                "Old Item",
                "[]",
                "Old Item",
                1,
                "{}",
                "2026-05-01T00:00:00.000+09:00",
                "2026-05-01T00:00:00.000+09:00"
            ],
        )
        .unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn inspect_returns_none_for_missing_db() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("noexist.sqlite");
        assert_eq!(inspect_db_schema_version(&path).unwrap(), None);
    }

    #[test]
    fn inspect_returns_one_for_v1_db() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v1.sqlite");
        create_v1_db(&path);
        assert_eq!(inspect_db_schema_version(&path).unwrap(), Some(1));
    }

    /// T-35 相当: 旧 schema (v1) DB に migration を適用すると items.position が全行 0 で追加され、
    /// 新インデックスが作成され、`db_schema_version` が `2` に更新される。
    #[test]
    fn migrate_v1_to_v2_adds_position_column_and_bumps_version() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("v1.sqlite");
        let backups = dir.path().join("backups");
        create_v1_db(&db);

        migrate_if_needed(&db, &backups).expect("migrate succeeds");

        let conn = Connection::open(&db).unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'db_schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(v, 2);

        let position: i64 = conn
            .query_row("SELECT position FROM items WHERE id = 'i1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(position, 0);

        // 新 INDEX が存在する
        let idx_exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_items_project_module_position'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(idx_exists, "new index should be created");
    }

    /// T-37 相当: pre-migration バックアップが `<backups_root>/pre-op/pre-migration-v<N>-*.sqlite`
    /// の形で取得されている。
    #[test]
    fn migrate_creates_pre_migration_backup_file() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("v1.sqlite");
        let backups = dir.path().join("backups");
        create_v1_db(&db);

        migrate_if_needed(&db, &backups).expect("migrate succeeds");

        let pre_op_dir = backups.join("pre-op");
        let entries: Vec<_> = fs::read_dir(&pre_op_dir)
            .expect("pre-op dir created")
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1, "exactly one backup file should exist");
        let name = entries[0].file_name().into_string().unwrap();
        assert!(
            name.starts_with("pre-migration-v2-"),
            "filename should start with pre-migration-v2-, got: {name}"
        );
        assert!(name.ends_with(".sqlite"));
    }

    /// T-36 相当: migration 完了済 DB を再起動 → migration が走らず冪等。
    /// 2 回目の `migrate_if_needed` 呼び出しで backup ファイルが増えないことで判定。
    #[test]
    fn migrate_is_idempotent_when_already_at_current_version() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("v1.sqlite");
        let backups = dir.path().join("backups");
        create_v1_db(&db);

        migrate_if_needed(&db, &backups).unwrap(); // 1 回目 → v2 に
        let count1 = fs::read_dir(backups.join("pre-op")).unwrap().count();

        migrate_if_needed(&db, &backups).unwrap(); // 2 回目 → 何もせず
        let count2 = fs::read_dir(backups.join("pre-op")).unwrap().count();

        assert_eq!(
            count1, count2,
            "no new backup should be taken on second migrate"
        );
        assert_eq!(count1, 1);
    }

    /// 新規 (= DB ファイル不在) のときは migration を実行せず Ok を返す。
    #[test]
    fn migrate_skips_when_db_file_does_not_exist() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("noexist.sqlite");
        let backups = dir.path().join("backups");
        migrate_if_needed(&db, &backups).unwrap();
        assert!(!db.exists());
        // backups dir も作られない
        assert!(!backups.join("pre-op").exists());
    }
}
