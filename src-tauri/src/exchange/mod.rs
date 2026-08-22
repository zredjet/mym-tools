//! Export / Import JSON (`docs/data-model.md` §12、要件 D-05)。
//!
//! 単一 `.mymtools.json` ファイルを介した可搬性レイヤ。SQLite Online Backup
//! (`backup/`) が「同じマシン内のローカル復旧」を担うのに対し、本モジュールは
//! 「別マシン / 別タイミングの DB に取り込めること」を目的にした論理エクスポート。
//!
//! ## 設計上のポイント
//!
//! - スコープは **app** (全プロジェクト) と **project** (指定した 1 プロジェクト) の 2 種類。
//!   どちらも全 stateful モジュールの items を対象とする
//! - `search_text` は書き出さない (`data-model.md` §12.2)。インポート時に
//!   モジュールの `index_text()` で再構築する
//! - エクスポートは **StorageService の高レベル読み込み API を通す**ため、古い
//!   `payload_schema_version` の item は Eager-on-Read で **読み込み時に自動最新化** され、
//!   結果として `module_versions` と JSON 内の各 item の payload は揃う
//! - インポートは **部分成功** (`data-model.md` §12.3): プロジェクト単位 / item 単位の
//!   独立トランザクションで、衝突や個別 validate 失敗は skip + 集計、他の行は継続
//! - インポート前の **pre-op バックアップ** (`data-model.md` §12.5) は本モジュールでは
//!   発火しない (呼び出し側 = Tauri command の責務)。
//!
//! ## ファイル形式 (`data-model.md` §12.1)
//!
//! ```jsonc
//! {
//!   "schema_version": 1,
//!   "exported_at": "2026-04-25T12:00:00.000+09:00",
//!   "app_version": "0.1.0",
//!   "scope": "app" | "project",
//!   "module_versions": { "prompt": 1, "linkmemo": 1, "color": 1 },
//!   "projects": [
//!     {
//!       "id": "...", "name": "...", "description": "...", "position": 0,
//!       "created_at": "...", "updated_at": "...",
//!       "items": [{ "id": "...", "module_id": "prompt", ... }]
//!     }
//!   ]
//! }
//! ```

pub mod export;
pub mod import;

pub use export::{build_export_data, build_project_export_data};
pub use import::{apply_import, parse_export_json};

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::storage::{Item, ItemId, Project, ProjectId};

/// このコードベースが書き出す / 読み込める JSON のトップレベル `schema_version`
/// (`data-model.md` §12.1)。インポート時に未知の値が来たら拒否する。
pub const CURRENT_EXPORT_SCHEMA_VERSION: u32 = 1;

/// エクスポート／インポート対象スコープ (`data-model.md` §12.1)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportScope {
    App,
    Project,
}

/// `.mymtools.json` 1 ファイルの全体構造 (`data-model.md` §12.1)。
///
/// フィールド名は仕様に合わせてスネークケース、`exported_at` は `JST_ISO8601` 文字列。
/// `app_version` はインポート側の挙動には影響しないがログ / トラブルシュート用に保持。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportData {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub scope: ExportScope,
    /// stateful モジュールの `id` → `current_payload_version()` のマップ
    /// (`data-model.md` §12.1 / §12.2)。`hash` 等の stateless モジュールは含めない
    pub module_versions: BTreeMap<String, u32>,
    pub projects: Vec<ProjectWithItems>,
}

/// プロジェクト 1 件 + その配下 items の塊 (`data-model.md` §12.1)。
///
/// 物理的には items は単一テーブルだが、JSON 上はプロジェクト配下に **ネストして** 出す
/// (人間が読んで意味が通る並びにする)。インポート時は `project` 投入 → 配下 items 投入
/// の順で扱う (`data-model.md` §12.4 トランザクション粒度)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWithItems {
    #[serde(flatten)]
    pub project: ProjectExport,
    pub items: Vec<ItemExport>,
}

