/**
 * アプリ全体状態の Zustand 単一ストア。
 * 永続化は `settings.json` のみを使い、Zustand persist / localStorage は使わない
 * (`docs/decisions/0002-frontend-stack.md` §4.4.3)。
 */
import { create } from "zustand";

import type { LogLevel, SearchDefaultScope, SettingsDocument, ThemeSetting } from "@/lib/settings";
import { parseSettingsDocument } from "@/lib/settings";
import type { ModuleId } from "@/lib/types";

export type Theme = ThemeSetting;
export type RowDensity = "compact" | "comfortable";

interface AppState {
  theme: Theme;
  sidebarWidth: number;
  uiScale: number;
  rowDensity: RowDensity;
  defaultProjectId: string | null;
  lastOpenedModuleId: ModuleId | null;
  lastOpenedProjectId: string | null;
  searchDefaultScope: SearchDefaultScope;
  logLevel: LogLevel;
  moduleEnabled: Partial<Record<ModuleId, boolean>>;
  collapsedModuleCategories: string[];
  settingsDocument: SettingsDocument | null;
  settingsHydrated: boolean;
  settingsError: string | null;

  hydrateSettings: (document: SettingsDocument, knownModuleIds: readonly ModuleId[]) => void;
  setSettingsError: (message: string | null) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setSidebarWidth: (width: number) => void;
  setUiScale: (scale: number) => void;
  setRowDensity: (density: RowDensity) => void;
  setDefaultProjectId: (id: string | null) => void;
  setLastOpenedModuleId: (id: ModuleId | null) => void;
  setLastOpenedProjectId: (id: string | null) => void;
  setSearchDefaultScope: (scope: SearchDefaultScope) => void;
  setLogLevel: (level: LogLevel) => void;
  setModuleEnabled: (id: ModuleId, enabled: boolean) => void;
  setModuleCategoryCollapsed: (id: string, collapsed: boolean) => void;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 320;
const SIDEBAR_DEFAULT = 240;

export const UI_SCALE_PRESETS = [0.8, 0.9, 1.0, 1.15, 1.3] as const;
const UI_SCALE_MIN = 0.75;
const UI_SCALE_MAX = 1.5;
const UI_SCALE_DEFAULT = 1.0;

export const ROW_DENSITY_PX: Record<RowDensity, number> = {
  compact: 32,
  comfortable: 36,
};

const clampWidth = (width: number): number =>
  Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)));

const clampUiScale = (scale: number): number => {
  if (!Number.isFinite(scale)) return UI_SCALE_DEFAULT;
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(scale * 100) / 100));
};

export const useAppStore = create<AppState>()((set) => ({
  theme: "system",
  sidebarWidth: SIDEBAR_DEFAULT,
  uiScale: UI_SCALE_DEFAULT,
  rowDensity: "compact",
  defaultProjectId: null,
  lastOpenedModuleId: null,
  lastOpenedProjectId: null,
  searchDefaultScope: "project",
  logLevel: "info",
  moduleEnabled: {},
  collapsedModuleCategories: [],
  settingsDocument: null,
  settingsHydrated: false,
  settingsError: null,

  hydrateSettings: (document, knownModuleIds) => {
    const parsed = parseSettingsDocument(document, knownModuleIds);
    set({
      ...parsed,
      settingsDocument: document,
      settingsHydrated: true,
      settingsError: null,
    });
  },
  setSettingsError: (settingsError) => set({ settingsError }),
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === "dark" ? "light" : "dark" })),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: clampWidth(sidebarWidth) }),
  setUiScale: (uiScale) => set({ uiScale: clampUiScale(uiScale) }),
  setRowDensity: (rowDensity) => set({ rowDensity }),
  setDefaultProjectId: (defaultProjectId) => set({ defaultProjectId }),
  setLastOpenedModuleId: (lastOpenedModuleId) => set({ lastOpenedModuleId }),
  setLastOpenedProjectId: (lastOpenedProjectId) => set({ lastOpenedProjectId }),
  setSearchDefaultScope: (searchDefaultScope) => set({ searchDefaultScope }),
  setLogLevel: (logLevel) => set({ logLevel }),
  setModuleEnabled: (id, enabled) =>
    set((state) => ({ moduleEnabled: { ...state.moduleEnabled, [id]: enabled } })),
  setModuleCategoryCollapsed: (id, collapsed) =>
    set((state) => {
      const current = new Set(state.collapsedModuleCategories);
      if (collapsed) current.add(id);
      else current.delete(id);
      return { collapsedModuleCategories: [...current] };
    }),
}));
