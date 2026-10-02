import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppShellOutletContext } from "@/components/shell/AppShell";
import { listBackups } from "@/ipc/backup";
import { importJson, type ImportSummary } from "@/ipc/transfer";
import { useAppStore } from "@/store/useAppStore";

import { SettingsPage } from "./SettingsPage";

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("@/ipc/backup", () => ({
  deleteBackup: vi.fn(),
  listBackups: vi.fn(),
  restoreBackup: vi.fn(),
  takeManualBackup: vi.fn(),
}));
vi.mock("@/ipc/transfer", () => ({
  exportJson: vi.fn(),
  importJson: vi.fn(),
  suggestExportFileName: vi.fn(() => "export.mymtools.json"),
}));

function summary(projectsInserted: number): ImportSummary {
  return {
    projects_inserted: projectsInserted,
    projects_skipped: 0,
    projects_failed: 0,
    items_inserted: 0,
    items_skipped: 0,
    items_failed: 0,
    failures: [],
  };
}

function renderSettings(refreshProjects: () => Promise<void>) {
  const context: AppShellOutletContext = { projects: [], refreshProjects };
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={context} />,
        children: [{ path: "/settings", element: <SettingsPage /> }],
      },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
}

describe("SettingsPage import", () => {
  beforeEach(() => {
    vi.mocked(listBackups).mockResolvedValue([]);
    dialog.open.mockResolvedValue("/tmp/in.mymtools.json");
  });

  it("reloads the sidebar projects after importing new projects", async () => {
    vi.mocked(importJson).mockResolvedValue(summary(2));
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    renderSettings(refreshProjects);

    fireEvent.click(await screen.findByRole("button", { name: /JSON からインポート/ }));

    await waitFor(() => expect(refreshProjects).toHaveBeenCalledOnce());
    expect(importJson).toHaveBeenCalledWith("/tmp/in.mymtools.json");
  });

  it("does not reload projects when nothing new was imported", async () => {
    vi.mocked(importJson).mockResolvedValue(summary(0));
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    renderSettings(refreshProjects);

    fireEvent.click(await screen.findByRole("button", { name: /JSON からインポート/ }));

    expect(await screen.findByText("インポート完了")).toBeInTheDocument();
    expect(refreshProjects).not.toHaveBeenCalled();
  });
});

describe("SettingsPage Link section", () => {
  beforeEach(() => {
    vi.mocked(listBackups).mockResolvedValue([]);
    useAppStore.setState({ moduleEnabled: {}, moduleSettings: {} });
  });

  it("adds and removes servers that open without confirmation", async () => {
    renderSettings(vi.fn().mockResolvedValue(undefined));
    expect(await screen.findByText("確認せずに開くネットワーク上のサーバ")).toBeInTheDocument();
    expect(screen.getByText("登録したサーバはありません。")).toBeInTheDocument();

    const input = screen.getByLabelText("サーバ名");
    fireEvent.change(input, { target: { value: "nas share" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(screen.getByRole("alert")).toHaveTextContent("サーバ名を入力してください");

    fireEvent.change(input, { target: { value: String.raw`\\NAS\share\docs` } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect(await screen.findByText("nas")).toBeInTheDocument();
    expect(useAppStore.getState().moduleSettings["linkmemo"]).toEqual({
      trusted_network_hosts: ["nas"],
    });

    fireEvent.click(screen.getByRole("button", { name: "nas を削除" }));
    expect(await screen.findByText("登録したサーバはありません。")).toBeInTheDocument();
    expect(useAppStore.getState().moduleSettings["linkmemo"]).toEqual({
      trusted_network_hosts: [],
    });
  });

  it("hides the section while the Link module is disabled", async () => {
    useAppStore.setState({ moduleEnabled: { linkmemo: false } });
    renderSettings(vi.fn().mockResolvedValue(undefined));
    expect(await screen.findByText("基本設定")).toBeInTheDocument();
    expect(screen.queryByText("確認せずに開くネットワーク上のサーバ")).not.toBeInTheDocument();
  });
});
