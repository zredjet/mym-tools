import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppShellOutletContext } from "@/components/shell/AppShell";
import { listBackups, restoreBackup } from "@/ipc/backup";
import { exportJson, importJson, type ExportSummary, type ImportSummary } from "@/ipc/transfer";
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

function exportSummary(notUpgraded: ExportSummary["not_upgraded"]): ExportSummary {
  return {
    schema_version: 1,
    exported_at: "2026-11-15T10:00:00.000+09:00",
    app_version: "0.1.0",
    scope: "app",
    module_versions: { vector: 2 },
    projects_count: 1,
    items_count: 3,
    bytes_written: 2048,
    not_upgraded: notUpgraded,
  };
}

describe("SettingsPage export", () => {
  beforeEach(() => {
    vi.mocked(listBackups).mockResolvedValue([]);
    dialog.save.mockResolvedValue("/tmp/out.mymtools.json");
  });

  it("shows the items written in their old format", async () => {
    vi.mocked(exportJson).mockResolvedValue(
      exportSummary([
        {
          id: "item-1",
          module_id: "vector",
          title: "古い作品",
          payload_schema_version: 1,
          reason: "SVG が今の検証を通りません: 未対応のSVG要素です: script",
        },
      ]),
    );
    renderSettings(vi.fn().mockResolvedValue(undefined));

    fireEvent.click(await screen.findByRole("button", { name: /JSON にエクスポート/ }));

    expect(await screen.findByText("エクスポート完了")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "1 件は新しい形式に変換できないため、元の形式のまま書き出しました。",
    );
    expect(alert).toHaveTextContent("失敗として数えられます");
    expect(alert).toHaveTextContent("古い作品");
    expect(alert).toHaveTextContent("vector / item-1");
    expect(alert).toHaveTextContent("未対応のSVG要素です: script");
  });

  it("shows no notice when every item was converted", async () => {
    vi.mocked(exportJson).mockResolvedValue(exportSummary([]));
    renderSettings(vi.fn().mockResolvedValue(undefined));

    fireEvent.click(await screen.findByRole("button", { name: /JSON にエクスポート/ }));

    expect(await screen.findByText("エクスポート完了")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SettingsPage restore", () => {
  const record = {
    path: "/data/backups/manual/manual-2026-11-15T10-00-00.000+09-00-r3.sqlite",
    kind: { type: "manual" as const },
    created_at: "2026-11-15T10:00:00.000+09:00",
    data_revision: 3,
    size_bytes: 4096,
  };
  const name = "manual-2026-11-15T10-00-00.000+09-00-r3.sqlite";

  async function confirmRestore() {
    renderSettings(vi.fn().mockResolvedValue(undefined));
    fireEvent.click(await screen.findByRole("button", { name: "このバックアップに戻す" }));
    fireEvent.change(screen.getByLabelText("削除確認"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "リストアを削除" }));
  }

  beforeEach(() => {
    vi.mocked(listBackups).mockResolvedValue([record]);
  });

  it("変換の前のバックアップを取れなくても、再起動を促し、理由を出す", async () => {
    vi.mocked(restoreBackup).mockResolvedValue({ payload_backup_error: "disk full" });
    await confirmRestore();
    expect(await screen.findByText("アプリを再起動してください")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("変換の前のバックアップ");
    expect(alert).toHaveTextContent("disk full");
    expect(alert).toHaveTextContent("次の起動でもう一度取ります");
  });

  it("取れたときは知らせを出さない", async () => {
    vi.mocked(restoreBackup).mockResolvedValue({ payload_backup_error: null });
    await confirmRestore();
    expect(await screen.findByText("アプリを再起動してください")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("リストアの失敗は、AppError の理由を確認のダイアログに出す", async () => {
    vi.mocked(restoreBackup).mockRejectedValue({
      code: "storage",
      message: "integrity check failed",
    });
    await confirmRestore();
    expect(await screen.findByText(/integrity check failed/)).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
    expect(screen.queryByText("アプリを再起動してください")).not.toBeInTheDocument();
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
