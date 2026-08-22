/**
 * `useAppStore` の挙動確認 (theme toggle / sidebar 幅クランプ)。
 *
 * 永続化は別レイヤの settings.json 同期が担うため、この store は localStorage を触らない。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "./useAppStore";

describe("useAppStore", () => {
  beforeEach(() => {
    // 各テストで store をクリーンに
    useAppStore.setState({
      theme: "light",
      sidebarWidth: 240,
      uiScale: 1.0,
      rowDensity: "compact",
      lastOpenedModuleId: null,
      lastOpenedProjectId: null,
      defaultProjectId: null,
      searchDefaultScope: "project",
      logLevel: "info",
      moduleEnabled: {},
      settingsDocument: null,
      settingsHydrated: false,
      settingsError: null,
    });
    localStorage.clear();
  });

  it("does not write application state to localStorage", () => {
    useAppStore.getState().setTheme("dark");
    useAppStore.getState().setSidebarWidth(300);
    expect(localStorage.length).toBe(0);
  });

  it("toggleTheme switches between light and dark", () => {
    expect(useAppStore.getState().theme).toBe("light");
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("dark");
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("light");
  });

  it("setSidebarWidth clamps to [180, 320]", () => {
    useAppStore.getState().setSidebarWidth(50);
    expect(useAppStore.getState().sidebarWidth).toBe(180);

    useAppStore.getState().setSidebarWidth(500);
    expect(useAppStore.getState().sidebarWidth).toBe(320);

    useAppStore.getState().setSidebarWidth(220);
    expect(useAppStore.getState().sidebarWidth).toBe(220);
  });

  it("setLastOpenedModuleId / setLastOpenedProjectId persist values", () => {
    useAppStore.getState().setLastOpenedModuleId("prompt");
    useAppStore.getState().setLastOpenedProjectId("p-uuid");
    expect(useAppStore.getState().lastOpenedModuleId).toBe("prompt");
    expect(useAppStore.getState().lastOpenedProjectId).toBe("p-uuid");

    useAppStore.getState().setLastOpenedModuleId(null);
    expect(useAppStore.getState().lastOpenedModuleId).toBeNull();
  });

  it("setUiScale clamps to [0.75, 1.5] and rounds to 2 decimals", () => {
    useAppStore.getState().setUiScale(0.5);
    expect(useAppStore.getState().uiScale).toBe(0.75);

    useAppStore.getState().setUiScale(2);
    expect(useAppStore.getState().uiScale).toBe(1.5);

    useAppStore.getState().setUiScale(1.234);
    expect(useAppStore.getState().uiScale).toBe(1.23);
  });

  it("setUiScale falls back to 1.0 for non-finite input", () => {
    useAppStore.getState().setUiScale(NaN);
    expect(useAppStore.getState().uiScale).toBe(1.0);

    useAppStore.getState().setUiScale(Infinity);
    expect(useAppStore.getState().uiScale).toBe(1.0);
  });

  it("setRowDensity persists between compact and comfortable", () => {
    expect(useAppStore.getState().rowDensity).toBe("compact");
    useAppStore.getState().setRowDensity("comfortable");
    expect(useAppStore.getState().rowDensity).toBe("comfortable");
    useAppStore.getState().setRowDensity("compact");
    expect(useAppStore.getState().rowDensity).toBe("compact");
  });
});
