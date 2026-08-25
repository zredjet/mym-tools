/** `settings.json` と Zustand state の相互変換 (`docs/data-model.md` §11)。 */

import type { ModuleId } from "@/lib/types";

export type ThemeSetting = "system" | "light" | "dark";
export type SearchDefaultScope = "project" | "global";
export type LogLevel = "info" | "debug" | "warn" | "error";
export type RowDensitySetting = "compact" | "comfortable";

export interface SettingsDocument extends Record<string, unknown> {
  schema_version: number;
  core: Record<string, unknown>;
  modules: Record<string, unknown>;
}

export interface AppSettingsSnapshot {
  theme: ThemeSetting;
  defaultProjectId: string | null;
  lastOpenedProjectId: string | null;
  lastOpenedModuleId: ModuleId | null;
  searchDefaultScope: SearchDefaultScope;
  logLevel: LogLevel;
  sidebarWidth: number;
  uiScale: number;
  rowDensity: RowDensitySetting;
  moduleEnabled: Partial<Record<ModuleId, boolean>>;
  collapsedModuleCategories: string[];
}

const DEFAULTS: AppSettingsSnapshot = {
  theme: "system",
  defaultProjectId: null,
  lastOpenedProjectId: null,
  lastOpenedModuleId: null,
  searchDefaultScope: "project",
  logLevel: "info",
  sidebarWidth: 240,
  uiScale: 1,
  rowDensity: "compact",
  moduleEnabled: {},
  collapsedModuleCategories: [],
};

export function parseSettingsDocument(
  input: unknown,
  knownModuleIds: readonly ModuleId[] = [],
): AppSettingsSnapshot {
  const root = asRecord(input);
  const core = asRecord(root?.["core"]);
  const search = asRecord(core?.["search"]);
  const enabled = asRecord(core?.["module_enabled"]);
  const known = new Set(knownModuleIds);
  const moduleEnabled: Partial<Record<ModuleId, boolean>> = {};
  if (enabled != null) {
    for (const [id, value] of Object.entries(enabled)) {
      if ((known.size === 0 || known.has(id)) && typeof value === "boolean") {
        moduleEnabled[id] = value;
      }
    }
    // Link / Memo 分離前の明示設定だけを一度継承する。memo が既にあれば個別設定を尊重する。
    if (
      known.has("memo") &&
      moduleEnabled.memo == null &&
      typeof enabled["linkmemo"] === "boolean"
    ) {
      moduleEnabled.memo = enabled["linkmemo"];
    }
  }

  const lastModule = stringOrNull(core?.["last_opened_module_id"]);
  return {
    theme: isTheme(core?.["theme"]) ? core["theme"] : DEFAULTS.theme,
    defaultProjectId: stringOrNull(core?.["default_project_id"]),
    lastOpenedProjectId: stringOrNull(core?.["last_opened_project_id"]),
    lastOpenedModuleId:
      lastModule != null && (known.size === 0 || known.has(lastModule)) ? lastModule : null,
    searchDefaultScope:
      search?.["default_scope"] === "global" ? "global" : DEFAULTS.searchDefaultScope,
    logLevel: isLogLevel(core?.["log_level"]) ? core["log_level"] : DEFAULTS.logLevel,
    sidebarWidth: clampNumber(core?.["sidebar_width"], 180, 320, DEFAULTS.sidebarWidth, true),
    uiScale: clampNumber(core?.["ui_scale"], 0.75, 1.5, DEFAULTS.uiScale, false),
    rowDensity: core?.["row_density"] === "comfortable" ? "comfortable" : DEFAULTS.rowDensity,
    moduleEnabled,
    collapsedModuleCategories: stringArray(core?.["collapsed_module_categories"]),
  };
}

/** 読み込み時の未知キーを保持したまま、既知の現在値だけを上書きする。 */
export function mergeSettingsDocument(
  input: unknown,
  settings: AppSettingsSnapshot,
): SettingsDocument {
  const original = asRecord(input) ?? {};
  const originalCore = asRecord(original["core"]) ?? {};
  const originalSearch = asRecord(originalCore["search"]) ?? {};
  const originalModuleEnabled = asRecord(originalCore["module_enabled"]) ?? {};
  const originalModules = asRecord(original["modules"]) ?? {};
  return {
    ...original,
    schema_version: 1,
    core: {
      ...originalCore,
      theme: settings.theme,
      default_project_id: settings.defaultProjectId,
      last_opened_project_id: settings.lastOpenedProjectId,
      last_opened_module_id: settings.lastOpenedModuleId,
      search: { ...originalSearch, default_scope: settings.searchDefaultScope },
      log_level: settings.logLevel,
      sidebar_width: settings.sidebarWidth,
      ui_scale: settings.uiScale,
      row_density: settings.rowDensity,
      module_enabled: { ...originalModuleEnabled, ...settings.moduleEnabled },
      collapsed_module_categories: settings.collapsedModuleCategories,
    },
    modules: { ...originalModules },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is string => typeof item === "string" && item !== "")),
  ];
}

function isTheme(value: unknown): value is ThemeSetting {
  return value === "system" || value === "light" || value === "dark";
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "info" || value === "debug" || value === "warn" || value === "error";
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  integer: boolean,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.max(min, Math.min(max, value));
  return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}
