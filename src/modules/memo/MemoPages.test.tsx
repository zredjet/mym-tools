import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createItem, getItem, listAllItems, updateItem } from "@/ipc/items";
import type { Item } from "@/lib/types";

import { MemoDetailPage } from "./MemoDetailPage";
import { MemoEditorRoute } from "./MemoEditorPage";
import { MemoListPage } from "./MemoListPage";

vi.mock("@/ipc/items", () => ({
  createItem: vi.fn(),
  deleteItem: vi.fn(),
  getItem: vi.fn(),
  listAllItems: vi.fn(),
  reorderItems: vi.fn(),
  updateItem: vi.fn(),
}));

const memo: Item = {
  id: "memo-1",
  project_id: "project-1",
  module_id: "memo",
  title: "設計メモ",
  tags: ["design"],
  payload_schema_version: 1,
  payload: { body: "# Heading\n\n本文" },
  position: 0,
  created_at: "",
  updated_at: "",
};

function router(initialEntry: string) {
  return createMemoryRouter(
    [
      { path: "/projects/:projectId/m/memo", element: <MemoListPage /> },
      { path: "/projects/:projectId/m/memo/new", element: <MemoEditorRoute /> },
      { path: "/projects/:projectId/m/memo/:itemId", element: <MemoDetailPage /> },
      { path: "/projects/:projectId/m/memo/edit/:itemId", element: <MemoEditorRoute /> },
    ],
    { initialEntries: [initialEntry] },
  );
}

describe("Memo pages", () => {
  beforeEach(() => {
    vi.mocked(getItem).mockResolvedValue(memo);
    vi.mocked(createItem).mockResolvedValue("memo-1");
    vi.mocked(updateItem).mockResolvedValue(undefined);
    vi.mocked(listAllItems).mockResolvedValue([]);
  });

  it("loads and renders every Memo returned by the all-pages API", async () => {
    vi.mocked(listAllItems).mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        ...memo,
        id: `memo-${index}`,
        title: `Memo ${index}`,
        position: index,
      })),
    );
    render(<RouterProvider router={router("/projects/project-1/m/memo")} />);
    expect(await screen.findByText("Memo 100")).toBeInTheDocument();
    expect(listAllItems).toHaveBeenCalledWith({ moduleId: "memo", projectId: "project-1" });
  });

  it("shows Markdown and Raw views and exposes copy and edit actions", async () => {
    const user = userEvent.setup();
    render(<RouterProvider router={router("/projects/project-1/m/memo/memo-1")} />);
    expect(await screen.findByRole("heading", { name: "設計メモ" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByText(/# Heading/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /本文をコピー/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(await screen.findByRole("heading", { name: "メモを編集" })).toBeInTheDocument();
  });

  it("creates a Memo v1 and moves to its detail page", async () => {
    const user = userEvent.setup();
    const appRouter = router("/projects/project-1/m/memo/new");
    render(<RouterProvider router={appRouter} />);
    await user.type(screen.getByLabelText("タイトル"), "New memo");
    await user.type(screen.getByLabelText("タグ (カンマ区切り)"), "one, two");
    await user.type(screen.getByLabelText("本文 (Markdown)"), "Body");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() =>
      expect(createItem).toHaveBeenCalledWith({
        moduleId: "memo",
        projectId: "project-1",
        title: "New memo",
        tags: ["one", "two"],
        payload: { body: "Body" },
      }),
    );
    await waitFor(() =>
      expect(appRouter.state.location.pathname).toBe("/projects/project-1/m/memo/memo-1"),
    );
  });

  it("confirms a dirty cancellation and returns new/edit to the correct destination", async () => {
    const user = userEvent.setup();
    const newRouter = router("/projects/project-1/m/memo/new");
    const view = render(<RouterProvider router={newRouter} />);
    await user.type(screen.getByLabelText("タイトル"), "draft");
    await user.click(screen.getByRole("button", { name: /キャンセル/ }));
    expect(screen.getByRole("heading", { name: "未保存の変更があります" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "破棄して移動" }));
    await waitFor(() =>
      expect(newRouter.state.location.pathname).toBe("/projects/project-1/m/memo"),
    );
    view.unmount();

    const editRouter = router("/projects/project-1/m/memo/edit/memo-1");
    render(<RouterProvider router={editRouter} />);
    expect(await screen.findByDisplayValue("設計メモ")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /キャンセル/ }));
    await waitFor(() =>
      expect(editRouter.state.location.pathname).toBe("/projects/project-1/m/memo/memo-1"),
    );
  });
});
