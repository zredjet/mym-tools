/**
 * `ProjectSwitcher` の振る舞い (`docs/ui-design.md` §6 C-3 / §8.1)。
 *
 * - filter: 部分一致 (case-insensitive)
 * - keyboard: ↑↓ で active 行が動く / Enter で navigate
 * - 0 件: 「該当なし」表示
 * - hash モジュール中に開いて enter → /projects/<id>/m/prompt にフォールバック
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

import { ProjectSwitcher } from "./ProjectSwitcher";

const projects: Project[] = [
  {
    id: "p1",
    name: "Apple",
    description: "果物",
    position: 0,
    created_at: "2026-01-01T00:00:00.000+09:00",
    updated_at: "2026-01-01T00:00:00.000+09:00",
  },
  {
    id: "p2",
    name: "Banana",
    description: null,
    position: 1,
    created_at: "2026-01-01T00:00:00.000+09:00",
    updated_at: "2026-01-01T00:00:00.000+09:00",
  },
  {
    id: "p3",
    name: "apricot",
    description: null,
    position: 2,
    created_at: "2026-01-01T00:00:00.000+09:00",
    updated_at: "2026-01-01T00:00:00.000+09:00",
  },
];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderAt(initial: string, onClose = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/projects/:projectId/m/:moduleId"
          element={
            <>
              <ProjectSwitcher open onClose={onClose} projects={projects} />
              <LocationProbe />
            </>
          }
        />
        <Route
          path="/modules/hash"
          element={
            <>
              <ProjectSwitcher open onClose={onClose} projects={projects} />
              <LocationProbe />
            </>
          }
        />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    useAppStore.setState({
      lastOpenedModuleId: null,
      lastOpenedProjectId: null,
    });
  });

  it("filters projects by case-insensitive substring match", () => {
    renderAt("/projects/p1/m/prompt");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ap" } });
    // "Apple" と "apricot" が hit、"Banana" は hit しない
    expect(screen.getByText("Apple")).toBeInTheDocument();
    expect(screen.getByText("apricot")).toBeInTheDocument();
    expect(screen.queryByText("Banana")).not.toBeInTheDocument();
  });

  it("shows 'no match' message when filter has no result", () => {
    renderAt("/projects/p1/m/prompt");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText(/「zzz」に一致するプロジェクトはありません/)).toBeInTheDocument();
  });

  it("navigates to selected project on Enter, preserving current moduleId", () => {
    const onClose = vi.fn();
    renderAt("/projects/p1/m/linkmemo", onClose);
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Banana" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p2/m/linkmemo");
    expect(onClose).toHaveBeenCalled();
    // store 更新も確認
    expect(useAppStore.getState().lastOpenedProjectId).toBe("p2");
    expect(useAppStore.getState().lastOpenedModuleId).toBe("linkmemo");
  });

  it("falls back to 'prompt' module when current route is /modules/hash (hash is project-less)", () => {
    renderAt("/modules/hash");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Apple" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p1/m/prompt");
  });

  it("ArrowDown moves the active row down and Enter selects it", () => {
    renderAt("/projects/p1/m/prompt");
    const input = screen.getByLabelText("プロジェクト検索") as HTMLInputElement;
    // 初期 active = projects[0] = Apple。↓ で Banana に移動
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p2/m/prompt");
  });
});
