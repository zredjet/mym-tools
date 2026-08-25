//! DB schema versionを変えない、ADR-0016限定のLink / Memo所属移行。

use std::collections::BTreeSet;

use rusqlite::{params, Connection, Transaction};
use serde_json::{json, Value as JsonValue};

use crate::error::AppError;
use crate::storage::scoped::build_search_text;

#[derive(Debug)]
struct LegacyMemo {
    id: String,
    project_id: String,
    title: String,
    tags: Vec<String>,
    body: String,
}

pub(crate) fn legacy_linkmemo_memo_count(conn: &mut Connection) -> Result<usize, AppError> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM items
             WHERE module_id = 'linkmemo' AND json_extract(payload, '$.type') = 'memo'",
            [],
            |row| row.get(0),
        )
        .map_err(AppError::from)?;
    usize::try_from(count).map_err(|_| AppError::Storage("legacy memo count overflow".into()))
}

pub(crate) fn migrate_legacy_linkmemo_memos(conn: &mut Connection) -> Result<usize, AppError> {
    let tx = conn.transaction().map_err(AppError::from)?;
    let legacy = load_and_validate_legacy_memos(&tx)?;
    if legacy.is_empty() {
        tx.commit().map_err(AppError::from)?;
        return Ok(0);
    }

    let projects = legacy
        .iter()
        .map(|memo| memo.project_id.clone())
        .collect::<BTreeSet<_>>();
    for memo in &legacy {
        let payload = json!({ "body": memo.body });
        let payload_json = serde_json::to_string(&payload)
            .map_err(|error| AppError::Internal(format!("memo payload encode failed: {error}")))?;
        let search_text = build_search_text(&memo.title, &memo.tags, &memo.body);
        let changed = tx
            .execute(
                "UPDATE items
                 SET module_id = 'memo', payload_schema_version = 1, payload = ?, search_text = ?
                 WHERE id = ? AND module_id = 'linkmemo'
                   AND json_extract(payload, '$.type') = 'memo'",
                params![payload_json, search_text, memo.id],
            )
            .map_err(AppError::from)?;
        if changed != 1 {
            return Err(AppError::Storage(format!(
                "legacy memo changed during migration: {}",
                memo.id
            )));
        }
    }

    for project_id in projects {
        normalize_positions(&tx, &project_id, "linkmemo")?;
        normalize_positions(&tx, &project_id, "memo")?;
    }
    let moved = legacy.len();
    tx.commit().map_err(AppError::from)?;
    Ok(moved)
}

fn load_and_validate_legacy_memos(tx: &Transaction<'_>) -> Result<Vec<LegacyMemo>, AppError> {
    let mut statement = tx
        .prepare(
            "SELECT id, project_id, title, tags, payload
             FROM items
             WHERE module_id = 'linkmemo' AND json_extract(payload, '$.type') = 'memo'
             ORDER BY project_id, position ASC, updated_at DESC, id DESC",
        )
        .map_err(AppError::from)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(AppError::from)?;

    let mut result = Vec::new();
    for row in rows {
        let (id, project_id, title, tags_json, payload_json) = row.map_err(AppError::from)?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).map_err(|error| {
            AppError::Storage(format!("legacy memo {id} has invalid tags: {error}"))
        })?;
        let payload: JsonValue = serde_json::from_str(&payload_json).map_err(|error| {
            AppError::Storage(format!("legacy memo {id} has invalid payload: {error}"))
        })?;
        let body = payload
            .get("body")
            .and_then(JsonValue::as_str)
            .filter(|body| !body.trim().is_empty())
            .ok_or_else(|| AppError::Storage(format!("legacy memo {id} has no usable body")))?;
        result.push(LegacyMemo {
            id,
            project_id,
            title,
            tags,
            body: body.to_string(),
        });
    }
    Ok(result)
}

