import { act, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diagramEditorUrl, diagramWriteFile } from "@/ipc/diagram";
import { listAllItems } from "@/ipc/items";

import { DIAGRAM_EXPORT_TIMEOUT_MS, DiagramWorkspaceRoute } from "./DiagramWorkspacePage";

const dialog = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/ipc/diagram", () => ({
  diagramEditorUrl: vi.fn(),
  diagramReadFile: vi.fn(),
  diagramWriteFile: vi.fn(),
}));
vi.mock("@/ipc/items", () => ({
  createItem: vi.fn(),
  getItem: vi.fn(),
  listAllItems: vi.fn(),
  updateItem: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function renderWorkspace() {
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:projectId/m/diagram/new",
        element: <DiagramWorkspaceRoute />,
      },
    ],
    { initialEntries: ["/projects/project-1/m/diagram/new"] },
  );
  return render(<RouterProvider router={router} />);
}

function sendEditorEvent(iframe: HTMLIFrameElement, value: object) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify(value),
      origin: "http://127.0.0.1:4567",
      source: iframe.contentWindow,
    }),
  );
}

describe("DiagramWorkspacePage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(diagramEditorUrl).mockResolvedValue("http://127.0.0.1:4567/index.html");
    vi.mocked(diagramWriteFile).mockResolvedValue(undefined);
    vi.mocked(listAllItems).mockResolvedValue([]);
    dialog.save.mockResolvedValue("/tmp/diagram.png");
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("releases the export lock when draw.io does not respond", async () => {
    renderWorkspace();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const iframe = screen.getByTitle("draw.io オフラインエディタ") as HTMLIFrameElement;
    act(() => sendEditorEvent(iframe, { event: "init" }));
    act(() => sendEditorEvent(iframe, { event: "load" }));

    fireEvent.click(screen.getByRole("button", { name: "PNG" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "PNG生成中..." })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DIAGRAM_EXPORT_TIMEOUT_MS);
    });

    expect(screen.getByRole("button", { name: "PNG" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("PNG生成がタイムアウトしました");
    expect(diagramWriteFile).not.toHaveBeenCalled();
  });
});
