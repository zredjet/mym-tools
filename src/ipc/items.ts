/**
 * `core_*` items Tauri コマンドの型付きラッパー
 * (`src-tauri/src/commands/items.rs`)。
 *
 * `module_id` を引数で渡し、バックエンド側で `state.modules` から `ModuleBackend` を
 * 引き当てる。フロントは ID 文字列だけ持って各 IPC を呼ぶ設計
 * (`module-contract.md` §6.2: `core_*` は Shell / 共通フックからのみ呼ぶ)。
 */
import { invoke } from "@tauri-apps/api/core";

import type { Item, ModuleId } from "@/lib/types";

export function listItemSummaries(input: {
  moduleId: ModuleId;
  projectId: string;
  limit?: number;
  offset?: number;
}) {
  return invoke<import("@/lib/types").ItemSummary[]>("core_list_item_summaries", {
    ...input,
    limit: input.limit ?? 100,
    offset: input.offset ?? 0,
  });
}

export function listItems(input: {
  moduleId: ModuleId;
  projectId: string;
  limit?: number;
  offset?: number;
}): Promise<Item[]> {
  return invoke<Item[]>("core_list_items", {
    moduleId: input.moduleId,
    projectId: input.projectId,
    limit: input.limit ?? 100,
    offset: input.offset ?? 0,
  });
}

/**
 * 並び替えなどスコープ内の全 ID が必要な画面向けに、100 件ずつ全ページを取得する。
 */
export async function listAllItems(input: {
  moduleId: ModuleId;
  projectId: string;
}): Promise<Item[]> {
  const pageSize = 100;
  const items: Item[] = [];
  let offset = 0;

  while (true) {
    const page = await listItems({ ...input, limit: pageSize, offset });
    items.push(...page);
    if (page.length < pageSize) return items;
    offset += page.length;
  }
}

/**
 * payload を含まない一覧 (`ItemSummary`) を 100 件ずつ全ページ取得する。大きな payload を持つ
 * モジュール (Mermaid / Diagram / Vector) の文書選択など、表示に payload が要らない画面向け。
 * 並び順はバックエンドの `updated_at DESC, id DESC`。
 */
export async function listAllItemSummaries(input: {
  moduleId: ModuleId;
  projectId: string;
}): Promise<import("@/lib/types").ItemSummary[]> {
  const pageSize = 100;
  const items: import("@/lib/types").ItemSummary[] = [];
  let offset = 0;

  while (true) {
    const page = await listItemSummaries({ ...input, limit: pageSize, offset });
    items.push(...page);
    if (page.length < pageSize) return items;
    offset += page.length;
  }
}

export function getItem(input: { moduleId: ModuleId; itemId: string }): Promise<Item> {
  return invoke<Item>("core_get_item", {
    moduleId: input.moduleId,
    itemId: input.itemId,
  });
}

export function createItem(input: {
  moduleId: ModuleId;
  projectId: string;
  title: string;
  tags: string[];
  payload: unknown;
}): Promise<string> {
  return invoke<string>("core_create_item", {
    moduleId: input.moduleId,
    projectId: input.projectId,
    title: input.title,
    tags: input.tags,
    payload: input.payload,
  });
}

export function updateItem(input: {
  moduleId: ModuleId;
  itemId: string;
  title: string;
  tags: string[];
  payload: unknown;
}): Promise<void> {
  return invoke<void>("core_update_item", {
    moduleId: input.moduleId,
    itemId: input.itemId,
    title: input.title,
    tags: input.tags,
    payload: input.payload,
  });
}

export function deleteItem(input: { moduleId: ModuleId; itemId: string }): Promise<void> {
  return invoke<void>("core_delete_item", {
    moduleId: input.moduleId,
    itemId: input.itemId,
  });
}

/**
 * `(projectId, moduleId)` スコープ内の items を `orderedIds` の順序で並び替える
 * (`docs/data-model.md` §6.5、PR-Y / ADR-0011)。
 *
 * 楽観的更新パターン: 呼び出し前にローカル state を `arrayMove` で更新済とし、
 * 失敗時は refetch (list 再取得) で旧順序に巻き戻す (Sidebar D&D と同パターン、
 * `docs/ui-design.md` §3.3.1)。
 */
export function reorderItems(input: {
  projectId: string;
  moduleId: ModuleId;
  orderedIds: string[];
}): Promise<void> {
  return invoke<void>("core_reorder_items", {
    projectId: input.projectId,
    moduleId: input.moduleId,
    orderedIds: input.orderedIds,
  });
}
