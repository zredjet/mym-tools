import { act, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createItem, getItem, listAllItems, updateItem } from "@/ipc/items";
import { useAppStore } from "@/store/useAppStore";

import { MermaidWorkspaceRoute } from "./MermaidWorkspacePage";
import { renderMermaid } from "./mermaidRenderer";

const renderer = vi.hoisted(() => ({
  renderMermaid: vi.fn(),
  readableMermaidError: vi.fn(() => "syntax error"),
}));
const exportTools = vi.hoisted(() => ({
  saveDialog: vi.fn(),
  mermaidWriteFile: vi.fn(),
  renderMermaidPng: vi.fn(),
}));

vi.mock("@/ipc/items", () => ({
  createItem: vi.fn(),
  getItem: vi.fn(),
  listAllItems: vi.fn(),
  updateItem: vi.fn(),
}));
vi.mock("./mermaidRenderer", () => renderer);
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: exportTools.saveDialog }));
vi.mock("@/ipc/mermaid", () => ({ mermaidWriteFile: exportTools.mermaidWriteFile }));
vi.mock("./mermaidExporter", () => ({
  MAX_MERMAID_EXPORT_BYTES: 20 * 1024 * 1024,
  renderMermaidPng: exportTools.renderMermaidPng,
}));

const otherDocument = {
  id: "mermaid-other",
  project_id: "project-1",
  module_id: "mermaid" as const,
  title: "保存済みフロー",
  tags: [],
  payload_schema_version: 1,
  payload: { source: "flowchart LR\nX-->Y" },
  position: 0,
  created_at: "2026-08-31T00:00:00.000+09:00",
  updated_at: "2026-08-31T00:00:00.000+09:00",
};

function renderWorkspace() {
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:projectId/m/mermaid/new",
        element: <MermaidWorkspaceRoute />,
      },
      {
        path: "/projects/:projectId/m/mermaid/edit/:itemId",
        element: <MermaidWorkspaceRoute />,
      },
    ],
    { initialEntries: ["/projects/project-1/m/mermaid/new"] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

async function finishDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe("MermaidWorkspacePage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.mocked(listAllItems).mockResolvedValue([otherDocument]);
    vi.mocked(getItem).mockResolvedValue(otherDocument);
    vi.mocked(createItem).mockResolvedValue("mermaid-new");
    vi.mocked(updateItem).mockResolvedValue(undefined);
    exportTools.saveDialog.mockResolvedValue(null);
    exportTools.mermaidWriteFile.mockResolvedValue(undefined);
    exportTools.renderMermaidPng.mockResolvedValue("data:image/png;base64,AAAA");
    vi.mocked(renderMermaid).mockImplementation(async (source) => {
      if (source.includes("BROKEN")) throw new Error("broken");
      return `<svg><text>${source.includes("A--&gt;B") ? "updated" : "preview-ok"}</text></svg>`;
    });
    useAppStore.setState({ theme: "light" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders after 300ms, follows the theme, and saves payload v1", async () => {
    renderWorkspace();
    await finishDebounce();

    expect(screen.getByText("preview-ok")).toBeInTheDocument();
    expect(renderMermaid).toHaveBeenLastCalledWith(
      expect.stringContaining("flowchart LR"),
      "default",
    );

    act(() => useAppStore.getState().setTheme("dark"));
    await finishDebounce();
    expect(renderMermaid).toHaveBeenLastCalledWith(expect.stringContaining("flowchart LR"), "dark");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保存/ }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleId: "mermaid",
        projectId: "project-1",
        title: "新しいMermaid図",
        payload: { source: expect.stringContaining("flowchart LR") },
      }),
    );
  });

  it("keeps the last successful preview and rejects saving on a syntax error", async () => {
    renderWorkspace();
    await finishDebounce();
    expect(screen.getByText("preview-ok")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Mermaid記法"), { target: { value: "BROKEN" } });
    await finishDebounce();

    expect(screen.getByRole("alert")).toHaveTextContent("syntax error");
    expect(screen.getByText("preview-ok")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "SVG" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "PNG" })).toBeDisabled();
  });

  it("exports the current valid preview as SVG and white 2x PNG without saving the item", async () => {
    renderWorkspace();
    await finishDebounce();

    exportTools.saveDialog.mockResolvedValueOnce("/tmp/mermaid.svg");
    fireEvent.click(screen.getByRole("button", { name: "SVG" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(exportTools.saveDialog).toHaveBeenLastCalledWith({
      defaultPath: "新しいMermaid図.svg",
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    expect(exportTools.mermaidWriteFile).toHaveBeenLastCalledWith({
      path: "/tmp/mermaid.svg",
      format: "svg",
      data: expect.stringContaining("<svg>"),
    });

    exportTools.saveDialog.mockResolvedValueOnce("/tmp/mermaid.png");
    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(exportTools.renderMermaidPng).toHaveBeenCalledWith(expect.stringContaining("<svg>"));
    expect(exportTools.mermaidWriteFile).toHaveBeenLastCalledWith({
      path: "/tmp/mermaid.png",
      format: "png",
      data: "data:image/png;base64,AAAA",
    });
    expect(createItem).not.toHaveBeenCalled();
  });

  it("prevents duplicate export dialogs while an export is in progress", async () => {
    renderWorkspace();
    await finishDebounce();
    let resolveDialog: ((path: string | null) => void) | undefined;
    exportTools.saveDialog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDialog = resolve;
        }),
    );

    const svgButton = screen.getByRole("button", { name: "SVG" });
    fireEvent.click(svgButton);
    fireEvent.click(svgButton);
    expect(exportTools.saveDialog).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDialog?.(null);
      await Promise.resolve();
    });
  });

  it("blocks document changes while the draft is dirty", async () => {
    renderWorkspace();
    await finishDebounce();
    await act(async () => Promise.resolve());

    fireEvent.change(screen.getByLabelText("Mermaid記法"), {
      target: { value: "flowchart LR\nA-->B" },
    });
    fireEvent.change(screen.getByLabelText("ドキュメント"), {
      target: { value: otherDocument.id },
    });

    expect(screen.getByRole("heading", { name: "未保存の変更があります" })).toBeInTheDocument();
  });
});
