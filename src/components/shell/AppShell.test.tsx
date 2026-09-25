import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listProjects } from "@/ipc/projects";
import { useAppStore } from "@/store/useAppStore";

import { AppShell } from "./AppShell";

vi.mock("@/ipc/projects", () => ({ listProjects: vi.fn() }));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => <div>トップバー</div> }));
vi.mock("@/components/shell/Sidebar", () => ({
  Sidebar: ({ onProjectChanged }: { onProjectChanged: () => void }) => (
    <aside>
      <span>サイドバー</span>
      <button type="button" onClick={onProjectChanged}>
        一覧を再取得
      </button>
    </aside>
  ),
}));
vi.mock("@/components/shell/SearchOverlay", () => ({ SearchOverlay: () => null }));
vi.mock("@/components/projects/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      lastOpenedProjectId: null,
      lastOpenedModuleId: null,
      moduleEnabled: {},
      sidebarCollapsed: false,
    });
    // 初期ロードを完了させず、viewport frame の同期的な描画だけを検証する。
    vi.mocked(listProjects).mockImplementation(() => new Promise(() => undefined));
  });

  it("uses percentage sizing so UI zoom stays inside the viewport", () => {
    const { container } = render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>メイン</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const shell = container.firstElementChild;
    expect(shell).toHaveClass("h-full", "w-full");
    expect(shell).not.toHaveClass("h-screen", "w-screen");
  });

  it.each([
    ["Cmd/Ctrl+B", { key: "b", code: "KeyB", ctrlKey: true }],
    ["Cmd/Ctrl+\\", { key: "\\", code: "Backslash", ctrlKey: true }],
  ])("toggles the sidebar with %s and remembers it in the store", (_label, keys) => {
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>メイン</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("サイドバー")).toBeInTheDocument();

    fireEvent.keyDown(document, keys);
    expect(screen.queryByText("サイドバー")).not.toBeInTheDocument();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    // 本文は残る
    expect(screen.getByText("メイン")).toBeInTheDocument();

    fireEvent.keyDown(document, keys);
    expect(screen.getByText("サイドバー")).toBeInTheDocument();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  // 一覧取得後の再取得エラーで Outlet (編集中の画面) を外さない。外すと未保存確認を
  // 通らずに unmount され、入力内容が失われる
  it("keeps the current page mounted when a later project refresh fails", async () => {
    vi.mocked(listProjects).mockResolvedValueOnce([]);
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<textarea aria-label="編集中" defaultValue="未保存の内容" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(listProjects).toHaveBeenCalledOnce());

    vi.mocked(listProjects).mockRejectedValueOnce(new Error("busy"));
    fireEvent.click(screen.getByRole("button", { name: "一覧を再取得" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "プロジェクト一覧の取得に失敗: busy",
    );
    expect(screen.getByLabelText("編集中")).toHaveValue("未保存の内容");

    vi.mocked(listProjects).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("shows only the error until the first project load succeeds", async () => {
    vi.mocked(listProjects).mockRejectedValueOnce(new Error("offline"));
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>メイン</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.queryByText("メイン")).not.toBeInTheDocument();
  });

  it("uses fixed module shortcuts for Memo and Palette", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      {
        id: "p1",
        name: "Project",
        description: null,
        position: 0,
        created_at: "",
        updated_at: "",
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/projects/p1/m/prompt"]}>
        <Routes>
          <Route path="/projects/:projectId/*" element={<AppShell />}>
            <Route path="m/:moduleId" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: "3", code: "Digit3", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/m/memo"),
    );
    fireEvent.keyDown(document, { key: "6", code: "Digit6", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/m/palette"),
    );
  });

  it("does nothing when the fixed shortcut target is disabled", async () => {
    useAppStore.setState({ moduleEnabled: { memo: false } });
    vi.mocked(listProjects).mockResolvedValue([
      {
        id: "p1",
        name: "Project",
        description: null,
        position: 0,
        created_at: "",
        updated_at: "",
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/projects/p1/m/prompt"]}>
        <Routes>
          <Route path="/projects/:projectId/*" element={<AppShell />}>
            <Route path="m/:moduleId" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: "3", code: "Digit3", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/m/prompt"),
    );
  });
});

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}
