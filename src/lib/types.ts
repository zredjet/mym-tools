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
