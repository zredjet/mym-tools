import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listProjects } from "@/ipc/projects";
import { useAppStore } from "@/store/useAppStore";

import { AppShell } from "./AppShell";

vi.mock("@/ipc/projects", () => ({ listProjects: vi.fn() }));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => <div>トップバー</div> }));
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => <aside>サイドバー</aside> }));
vi.mock("@/components/shell/SearchOverlay", () => ({ SearchOverlay: () => null }));
vi.mock("@/components/projects/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));

describe("AppShell", () => {
  beforeEach(() => {
    useAppStore.setState({
      lastOpenedProjectId: null,
      lastOpenedModuleId: null,
      moduleEnabled: {},
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
