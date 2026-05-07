//! `ScopedStorage` — モジュールにスコープされたストレージハンドル
//! (`module-contract.md` §5.1)。
//!
//! ## 役割
//!
//! - すべての CRUD 呼び出しで `module_id` を内部の `Arc<dyn ModuleBackend>` から取得し、
//!   モジュールが他モジュールの items / 設定にアクセスできない (`module-contract.md` §6.2)
//! - 書込み時に `module.index_text(payload)` を呼んで `search_text` を生成
//! - 書込み時に `module.validate_payload(payload)` で構造検証
//! - 書込み時に `module.current_payload_version()` を `payload_schema_version` に書く
//! - 読み込み時に Eager-on-Read (ADR-0006 / `data-model.md` §7.2) でアップグレードを発火
//!
//! ## 保持戦略 (`module-contract.md` §5.1)
//!
//! `ScopedStorage` は **コマンド関数の中で都度生成**する。`Arc` clone のコストは無視できる。
//! 各 Tauri コマンドは `state.storage.scoped_for(module_arc)` で取得する。

use std::sync::Arc;

use serde_json::Value as JsonValue;

use crate::error::AppError;
use crate::module::ModuleBackend;
use crate::storage::sqlite::SqliteStorage;
use crate::storage::types::{Item, ItemId, ProjectId};

/// モジュールにスコープされたストレージハンドル。
///
/// `Arc<dyn ModuleBackend>` を保持するためライフタイムパラメータは持たず、async /
/// `spawn_blocking` をまたいで扱える。
#[derive(Clone)]
pub struct ScopedStorage {
    pub(crate) module: Arc<dyn ModuleBackend>,
    pub(crate) inner: Arc<SqliteStorage>,
}

impl std::fmt::Debug for ScopedStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopedStorage")
            .field("module_id", &self.module.id())
            .finish()
    }
}

impl ScopedStorage {
    /// 新規 item を作成する。
    ///
    /// - `search_text` は自動で `module.index_text(payload)` から生成される
    /// - `payload_schema_version` は `module.current_payload_version()` が入る
    /// - `created_at` / `updated_at` は現在 JST_ISO8601
    /// - ステートレスモジュール (`is_stateless = true`) で呼ぶと `AppError::StatelessModule`
    pub fn create_item(
        &self,
        project_id: &ProjectId,
        title: &str,
        tags: &[String],
        payload: JsonValue,
    ) -> Result<ItemId, AppError> {
        self.guard_stateless()?;
        self.module
            .validate_payload(&payload)
            .map_err(|e| e.into_app_error(self.module.id()))?;
        let module_id = self.module.id().to_string();
        let payload_schema_version = self.module.current_payload_version();
        let search_text = build_search_text(title, tags, &self.module.index_text(&payload));
        self.inner.create_item_internal(
            &module_id,
            project_id,
            title,
            tags,
            payload_schema_version,
            &payload,
            &search_text,
        )
    }

    /// item を更新する。`payload` の変更で `search_text` も再生成する (`data-model.md` §7.1)。
    pub fn update_item(
        &self,
        id: &ItemId,
        title: &str,
        tags: &[String],
        payload: JsonValue,
    ) -> Result<(), AppError> {
        self.guard_stateless()?;
        self.module
            .validate_payload(&payload)
            .map_err(|e| e.into_app_error(self.module.id()))?;
        let module_id = self.module.id().to_string();
        let payload_schema_version = self.module.current_payload_version();
        let search_text = build_search_text(title, tags, &self.module.index_text(&payload));
        self.inner.update_item_internal(
            &module_id,
            id,
            title,
            tags,
            payload_schema_version,
            &payload,
            &search_text,
        )
    }

    /// item を物理削除する。
    pub fn delete_item(&self, id: &ItemId) -> Result<(), AppError> {
        self.guard_stateless()?;
        let module_id = self.module.id().to_string();
        self.inner.delete_item_internal(&module_id, id)
    }

    /// item を 1 件取得する。
    ///
    /// **Eager-on-Read** (ADR-0006 / `data-model.md` §7.2):
    /// - `payload_schema_version > current_payload_version()` → `UnsupportedFuturePayloadVersion`
    /// - `< current` → `module.upgrade_payload` を順次適用 → 楽観的並行制御で UPDATE → 最新を返す
    /// - `== current` → そのまま返す (DB 書き換えなし)
    pub fn get_item(&self, id: &ItemId) -> Result<Item, AppError> {
        self.guard_stateless()?;
        let module_id = self.module.id().to_string();
        self.inner
            .get_item_with_eager_on_read(&module_id, id, self.module.as_ref())
    }

    /// プロジェクト内のモジュール item を一覧取得する。
    ///
    /// `module-contract.md` §5.1 通り **`project_id` 必須** (横断はコアの SearchService の責務)。
    /// `data-model.md` §7.2 に従い、low-level なリスト取得経路では Eager-on-Read を発火させない
    /// (個別アイテムの詳細表示時に発火)。
    pub fn list_items(
        &self,
        project_id: &ProjectId,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Item>, AppError> {
        self.guard_stateless()?;
        let module_id = self.module.id().to_string();
        self.inner
            .list_items_internal(&module_id, project_id, limit, offset)
    }

    fn guard_stateless(&self) -> Result<(), AppError> {
        if self.module.is_stateless() {
            Err(AppError::StatelessModule {
                module_id: self.module.id().to_string(),
            })
        } else {
            Ok(())
        }
    }
}

/// `search_text` を組み立てる (`module-contract.md` §3.2 / `data-model.md` §6.1):
/// `title + " " + tags.join(" ") + " " + module.index_text(payload)`
///
/// title / tags は共通カラムから StorageService が取り出して結合する責務。
/// `module.index_text` は payload 由来の文字列のみを返す (純粋関数)。
fn build_search_text(title: &str, tags: &[String], module_text: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_search_text_combines_title_tags_module_text() {
        let s = build_search_text("Hello", &["red".into(), "bold".into()], "module body");
        assert_eq!(s, "Hello red bold module body");
    }

    #[test]
    fn build_search_text_with_no_tags() {
        let s = build_search_text("Hello", &[], "module body");
        assert_eq!(s, "Hello module body");
    }

    #[test]
    fn build_search_text_with_empty_module_text() {
        let s = build_search_text("Hello", &["x".into()], "");
        assert_eq!(s, "Hello x");
    }

    #[test]
    fn build_search_text_title_only() {
        let s = build_search_text("Hello", &[], "");
        assert_eq!(s, "Hello");
    }
}
