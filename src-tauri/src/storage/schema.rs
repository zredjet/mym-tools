//! SQLite schema (`data-model.md` §3〜§9 を Rust 文字列定数化)。
//!
//! - `meta` / `projects` / `items` / `items_fts` の 4 テーブル
//! - `items_fts` への AFTER INSERT/UPDATE/DELETE トリガ (`items` と同一トランザクション、D-12)
//! - `idx_projects_position` / `idx_items_*` の 5 インデックス
//!
//! 起動時 PRAGMA は `sqlite::open` で別途設定する (foreign_keys = ON、WAL モード等)。

/// 現在の DB schema バージョン。`meta.db_schema_version` に書き込む / 読み取り時の比較対象。
///
/// 値を上げる時:
/// - **additive な変更** (新カラム + 定数 DEFAULT / 新テーブル / 新インデックス / 新トリガ / VIEW)
///   は **ADR-0011** の枠組みで許可される。`SCHEMA_DDL` を新規 DB 向けに更新しつつ、同じ変化を
///   `MIGRATIONS` 配列にエントリ追加 (旧 DB 起動時に冪等適用される)。bump 値は `to_version` と
///   一致させる
/// - **破壊的な変更** (DROP / RENAME / 型変更 / 既存値書き換え) は引き続き **別 ADR + C-12
///   起動停止画面** が必須 (ADR-0011 §2.2 / ADR-0006)
///
/// 履歴は `docs/data-model.md` §14.4 (一次ソース) を参照。
pub const CURRENT_DB_SCHEMA_VERSION: i64 = 2;

/// すべての DDL を一括投入する SQL (新規 DB 用)。
///
/// `rusqlite::Connection::execute_batch` で実行する。`meta` テーブルへの初期値 INSERT は
/// プレースホルダ `<JST_ISO8601>` 部分のみ Rust 側で動的に埋めるため、`sqlite::initialize_schema`
/// が `app_initialized_at` の値を別 INSERT で書き込む構造にしている。
pub const SCHEMA_DDL: &str = r#"
-- meta テーブル (data-model.md §4)
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- projects テーブル (data-model.md §5)
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,                  -- UUID v4
  name        TEXT NOT NULL,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,                     -- JST_ISO8601 (29 文字、ADR-0005)
  updated_at  TEXT NOT NULL                      -- JST_ISO8601
);

CREATE INDEX idx_projects_position ON projects (position);

-- items テーブル (data-model.md §6.1)
CREATE TABLE items (
  id                     TEXT PRIMARY KEY,                  -- UUID v4
  project_id             TEXT NOT NULL,
  module_id              TEXT NOT NULL,                     -- "prompt" | "linkmemo" | "color" 等
  title                  TEXT NOT NULL,
  tags                   TEXT NOT NULL DEFAULT '[]'
                                CHECK (json_valid(tags)),
  search_text            TEXT NOT NULL DEFAULT '',
  payload_schema_version INTEGER NOT NULL DEFAULT 1,
  payload                TEXT NOT NULL DEFAULT '{}'
                                CHECK (json_valid(payload)),
  position               INTEGER NOT NULL DEFAULT 0,        -- D&D 並び (PR-Y / ADR-0011 / §6.5)
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,

  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

-- items 用インデックス (data-model.md §6.1)
CREATE INDEX idx_items_project                    ON items (project_id);
CREATE INDEX idx_items_module                     ON items (module_id);
CREATE INDEX idx_items_project_updated            ON items (project_id, updated_at DESC, id DESC);
CREATE INDEX idx_items_project_module_updated     ON items (project_id, module_id, updated_at DESC, id DESC);
CREATE INDEX idx_items_module_updated             ON items (module_id, updated_at DESC, id DESC);
-- D&D 並び表示用 (data-model.md §6.5、`ORDER BY position ASC, updated_at DESC, id DESC` を
-- index-only でカバーする)
CREATE INDEX idx_items_project_module_position    ON items (project_id, module_id, position, updated_at DESC, id DESC);

-- items_fts 仮想テーブル (data-model.md §8.1)
-- - search_text 1 本に絞り、UNINDEXED で project_id / module_id / item_id を冗長持ち
-- - tokenize='trigram' は SQLite 3.34+ で利用可、bundled rusqlite に同梱
CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id    UNINDEXED,
  project_id UNINDEXED,
  module_id  UNINDEXED,
  search_text,
  tokenize = 'trigram'
);

