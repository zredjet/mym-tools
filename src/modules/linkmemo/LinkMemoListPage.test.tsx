import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listAllItems } from "@/ipc/items";
import { linkmemoOpen } from "@/ipc/linkmemo";
import type { Item } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

import { LinkMemoListPage } from "./LinkMemoListPage";

vi.mock("@/ipc/items", () => ({
  deleteItem: vi.fn(),
  listAllItems: vi.fn(),
  reorderItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
}));
vi.mock("@/ipc/linkmemo", () => ({ linkmemoOpen: vi.fn(), linkmemoNormalizeTarget: vi.fn() }));

function pathLink(id: string, title: string, target: string): Item {
  return {
    id,
    project_id: "project-1",
    module_id: "linkmemo",
    title,
    tags: [],
    payload_schema_version: 1,
    payload: { type: "path", target, body: "" },
    position: 0,
    created_at: "",
    updated_at: "",
  };
}

function renderList() {
  render(
    <MemoryRouter initialEntries={["/projects/project-1/m/linkmemo"]}>
      <Routes>
        <Route path="/projects/:projectId/m/linkmemo" element={<LinkMemoListPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Link list", () => {
  beforeEach(() => {
    vi.mocked(linkmemoOpen).mockReset();
    useAppStore.setState({ moduleSettings: {} });
    vi.mocked(listAllItems).mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `link-${index}`,
        project_id: "project-1",
        module_id: "linkmemo",
        title: `Link ${index}`,
        tags: [],
        payload_schema_version: 1,
        payload: { type: "url", target: `https://example.com/${index}`, body: "" },
        position: index,
        created_at: "",
        updated_at: "",
      })),
    );
  });

  it("renders more than 100 Links through the all-pages API without Memo controls", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/project-1/m/linkmemo"]}>
        <Routes>
          <Route path="/projects/:projectId/m/linkmemo" element={<LinkMemoListPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Link 100")).toBeInTheDocument();
    expect(listAllItems).toHaveBeenCalledWith({ moduleId: "linkmemo", projectId: "project-1" });
    expect(screen.queryByText(/Memos/)).not.toBeInTheDocument();
  });

  it("asks before opening a path that would run as a program", async () => {
    vi.mocked(listAllItems).mockResolvedValue([
      {
        id: "link-app",
        project_id: "project-1",
        module_id: "linkmemo",
        title: "Installer",
        tags: [],
        payload_schema_version: 1,
        payload: { type: "path", target: "/Users/x/Downloads/setup.command", body: "" },
        position: 0,
        created_at: "",
        updated_at: "",
      },
    ]);
    vi.mocked(linkmemoOpen).mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={["/projects/project-1/m/linkmemo"]}>
        <Routes>
          <Route path="/projects/:projectId/m/linkmemo" element={<LinkMemoListPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText("Installer"));
    expect(await screen.findByText("実行ファイルを開きますか?")).toBeInTheDocument();
    expect(linkmemoOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "開く" }));
    expect(linkmemoOpen).toHaveBeenCalledWith({
      itemType: "path",
      target: "/Users/x/Downloads/setup.command",
      allowNetworkPath: false,
    });
  });

  it("asks before connecting to a server that is not registered, and can register it", async () => {
    vi.mocked(listAllItems).mockResolvedValue([
      pathLink("link-nas", "NAS", String.raw`\\NAS\share\docs`),
    ]);
    vi.mocked(linkmemoOpen).mockResolvedValue(undefined);
    renderList();

    fireEvent.click(await screen.findByText("NAS"));
    expect(await screen.findByText("ネットワーク上の場所を開きますか?")).toBeInTheDocument();
    expect(screen.getByText(/サーバ「nas」に接続します/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(linkmemoOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("NAS"));
    fireEvent.click(await screen.findByLabelText("今後「nas」は確認せずに開く"));
    fireEvent.click(screen.getByRole("button", { name: "開く" }));
    expect(linkmemoOpen).toHaveBeenCalledWith({
      itemType: "path",
      target: String.raw`\\NAS\share\docs`,
      allowNetworkPath: true,
    });
    expect(useAppStore.getState().moduleSettings["linkmemo"]).toEqual({
      trusted_network_hosts: ["nas"],
    });

    // 登録したサーバは確認せずに開く
    fireEvent.click(screen.getByText("NAS"));
    await waitFor(() => expect(linkmemoOpen).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("ネットワーク上の場所を開きますか?")).not.toBeInTheDocument();
  });

  it("still asks before running a program on a registered server", async () => {
    useAppStore.setState({ moduleSettings: { linkmemo: { trusted_network_hosts: ["nas"] } } });
    vi.mocked(listAllItems).mockResolvedValue([
      pathLink("link-setup", "Setup", String.raw`\\nas\share\setup.exe`),
      pathLink("link-other", "Other", String.raw`\\other\share\setup.exe`),
    ]);
    vi.mocked(linkmemoOpen).mockResolvedValue(undefined);
    renderList();

    fireEvent.click(await screen.findByText("Setup"));
    expect(await screen.findByText("実行ファイルを開きますか?")).toBeInTheDocument();
    expect(screen.queryByLabelText(/確認せずに開く/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "開く" }));
    expect(linkmemoOpen).toHaveBeenCalledWith({
      itemType: "path",
      target: String.raw`\\nas\share\setup.exe`,
      allowNetworkPath: true,
    });

    fireEvent.click(screen.getByText("Other"));
    expect(
      await screen.findByText("ネットワーク上の実行ファイルを開きますか?"),
    ).toBeInTheDocument();
  });

  it("shows only the message of an open error", async () => {
    vi.mocked(listAllItems).mockResolvedValue([pathLink("link-doc", "Doc", "/Users/x/missing")]);
    vi.mocked(linkmemoOpen).mockRejectedValue({
      code: "internal",
      message: "パスを開けませんでした: /Users/x/missing (No such file or directory (os error 2))",
    });
    renderList();

    fireEvent.click(await screen.findByText("Doc"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^パスを開けませんでした: \/Users\/x\/missing/,
    );
  });
});
