import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppShellOutletContext } from "@/components/shell/AppShell";
import { listBackups } from "@/ipc/backup";
import { importJson, type ImportSummary } from "@/ipc/transfer";

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
