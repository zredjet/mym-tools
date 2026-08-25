import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listAllItems } from "@/ipc/items";

import { LinkMemoListPage } from "./LinkMemoListPage";

vi.mock("@/ipc/items", () => ({
  deleteItem: vi.fn(),
  listAllItems: vi.fn(),
  reorderItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
}));
vi.mock("@/ipc/linkmemo", () => ({ linkmemoOpen: vi.fn(), linkmemoNormalizeTarget: vi.fn() }));

describe("Link list", () => {
  beforeEach(() => {
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
});