/// JSON 用の Project 表現。フィールドは `Project` と同じだが、`search_text` 等 storage
/// 固有の列は持たない (Project は元々持たないので、ここでは型エイリアス的な独立型として
/// 切り出すことで「JSON の `projects[]` 要素として扱う」シグナルを明示する)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectExport {
    pub id: ProjectId,
    pub name: String,
    pub description: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Project> for ProjectExport {
    fn from(p: Project) -> Self {
        Self {
            id: p.id,
            name: p.name,
            description: p.description,
            position: p.position,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}

impl From<ProjectExport> for Project {
    fn from(p: ProjectExport) -> Self {
        Self {
            id: p.id,
            name: p.name,
            description: p.description,
            position: p.position,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}

/// JSON 用の Item 表現 (`data-model.md` §12.1)。
///
/// `project_id` は親の `projects[]` 要素にぶら下がるため **書かない** (フラットな
/// `items` ではなくネスト構造を選んだのは、これにより冗長性を減らせるため)。
/// `search_text` も書かない (再生成可能)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemExport {
    pub id: ItemId,
    pub module_id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub payload_schema_version: u32,
    pub payload: serde_json::Value,
    /// `(project_id, module_id)` スコープ内での D&D 並び (`data-model.md` §6.5)。
    /// import 時はこの値をそのまま保存し、`apply_import` 末尾の `normalize_item_positions`
    /// で `(position, created_at, id)` 順にソートしてから 0..N-1 の連番に詰め直す。
    /// 古い (PR-Y 以前の) export JSON に position フィールドが無い場合は `0` がデフォルト。
    #[serde(default)]
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl ItemExport {
    /// `Item` から JSON 表現に変換する (project_id は親で表現されるため落とす)。
    pub fn from_item(it: Item) -> Self {
        Self {
            id: it.id,
            module_id: it.module_id,
            title: it.title,
            tags: it.tags,
            payload_schema_version: it.payload_schema_version,
            payload: it.payload,
            position: it.position,
            created_at: it.created_at,
            updated_at: it.updated_at,
        }
    }
}

/// インポート結果サマリ (`data-model.md` §12.3 の集計値)。
///
/// 部分成功方式のため、トータル N 件のうち何件が成功 / スキップ / 失敗したかを
/// 分けて返し、失敗内訳は `failures` に詳細を残す。フロントエンドは本サマリを
/// 「インポート完了画面」(`docs/ui-design.md` §6.9 C-7 系) に表示する。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSummary {
    pub projects_inserted: usize,
    pub projects_skipped: usize,
    pub projects_failed: usize,
    pub items_inserted: usize,
    pub items_skipped: usize,
    pub items_failed: usize,
    /// 失敗詳細 (バリデーション / payload アップグレード等)。`Vec` は順序保持
    pub failures: Vec<ImportFailure>,
}

impl ImportSummary {
    pub fn new() -> Self {
        Self {
            projects_inserted: 0,
            projects_skipped: 0,
            projects_failed: 0,
            items_inserted: 0,
            items_skipped: 0,
            items_failed: 0,
            failures: Vec::new(),
        }
    }
}

impl Default for ImportSummary {
    fn default() -> Self {
        Self::new()
    }
}

/// エクスポート完了時にフロントへ返す軽量サマリ (`data-model.md` §12)。
///
/// **設計意図** (codex PR-Z P2): フル `ExportData` を IPC で返すと、ファイル
/// 書き込み時の serialize に加えてフロントへ全アイテム payload を**もう一度**
/// 転送することになり、大規模 DB で UI レイテンシ / メモリ使用が問題化する。
/// フロントは件数とメタしか UI 表示しないため、ここでは集計値だけを返す。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSummary {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub scope: ExportScope,
    pub module_versions: BTreeMap<String, u32>,
    /// プロジェクト件数
    pub projects_count: usize,
    /// 全プロジェクト合計の item 件数
    pub items_count: usize,
    /// 書き出した JSON ファイルのバイト数
    pub bytes_written: u64,
}

impl ExportSummary {
    /// `ExportData` (フル) から件数を集計してサマリを作る。`bytes_written` は
    /// ファイル書き込み後に呼び出し側で埋める想定 (本コンストラクタでは 0)。
    pub fn summarize(data: &ExportData) -> Self {
        let items_count = data.projects.iter().map(|p| p.items.len()).sum();
        Self {
            schema_version: data.schema_version,
            exported_at: data.exported_at.clone(),
            app_version: data.app_version.clone(),
            scope: data.scope,
            module_versions: data.module_versions.clone(),
            projects_count: data.projects.len(),
            items_count,
            bytes_written: 0,
        }
    }
}

/// 失敗 1 件の記録 (`data-model.md` §12.3 のログ要件)。
///
/// `entity` は `"project"` または `"item"`、`id` は失敗した行の元の ID
/// (重複時に追跡可能なように元の値を残す)、`reason` は人間可読な短文。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportFailure {
    pub entity: String,
    pub id: String,
    /// 失敗した item の `module_id` (project 失敗時は None)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_id: Option<String>,
    pub reason: String,
}
