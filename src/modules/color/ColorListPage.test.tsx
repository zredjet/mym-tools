import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listAllItems } from "@/ipc/items";

import { ColorListPage } from "./ColorListPage";

vi.mock("@/ipc/items", () => ({
  deleteItem: vi.fn(),
  listAllItems: vi.fn(),
  reorderItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
}));

describe("Color list", () => {
  beforeEach(() => {
    vi.mocked(listAllItems).mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `color-${index}`,
        project_id: "project-1",
        module_id: "color",
        title: `Color ${index}`,
        tags: [],
        payload_schema_version: 1,
        payload: { hex: "#112233" },
        position: index,
        created_at: "",
        updated_at: "",
      })),
    );
  });

  // 並び替えは全 ID を要求するため、100 件で打ち切ると 101 件目以降が表示されず並び替えも失敗する
  it("renders more than 100 colors through the all-pages API", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/project-1/m/color"]}>
        <Routes>
          <Route path="/projects/:projectId/m/color" element={<ColorListPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Color 100")).toBeInTheDocument();
    expect(listAllItems).toHaveBeenCalledWith({ moduleId: "color", projectId: "project-1" });
  });
});
