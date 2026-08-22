/**
 * Export / Import JSON の型付き Tauri ラッパー
 * (`src-tauri/src/commands/transfer.rs` / `docs/data-model.md` §12)。
 *
 * - **Export**: アプリ全体または指定プロジェクトを `path` に書き出す
 * - **Import**: `path` の JSON を読み取り、現在 DB に取り込む (部分成功方式)
 *
 * 真のエラー (ファイル読めない / schema_version 未対応) は Promise reject、
 * 個別 item の skip / 失敗は `ImportSummary` の集計値に乗る。
 */
import { invoke } from "@tauri-apps/api/core";

/** `.mymtools.json` の `scope` フィールド (`data-model.md` §12.1)。 */
export type ExportScope = "app" | "project";

/** インポート 1 件あたりの失敗内訳 (`exchange/mod.rs::ImportFailure`) */
export interface ImportFailure {
  entity: "project" | "item";
  id: string;
  module_id?: string;
  reason: string;
}

/** インポート完了サマリ (`exchange/mod.rs::ImportSummary`) */
export interface ImportSummary {
  projects_inserted: number;
  projects_skipped: number;
  projects_failed: number;
  items_inserted: number;
  items_skipped: number;
  items_failed: number;
  failures: ImportFailure[];
}

/**
 * エクスポート完了サマリ (`exchange/mod.rs::ExportSummary`)。
 *
 * フル `ExportData` ではなく集計値のみが IPC で返る (codex PR-Z P2 対応)。
 * フロントは件数とメタしか表示しないため、全アイテム payload を再転送する
 * コストを避ける。
 */
export interface ExportSummary {
  schema_version: number;
  exported_at: string;
  app_version: string;
  scope: ExportScope;
  module_versions: Record<string, number>;
  projects_count: number;
  items_count: number;
  /** 書き出した JSON ファイルのバイト数 (ユーザーへサイズ感を表示) */
  bytes_written: number;
}

export function exportJson(input: {
  path: string;
  scope: ExportScope;
  projectId?: string | null;
}): Promise<ExportSummary> {
  return invoke<ExportSummary>("core_export_json", {
    path: input.path,
    scope: input.scope,
    projectId: input.scope === "project" ? (input.projectId ?? null) : null,
  });
}

export function importJson(path: string): Promise<ImportSummary> {
  return invoke<ImportSummary>("core_import_json", { path });
}

/** Export JSON のおすすめファイル名 (Settings UI から呼ぶ) */
export function suggestExportFileName(): string {
  // JST ISO8601 から `YYYYMMDD-HHMMSS` を作る (`data-model.md` §13.1.1 と同方針)
  const now = new Date();
  const offsetMs = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + offsetMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp =
    `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}-` +
    `${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`;
  return `mymtools-${stamp}.mymtools.json`;
}
