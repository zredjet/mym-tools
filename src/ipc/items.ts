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
