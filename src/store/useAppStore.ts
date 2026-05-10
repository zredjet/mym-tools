/**
 * アプリ全体状態の Zustand 単一ストア
 * (`docs/architecture.md` §2.3 / CLAUDE.md 不変条件)。
 *
 * **不変条件**: アプリ全体状態 (現在プロジェクト / 現在モジュール / テーマ / 設定) は
 * ここに集約。モジュール内のローカル状態は `useState` でよい。Context には逃さない。
 *
 * Phase 1 では永続化は localStorage のみ (theme / sidebar 幅 / lastOpenedModule)。
 * `settings.json` 化は別 PR (C-7 設定ページ実装時) で `persist` middleware の保存先を
 * 切り替える。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type { ModuleId } from "@/lib/types";

/** UI テーマ */
export type Theme = "light" | "dark";

interface AppState {
  /** 現在のテーマ (`<html data-theme>` に反映される) */
  theme: Theme;
  /** サイドバー幅 (px、180-320 の範囲、`docs/ui-design.md` §2.3) */
  sidebarWidth: number;
  /**
   * UI 全体のスケール (CSS `zoom` で適用)。1.0 = 100%。範囲は 0.75-1.5 (75-150%)。
   * 文字 / spacing / swatch すべて一緒に拡縮する Linear / Slack 風の "Interface zoom"。
   * 行高 / sidebar 幅 / page padding 等は本値とは独立 (細かい density 調整は別途
   * 設定項目を将来追加する余地)。
   */
  uiScale: number;
  /** 直近に開いていたモジュール ID (新セッション再開時の復元用) */
  lastOpenedModuleId: ModuleId | null;
  /** 直近に開いていたプロジェクト ID (再開時の復元用) */
  lastOpenedProjectId: string | null;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setSidebarWidth: (width: number) => void;
  setUiScale: (scale: number) => void;
  setLastOpenedModuleId: (id: ModuleId | null) => void;
  setLastOpenedProjectId: (id: string | null) => void;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 320;
const SIDEBAR_DEFAULT = 240;

/** UI scale プリセット候補 (Settings UI の選択肢) と clamp 範囲 */
export const UI_SCALE_PRESETS = [0.8, 0.9, 1.0, 1.15, 1.3] as const;
const UI_SCALE_MIN = 0.75;
const UI_SCALE_MAX = 1.5;
const UI_SCALE_DEFAULT = 1.0;

const clampWidth = (w: number): number =>
  Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));

const clampUiScale = (s: number): number => {
  if (!Number.isFinite(s)) return UI_SCALE_DEFAULT;
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(s * 100) / 100));
};

const detectInitialTheme = (): Theme => {
  if (typeof window === "undefined") return "light";
  // OS の prefers-color-scheme を初期値に。以後の変更は明示操作のみ反映
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: detectInitialTheme(),
      sidebarWidth: SIDEBAR_DEFAULT,
      uiScale: UI_SCALE_DEFAULT,
      lastOpenedModuleId: null,
      lastOpenedProjectId: null,

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
      setUiScale: (scale) => set({ uiScale: clampUiScale(scale) }),
      setLastOpenedModuleId: (id) => set({ lastOpenedModuleId: id }),
      setLastOpenedProjectId: (id) => set({ lastOpenedProjectId: id }),
    }),
    {
      name: "mymtools-app-state",
      storage: createJSONStorage(() => localStorage),
      // すべて localStorage に永続化
      partialize: (s) => ({
        theme: s.theme,
        sidebarWidth: s.sidebarWidth,
        uiScale: s.uiScale,
        lastOpenedModuleId: s.lastOpenedModuleId,
        lastOpenedProjectId: s.lastOpenedProjectId,
      }),
    },
  ),
);
