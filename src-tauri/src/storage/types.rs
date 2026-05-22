//! StorageService の境界で使うドメイン型 (`data-model.md` §5 / §6)。

use serde::{Deserialize, Serialize};

/// `projects.id` (UUID v4 を文字列で持つ。`data-model.md` §3.2)。
/// 強い型として newtype 化することで、`ItemId` 等との取り違えを防ぐ。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub String);

impl ProjectId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 新規 UUID v4 を生成する。
    pub fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl std::fmt::Display for ProjectId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for ProjectId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl AsRef<str> for ProjectId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// プロジェクト 1 件の DTO。`data-model.md` §5 と一致するフィールド構成。
///
/// `created_at` / `updated_at` は `JST_ISO8601` (29 文字固定) の文字列。フロント側は
/// この文字列をそのまま辞書順比較できる (ADR-0005 の安定ソート規約)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub description: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// `items.id` (UUID v4 文字列、`data-model.md` §6.1)。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ItemId(pub String);

impl ItemId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 新規 UUID v4 を生成する。
    pub fn generate() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl std::fmt::Display for ItemId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for ItemId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl AsRef<str> for ItemId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// items テーブル 1 行の DTO (`data-model.md` §6.1 / `module-contract.md` §4.1 の `ItemRow` に相当)。
///
/// `payload` は **モジュール固有の JSON**。コアからは不透明な値として扱い、モジュールが
/// `serde::Deserialize` で固有型にナローイングして使う (`module-contract.md` §3.2)。
///
/// `payload_schema_version` は読み出し時に Eager-on-Read で最新版に揃えられるため、
/// この値は **常に呼び出し時点のモジュールの `current_payload_version()` と一致する**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub id: ItemId,
    pub project_id: ProjectId,
    pub module_id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub payload_schema_version: u32,
    pub payload: serde_json::Value,
    /// D&D 並び替え (`data-model.md` §6.5、PR-Y / ADR-0011)。`(project_id, module_id)`
    /// スコープ内で 0..N-1 の連番。reorder されていないスコープでは全行 0 のまま
    /// (タイブレーカーで updated_at DESC が効く)。
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// インポート 1 件の結果 (`data-model.md` §3.3 / §12.3)。
///
/// 部分成功方式のため、`StorageService::import_project` / `import_item` は
/// 「衝突したから何もしなかった」(`Skipped`) と「新規 INSERT した」(`Inserted`) を
/// `Result` の `Err` 化せずに区別する。バリデーション失敗等の真のエラーは引き続き
/// `AppError` で返す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportOutcome {
    /// 新規 INSERT に成功した (`data_revision` +1 済み)。
    Inserted,
    /// 同一 ID が既に存在したためスキップした (`data_revision` は変化なし)。
    Skipped,
}

/// 検索スコープ (`data-model.md` §11.1 / `architecture.md` §6.4)。
///
/// **内部値は `"project" | "global"`** (CLAUDE.md 不変条件)。UI 表示文言の
/// `"Current project"` / `"All projects"` とは別物として扱う。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SearchScope {
    /// 単一プロジェクト内検索。
    Project {
        #[serde(rename = "project_id")]
        project_id: ProjectId,
    },
    /// 全プロジェクト横断検索。
    Global,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_id_generate_is_uuid_format() {
        let id = ProjectId::generate();
        let s = id.as_str();
        // UUID v4: 36 文字、4 個の '-' 区切り
        assert_eq!(s.len(), 36);
        assert_eq!(s.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn project_id_serializes_as_plain_string() {
        let id = ProjectId::new("abc-123");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, r#""abc-123""#);
    }

    #[test]
    fn project_id_round_trips() {
        let id = ProjectId::new("xyz-789");
        let json = serde_json::to_string(&id).unwrap();
        let back: ProjectId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn project_serializes_with_all_fields() {
        let p = Project {
            id: ProjectId::new("p1"),
            name: "Test".into(),
            description: Some("desc".into()),
            position: 0,
            created_at: "2026-04-30T15:23:45.123+09:00".into(),
            updated_at: "2026-04-30T15:23:45.123+09:00".into(),
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["id"], "p1");
        assert_eq!(json["name"], "Test");
        assert_eq!(json["description"], "desc");
        assert_eq!(json["position"], 0);
    }

    #[test]
    fn item_id_generate_is_uuid_format() {
        let id = ItemId::generate();
        assert_eq!(id.as_str().len(), 36);
        assert_eq!(id.as_str().chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn item_serializes_with_all_fields() {
        let it = Item {
            id: ItemId::new("i1"),
            project_id: ProjectId::new("p1"),
            module_id: "color".into(),
            title: "Red".into(),
            tags: vec!["bold".into()],
            payload_schema_version: 1,
            payload: serde_json::json!({"hex": "#ff0000"}),
            position: 0,
            created_at: "2026-04-30T15:23:45.123+09:00".into(),
            updated_at: "2026-04-30T15:23:45.123+09:00".into(),
        };
        let json = serde_json::to_value(&it).unwrap();
        assert_eq!(json["id"], "i1");
        assert_eq!(json["project_id"], "p1");
        assert_eq!(json["module_id"], "color");
        assert_eq!(json["title"], "Red");
        assert_eq!(json["tags"], serde_json::json!(["bold"]));
        assert_eq!(json["payload_schema_version"], 1);
        assert_eq!(json["payload"]["hex"], "#ff0000");
    }

    #[test]
    fn search_scope_internal_value_is_lowercase_type_tag() {
        // CLAUDE.md 不変条件: 内部値は "project" | "global"
        let project_scope = SearchScope::Project {
            project_id: ProjectId::new("p1"),
        };
        let json = serde_json::to_value(&project_scope).unwrap();
        assert_eq!(json["type"], "project");
        assert_eq!(json["project_id"], "p1");

        let global_scope = SearchScope::Global;
        let json = serde_json::to_value(&global_scope).unwrap();
        assert_eq!(json["type"], "global");
    }

    #[test]
    fn project_with_null_description() {
        let p = Project {
            id: ProjectId::new("p1"),
            name: "Test".into(),
            description: None,
            position: 0,
            created_at: "2026-04-30T15:23:45.123+09:00".into(),
            updated_at: "2026-04-30T15:23:45.123+09:00".into(),
        };
        let json = serde_json::to_value(&p).unwrap();
        assert!(json["description"].is_null());
    }
}