-- 同期トリガ (data-model.md §8.2 / D-12)
CREATE TRIGGER trg_items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (item_id, project_id, module_id, search_text)
  VALUES (new.id, new.project_id, new.module_id, new.search_text);
END;

CREATE TRIGGER trg_items_fts_au AFTER UPDATE ON items BEGIN
  UPDATE items_fts SET
    project_id  = new.project_id,
    module_id   = new.module_id,
    search_text = new.search_text
  WHERE item_id = new.id;
END;

CREATE TRIGGER trg_items_fts_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_fts WHERE item_id = old.id;
END;
"#;

/// 起動時に発行する PRAGMA 群。
///
/// - `foreign_keys = ON`: SQLite はデフォルト OFF。`items.project_id ... ON DELETE CASCADE`
///   を有効化するために必須 (`data-model.md` §9.1)
/// - `journal_mode = WAL`: 並行読み書きと耐障害性。`data-model.md` §2 でファイルコピー禁止
///   とセット
/// - `synchronous = NORMAL`: WAL 下では FULL より速く、信頼性は十分
pub const PRAGMAS: &[&str] = &[
    "PRAGMA foreign_keys = ON;",
    "PRAGMA journal_mode = WAL;",
    "PRAGMA synchronous = NORMAL;",
];

/// 既存 DB を 1 段だけ前進させる additive マイグレーション (ADR-0011 §2.3)。
///
/// **不変条件**:
/// - `to_version = from_version + 1` (1 段ずつ、複数段ジャンプ禁止)
/// - `sql` は additive のみ (新カラム + 定数 DEFAULT / 新テーブル / 新インデックス / 新トリガ /
///   VIEW)。DROP / RENAME / 型変更 / 既存値書き換えは禁止 (ADR-0011 §2.2)
/// - **`sql` の末尾で必ず** `UPDATE meta SET value = '<to_version>' WHERE key = 'db_schema_version'`
///   を含める。DDL と bump を同じトランザクションに同居させ、途中失敗時の片寄りを防ぐ
///   (ADR-0011 §2.5)
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub from_version: i64,
    pub to_version: i64,
    pub sql: &'static str,
}

/// 既存 DB を `CURRENT_DB_SCHEMA_VERSION` まで段階的に上げる順序付きマイグレーション一覧
/// (`docs/data-model.md` §14.4 が一次ソース、本配列はその実装)。
///
/// **追加時のチェックリスト** (`CLAUDE.md` §作業時のルール):
/// - additive only (ADR-0011 §2.1)
/// - `to_version = from_version + 1` (1 段ずつ)
/// - 末尾に `UPDATE meta SET value = '<to>' WHERE key = 'db_schema_version'`
/// - `SCHEMA_DDL` を同時に新規 DB 向けに更新する (新規 DB は migration を走らせない)
/// - `data-model.md` §14.4 表に 1 行追加
/// - pre-migration backup (`pre-migration-v<N>`) が `schema::bootstrap` で起動時に走る回帰テストを追加
pub const MIGRATIONS: &[Migration] = &[
    // v1 → v2: items.position + idx_items_project_module_position 追加 (PR-Y / ADR-0011 §5)
    Migration {
        from_version: 1,
        to_version: 2,
        sql: r#"
            ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX idx_items_project_module_position
              ON items (project_id, module_id, position, updated_at DESC, id DESC);
            UPDATE meta SET value = '2' WHERE key = 'db_schema_version';
        "#,
    },
];
