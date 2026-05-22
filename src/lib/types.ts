/**
 * バックエンド (`src-tauri/src/storage/types.rs`) と shape を一致させた TS 型定義。
 *
 * 同期は手動 (Phase 1 では `ts-rs` 等の自動生成は導入しない、ADR-0010 §3.10)。
 * バックエンド側でフィールドを変えた際は本ファイルも更新する。
 */

/** `Project` (`storage/types.rs::Project`) */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  position: number;
  created_at: string; // JST_ISO8601 (29 文字、ADR-0005)
  updated_at: string;
}

/** モジュール ID (`module-contract.md` §3.2、英小文字 + 数字のみ、3〜32 文字) */
export type ModuleId = "prompt" | "linkmemo" | "color" | "hash";

/**
 * `Item` (`storage/types.rs::Item`)。`payload` はモジュール固有の JSON で、コアからは
 * 不透明に扱う (`module-contract.md` §3.2)。各モジュールが TS 側で `payload` を
 * narrowing して使う。
 */
export interface Item {
  id: string;
  project_id: string;
  module_id: string;
  title: string;
  tags: string[];
  payload_schema_version: number;
  payload: unknown;
  /** D&D 並び順 (`data-model.md` §6.5)。(project_id, module_id) スコープ内で 0..N-1 */
  position: number;
  created_at: string; // JST_ISO8601
  updated_at: string;
}

/** 検索スコープ (`data-model.md` §11.1、内部値は `"project" | "global"`) */
export type SearchScope = { type: "project"; project_id: string } | { type: "global" };

// -------- モジュール固有 payload --------

/** M-Prompt payload v1 (`data-model.md` §10.1) */
export interface PromptPayloadV1 {
  body: string;
}

/** M-LinkMemo payload v1 (`data-model.md` §10.2) */
export interface LinkMemoPayloadV1 {
  type: "url" | "path" | "memo";
  target: string | null;
  body: string;
}

/** M-Color payload v1 (`data-model.md` §10.3) */
export interface ColorPayloadV1 {
  hex: string;
}
