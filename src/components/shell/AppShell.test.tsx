import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listProjects } from "@/ipc/projects";

import { AppShell } from "./AppShell";

vi.mock("@/ipc/projects", () => ({ listProjects: vi.fn() }));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => <div>トップバー</div> }));
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => <aside>サイドバー</aside> }));
vi.mock("@/components/shell/SearchOverlay", () => ({ SearchOverlay: () => null }));
vi.mock("@/components/projects/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));

describe("AppShell", () => {
  beforeEach(() => {
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
});
