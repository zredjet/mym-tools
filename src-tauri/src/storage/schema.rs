//! SQLite schema (`data-model.md` §3〜§9 を Rust 文字列定数化)。
//!
//! - `meta` / `projects` / `items` / `items_fts` の 4 テーブル
//! - `items_fts` への AFTER INSERT/UPDATE/DELETE トリガ (`items` と同一トランザクション、D-12)
//! - `idx_projects_position` / `idx_items_*` の 5 インデックス
//!
//! 起動時 PRAGMA は `sqlite::open` で別途設定する (foreign_keys = ON、WAL モード等)。

/// 現在の DB schema バージョン。`meta.db_schema_version` に書き込む / 読み取り時の比較対象。
/// 上げる時は ADR-0006 通り **DB マイグレーション ADR を切る** (`data-model.md` §14、D-03 例外運用)。
pub const CURRENT_DB_SCHEMA_VERSION: i64 = 1;

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
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,

  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

-- items 用インデックス (data-model.md §6.1)
CREATE INDEX idx_items_project                ON items (project_id);
CREATE INDEX idx_items_module                 ON items (module_id);
CREATE INDEX idx_items_project_updated        ON items (project_id, updated_at DESC, id DESC);
CREATE INDEX idx_items_project_module_updated ON items (project_id, module_id, updated_at DESC, id DESC);
CREATE INDEX idx_items_module_updated         ON items (module_id, updated_at DESC, id DESC);

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
