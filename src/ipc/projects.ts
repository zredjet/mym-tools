/**
 * `core_*` プロジェクト Tauri コマンドの型付きラッパー
 * (`src-tauri/src/commands/projects.rs`)。
 *
 * 直接 `invoke()` を呼ばず本ラッパーを通すことで、コマンド名のタイポと引数の構造化を
 * 1 箇所に閉じ込める。
 */
import { invoke } from "@tauri-apps/api/core";

import type { Project } from "@/lib/types";

export function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("core_list_projects");
}

export function getProject(id: string): Promise<Project> {
  return invoke<Project>("core_get_project", { id });
}

export function createProject(input: {
  name: string;
  description?: string | null;
}): Promise<Project> {
  return invoke<Project>("core_create_project", {
    name: input.name,
    description: input.description ?? null,
  });
}

export function updateProject(input: {
  id: string;
  name: string;
  description?: string | null;
}): Promise<void> {
  return invoke<void>("core_update_project", {
    id: input.id,
    name: input.name,
    description: input.description ?? null,
  });
}

export function deleteProject(id: string): Promise<void> {
  return invoke<void>("core_delete_project", { id });
}
