/**
 * `core_search` Tauri コマンドのラッパー (`src-tauri/src/commands/search.rs`)。
 *
 * `scope` は discriminated union (`data-model.md` §11.1):
 * - `{ type: "project", project_id }` 単一プロジェクト内
 * - `{ type: "global" }` 全プロジェクト横断
 */
import { invoke } from "@tauri-apps/api/core";

import type { Item, ModuleId, SearchScope } from "@/lib/types";

export function search(input: {
  scope: SearchScope;
  query: string;
  /** 空配列 / 省略は全モジュール対象。`["prompt", "linkmemo"]` 等で絞れる */
  moduleFilter?: ModuleId[];
  limit?: number;
  offset?: number;
}): Promise<Item[]> {
  return invoke<Item[]>("core_search", {
    scope: input.scope,
    query: input.query,
    moduleFilter:
      input.moduleFilter != null && input.moduleFilter.length > 0 ? input.moduleFilter : null,
    limit: input.limit ?? 50,
    offset: input.offset ?? 0,
  });
}
