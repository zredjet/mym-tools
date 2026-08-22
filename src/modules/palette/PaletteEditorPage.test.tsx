import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createItem, getItem, updateItem } from "@/ipc/items";

import { PaletteEditorRoute } from "./PaletteEditorPage";

vi.mock("@/ipc/items", () => ({
  createItem: vi.fn(),
  getItem: vi.fn(),
  updateItem: vi.fn(),
}));

const savedItem = {
  id: "palette-1",
  project_id: "project-1",
  module_id: "palette",
  title: "Ocean",
  tags: ["brand"],
  payload_schema_version: 1,
  payload: {
    colors: ["#123ABC", "#2563EB", "#3B82F6", "#60A5FA", "#93C5FD"],
    harmony: "analogous",
    base_index: 2,
  },
  position: 0,
  created_at: "",
  updated_at: "",
};

function renderEditor() {
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:projectId/m/palette",
        element: <PaletteEditorRoute />,
      },
      {
        path: "/projects/:projectId/m/palette/edit/:itemId",
        element: <PaletteEditorRoute />,
      },
      {
        path: "/projects/:projectId/m/palette/saved",
        element: <span>保存済み画面</span>,
      },
    ],
    { initialEntries: ["/projects/project-1/m/palette"] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("PaletteEditorPage", () => {
  beforeEach(() => {
    vi.mocked(createItem).mockResolvedValue("palette-1");
    vi.mocked(getItem).mockResolvedValue(savedItem);
    vi.mocked(updateItem).mockResolvedValue(undefined);
  });

  it("offers five colors and all nine harmony rules", () => {
    renderEditor();

    expect(screen.getAllByLabelText(/色 \d のHEX/)).toHaveLength(5);
    expect(screen.getAllByRole("radio")).toHaveLength(9);
    expect(screen.getByRole("radio", { name: "類似色" })).toHaveAttribute("aria-checked", "true");
  });

  it("creates a palette with the persisted v1 fields", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("パレット名"), "Ocean");
    await user.type(screen.getByLabelText("タグ"), "brand, ui");
    await user.click(screen.getByRole("button", { name: "保存⌘S" }));

    await waitFor(() => {
      expect(createItem).toHaveBeenCalledWith(
        expect.objectContaining({
          moduleId: "palette",
          projectId: "project-1",
          title: "Ocean",
          tags: ["brand", "ui"],
          payload: expect.objectContaining({
            colors: expect.arrayContaining([expect.stringMatching(/^#[0-9A-F]{6}$/)]),
            harmony: "analogous",
            base_index: 2,
          }),
        }),
      );
    });
  });

  it("blocks saving while any compact HEX input is invalid", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("パレット名"), "Invalid draft");
    const input = screen.getByLabelText("色 1 のHEX");
    await user.clear(input);

    expect(screen.getByRole("button", { name: "保存⌘S" })).toBeDisabled();
  });

  it("asks before leaving a dirty creation session", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("パレット名"), "Unsaved");
    await user.click(screen.getByRole("button", { name: "保存済み" }));

    expect(screen.getByRole("heading", { name: "未保存の変更があります" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "破棄して移動" }));
    expect(await screen.findByText("保存済み画面")).toBeInTheDocument();
  });

  it("starts a fresh session with Ctrl+N after dirty confirmation", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText("パレット名"), "Unsaved");
    fireEvent.keyDown(document, { key: "n", code: "KeyN", ctrlKey: true });

    expect(screen.getByRole("heading", { name: "未保存の変更があります" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "破棄して移動" }));
    await waitFor(() => expect(screen.getByLabelText("パレット名")).toHaveValue(""));
  });
});
