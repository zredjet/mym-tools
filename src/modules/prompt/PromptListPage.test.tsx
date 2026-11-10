import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listAllItems, moveItem } from "@/ipc/items";
import { listProjects } from "@/ipc/projects";

import { PromptListPage } from "./PromptListPage";

vi.mock("@/ipc/items", () => ({
  deleteItem: vi.fn(),
  listAllItems: vi.fn(),
  moveItem: vi.fn(),
  reorderItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
}));
vi.mock("@/ipc/projects", () => ({ listProjects: vi.fn() }));

describe("Prompt list", () => {
  beforeEach(() => {
    vi.mocked(listAllItems).mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `prompt-${index}`,
        project_id: "project-1",
        module_id: "prompt",
        title: `Prompt ${index}`,
        tags: [],
        payload_schema_version: 1,
        payload: { body: `Body ${index}` },
        position: index,
        created_at: "",
        updated_at: "",
      })),
    );
  });

  // 並び替えは全 ID を要求するため、100 件で打ち切ると 101 件目以降が表示されず並び替えも失敗する
  it("renders more than 100 prompts through the all-pages API", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/project-1/m/prompt"]}>
        <Routes>
          <Route path="/projects/:projectId/m/prompt" element={<PromptListPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Prompt 100")).toBeInTheDocument();
    expect(listAllItems).toHaveBeenCalledWith({ moduleId: "prompt", projectId: "project-1" });
  });

  it("moves a prompt to another project and reloads the list", async () => {
    const stamp = "2026-11-10T00:00:00.000+09:00";
    const project = (id: string, name: string, position: number) => ({
      id,
      name,
      description: null,
      position,
      created_at: stamp,
      updated_at: stamp,
    });
    vi.mocked(listProjects).mockResolvedValue([
      project("project-1", "Work", 0),
      project("project-2", "Home", 1),
    ]);
    vi.mocked(moveItem).mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={["/projects/project-1/m/prompt"]}>
        <Routes>
          <Route path="/projects/:projectId/m/prompt" element={<PromptListPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const row = (await screen.findByText("Prompt 3")).closest("li")!;
    const loads = vi.mocked(listAllItems).mock.calls.length;
    fireEvent.click(within(row).getByRole("button", { name: "別のプロジェクトへ移動" }));

    const dialog = await screen.findByRole("dialog", {
      name: "プロンプトを別のプロジェクトへ移動",
    });
    expect(within(dialog).queryByRole("radio", { name: "Work" })).not.toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole("radio", { name: "Home" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "移動" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(moveItem).toHaveBeenCalledWith({
      moduleId: "prompt",
      itemId: "prompt-3",
      targetProjectId: "project-2",
    });
    await waitFor(() => expect(vi.mocked(listAllItems).mock.calls.length).toBe(loads + 1));
  });
});
