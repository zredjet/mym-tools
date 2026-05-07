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
