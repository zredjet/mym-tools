import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listAllItems } from "@/ipc/items";

import { PromptListPage } from "./PromptListPage";

vi.mock("@/ipc/items", () => ({
  deleteItem: vi.fn(),
  listAllItems: vi.fn(),
  reorderItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
}));

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
});
