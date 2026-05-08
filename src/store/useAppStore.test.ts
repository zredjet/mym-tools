/**
 * `useAppStore` の挙動確認 (theme toggle / sidebar 幅クランプ)。
 *
 * persist middleware は localStorage に書き込むが、jsdom 環境では in-memory な
 * `Storage` 実装が提供されるため副作用は他テストに漏れない (各テスト内で初期化)。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "./useAppStore";

describe("useAppStore", () => {
  beforeEach(() => {
    // 各テストで store をクリーンに
    useAppStore.setState({
      theme: "light",
      sidebarWidth: 240,
      lastOpenedModuleId: null,
      lastOpenedProjectId: null,
    });
    localStorage.clear();
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
});
