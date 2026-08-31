import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

import { Sidebar } from "./Sidebar";

const projects: Project[] = [
  {
    id: "p1",
    name: "Project One",
    description: null,
    position: 0,
    created_at: "",
    updated_at: "",
  },
];

describe("Sidebar module selection", () => {
  beforeEach(() => {
    useAppStore.setState({
      lastOpenedProjectId: null,
      lastOpenedModuleId: null,
      moduleEnabled: {},
      collapsedModuleCategories: [],
    });
  });

  it("highlights the module selected by a literal list route", () => {
    renderAt("/projects/p1/m/prompt");

    expect(screen.getByRole("button", { name: "プロンプト" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "プロンプト" })).toHaveClass(
      "bg-[var(--bg-accent-soft)]",
      "text-[var(--accent)]",
    );
    expect(screen.getByRole("button", { name: "プロンプト" })).toHaveStyle({
      boxShadow: "inset 2px 0 0 0 var(--accent)",
    });
    expect(screen.getByRole("button", { name: "リンク" })).not.toHaveAttribute("aria-current");
  });

  it("keeps the owning module highlighted on a nested detail route", () => {
    renderAt("/projects/p1/m/prompt/item-1");

    expect(screen.getByRole("button", { name: "プロンプト" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("moves the highlight when the current module route changes", () => {
    renderAt("/projects/p1/m/prompt", true);

    fireEvent.click(screen.getByRole("button", { name: "メモの編集へ移動" }));

    expect(screen.getByRole("button", { name: "メモ" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "プロンプト" })).not.toHaveAttribute("aria-current");
  });

  it.each(["/settings", "/about"])("highlights the last enabled module on %s", (pathname) => {
    useAppStore.setState({ lastOpenedProjectId: "p1", lastOpenedModuleId: "memo" });

    renderAt(pathname);

    expect(screen.getByRole("button", { name: "メモ" })).toHaveAttribute("aria-current", "page");
  });
});

function renderAt(initialEntry: string, withNavigation = false) {
  const sidebar = withNavigation ? <SidebarWithNavigation /> : <SidebarFixture />;
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/projects/:projectId/m/prompt" element={sidebar} />
        <Route path="/projects/:projectId/m/prompt/:itemId" element={sidebar} />
        <Route path="/projects/:projectId/m/memo/edit/:itemId" element={sidebar} />
        <Route path="/settings" element={sidebar} />
        <Route path="/about" element={sidebar} />
      </Routes>
    </MemoryRouter>,
  );
}

function SidebarFixture() {
  return <Sidebar projects={projects} onProjectCreated={vi.fn()} onProjectChanged={vi.fn()} />;
}

function SidebarWithNavigation() {
  const navigate = useNavigate();
  return (
    <>
      <SidebarFixture />
      <button type="button" onClick={() => navigate("/projects/p1/m/memo/edit/item-1")}>
        メモの編集へ移動
      </button>
    </>
  );
}