fn normalize_positions(
    tx: &Transaction<'_>,
    project_id: &str,
    module_id: &str,
) -> Result<(), AppError> {
    let ids = {
        let mut statement = tx
            .prepare(
                "SELECT id FROM items
                 WHERE project_id = ? AND module_id = ?
                 ORDER BY position ASC, updated_at DESC, id DESC",
            )
            .map_err(AppError::from)?;
        let collected = statement
            .query_map(params![project_id, module_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        collected
    };
    for (position, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE items SET position = ? WHERE id = ? AND project_id = ? AND module_id = ?",
            params![position as i64, id, project_id, module_id],
        )
        .map_err(AppError::from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{SqliteStorage, StorageService};
    use serde_json::json;

    #[test]
    fn migrates_mixed_rows_preserving_metadata_search_order_and_revision() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        let project = storage.create_project("Project", None).unwrap();
        let link = insert(
            &storage,
            &project.id,
            "Link",
            json!({"type":"url","target":"https://example.com","body":""}),
        );
        let first = insert(
            &storage,
            &project.id,
            "古い",
            json!({"type":"memo","target":null,"body":"needle first"}),
        );
        let second = insert(
            &storage,
            &project.id,
            "新しい",
            json!({"type":"memo","target":null,"body":"needle second"}),
        );
        storage
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE items SET position = 9 WHERE id = ?",
                    [link.as_str()],
                )?;
                conn.execute(
                    "UPDATE items SET position = 3 WHERE id = ?",
                    [first.as_str()],
                )?;
                conn.execute(
                    "UPDATE items SET position = 4 WHERE id = ?",
                    [second.as_str()],
                )?;
                Ok(())
            })
            .unwrap();
        let before_first = storage
            .list_items("linkmemo", &project.id, 100, 0)
            .unwrap()
            .into_iter()
            .find(|item| item.id == first)
            .unwrap();
        let revision = storage.data_revision().unwrap();

        assert_eq!(storage.migrate_legacy_linkmemo_memos().unwrap(), 2);
        assert_eq!(storage.data_revision().unwrap(), revision);
        let memos = storage.list_items("memo", &project.id, 100, 0).unwrap();
        assert_eq!(
            memos
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![first.as_str(), second.as_str()]
        );
        assert_eq!(
            memos.iter().map(|item| item.position).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(memos[0].payload, json!({"body":"needle first"}));
        assert_eq!(memos[0].created_at, before_first.created_at);
        assert_eq!(memos[0].updated_at, before_first.updated_at);
        assert_eq!(
            storage.list_items("linkmemo", &project.id, 100, 0).unwrap()[0].position,
            0
        );
        let found = storage
            .search(
                &crate::storage::types::SearchScope::Project {
                    project_id: project.id.clone(),
                },
                "needle",
                Some(&["memo".into()]),
                100,
                0,
            )
            .unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(storage.migrate_legacy_linkmemo_memos().unwrap(), 0);
    }

    #[test]
    fn rolls_back_every_row_when_payload_or_sql_is_invalid() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        let project = storage.create_project("Project", None).unwrap();
        let good = insert(
            &storage,
            &project.id,
            "Good",
            json!({"type":"memo","body":"ok"}),
        );
        let bad = insert(
            &storage,
            &project.id,
            "Bad",
            json!({"type":"memo","body":null}),
        );
        assert!(storage.migrate_legacy_linkmemo_memos().is_err());
        assert_eq!(storage.legacy_linkmemo_memo_count().unwrap(), 2);
        assert_eq!(
            storage
                .list_items("linkmemo", &project.id, 100, 0)
                .unwrap()
                .len(),
            2
        );
        assert!(storage
            .list_items("memo", &project.id, 100, 0)
            .unwrap()
            .is_empty());
        assert_ne!(good, bad);
    }

    #[test]
    fn sql_failure_rolls_back_rows_already_updated_in_the_transaction() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        let project = storage.create_project("Project", None).unwrap();
        let first = insert(
            &storage,
            &project.id,
            "First",
            json!({"type":"memo","body":"one"}),
        );
        let failing = insert(
            &storage,
            &project.id,
            "Fail",
            json!({"type":"memo","body":"two"}),
        );
        storage
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE items SET position = 0 WHERE id = ?",
                    [first.as_str()],
                )?;
                conn.execute(
                    "UPDATE items SET position = 1 WHERE id = ?",
                    [failing.as_str()],
                )?;
                conn.execute_batch(
                    "CREATE TRIGGER fail_split BEFORE UPDATE OF module_id ON items
                 WHEN old.title = 'Fail'
                 BEGIN SELECT RAISE(ABORT, 'forced split failure'); END;",
                )?;
                Ok(())
            })
            .unwrap();

        assert!(storage.migrate_legacy_linkmemo_memos().is_err());
        assert_eq!(storage.legacy_linkmemo_memo_count().unwrap(), 2);
        assert!(storage
            .list_items("memo", &project.id, 100, 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn migration_has_no_hundred_item_cutoff() {
        let storage = SqliteStorage::open(":memory:").unwrap();
        let project = storage.create_project("Project", None).unwrap();
        for index in 0..205 {
            let (title, payload) = if index % 2 == 0 {
                (
                    format!("Memo {index}"),
                    json!({"type":"memo","target":null,"body":format!("body {index}")}),
                )
            } else {
                (
                    format!("Link {index}"),
                    json!({"type":"url","target":format!("https://example.com/{index}"),"body":""}),
                )
            };
            insert(&storage, &project.id, &title, payload);
        }

        assert_eq!(storage.legacy_linkmemo_memo_count().unwrap(), 103);
        assert_eq!(storage.migrate_legacy_linkmemo_memos().unwrap(), 103);
        let memos = storage.list_items("memo", &project.id, 500, 0).unwrap();
        let links = storage.list_items("linkmemo", &project.id, 500, 0).unwrap();
        assert_eq!((memos.len(), links.len()), (103, 102));
        assert_eq!(memos.last().unwrap().position, 102);
        assert_eq!(links.last().unwrap().position, 101);
    }

    fn insert(
        storage: &SqliteStorage,
        project_id: &crate::storage::types::ProjectId,
        title: &str,
        payload: JsonValue,
    ) -> crate::storage::types::ItemId {
        storage
            .create_item(
                "linkmemo",
                project_id,
                title,
                &["tag".into()],
                1,
                &payload,
                title,
            )
            .unwrap()
    }
}
