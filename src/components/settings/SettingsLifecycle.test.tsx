import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSettings, updateSettings } from "@/ipc/settings";
import { getBackendModuleIds } from "@/ipc/modules";
import { useAppStore } from "@/store/useAppStore";

import { SettingsLifecycle } from "./SettingsLifecycle";

vi.mock("@/ipc/settings", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("@/ipc/modules", () => ({ getBackendModuleIds: vi.fn() }));

const document = {
  schema_version: 1,
  core: { theme: "light", future_key: "keep" },
  modules: {},
};

describe("SettingsLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getSettings).mockResolvedValue(document);
    vi.mocked(getBackendModuleIds).mockResolvedValue(["color", "hash", "linkmemo", "prompt"]);
    vi.mocked(updateSettings).mockResolvedValue(undefined);
    useAppStore.setState({
      settingsDocument: null,
      settingsHydrated: false,
      settingsError: null,
      theme: "system",
      moduleEnabled: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("loads once and saves the latest state after a 500ms debounce", async () => {
    render(
      <SettingsLifecycle>
        <span>アプリ本体</span>
      </SettingsLifecycle>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("アプリ本体")).toBeInTheDocument();
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();

    act(() => useAppStore.getState().setTheme("dark"));
    act(() => vi.advanceTimersByTime(499));
    expect(updateSettings).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        core: expect.objectContaining({ theme: "dark", future_key: "keep" }),
      }),
    );
  });

  it("flushes the latest state when unmounted during the debounce window", async () => {
    const view = render(
      <SettingsLifecycle>
        <span>アプリ本体</span>
      </SettingsLifecycle>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    act(() => useAppStore.getState().setTheme("dark"));
    act(() => view.unmount());

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        core: expect.objectContaining({ theme: "dark", future_key: "keep" }),
      }),
    );
  });

  it("stops startup when frontend and backend registries differ", async () => {
    vi.mocked(getBackendModuleIds).mockResolvedValue(["hash", "prompt"]);

    render(
      <SettingsLifecycle>
        <span>表示してはいけない</span>
      </SettingsLifecycle>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("表示してはいけない")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("module registry mismatch");
  });
});
