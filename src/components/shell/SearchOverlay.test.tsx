import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchPreviews } from "@/ipc/search";
import type { SearchPreview } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

import { SearchOverlay } from "./SearchOverlay";

vi.mock("@/ipc/search", () => ({ searchPreviews: vi.fn() }));

function preview(id: string, title: string): SearchPreview {
  return {
    id,
    project_id: "p1",
    module_id: "prompt",
    title,
    tags: [],
    payload_schema_version: 1,
    payload: { body: "" },
    position: 0,
    created_at: "2026-09-25T00:00:00.000+09:00",
    updated_at: "2026-09-25T00:00:00.000+09:00",
  };
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderOverlay(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <SearchOverlay
                open
                onClose={onClose}
                currentProjectId="p1"
                currentProjectName="Project One"
              />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText("検索クエリ"), { target: { value } });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("SearchOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAppStore.setState({ moduleEnabled: {}, searchDefaultScope: "project" });
  });
  afterEach(() => vi.useRealTimers());

  it("debounces typing into one project-scoped search over stateful modules", async () => {
    vi.mocked(searchPreviews).mockResolvedValue([preview("i1", "Needle prompt")]);
    renderOverlay();

    type("n");
    type("ne");
    type("needle");
    await advance(199);
    expect(searchPreviews).not.toHaveBeenCalled();
    await advance(1);

    expect(searchPreviews).toHaveBeenCalledOnce();
    const request = vi.mocked(searchPreviews).mock.calls[0]![0];
    expect(request.query).toBe("needle");
    expect(request.scope).toEqual({ type: "project", project_id: "p1" });
    expect(request.moduleFilter).toContain("prompt");
    expect(request.moduleFilter).not.toContain("hash");
    expect(screen.getByText("Needle prompt")).toBeInTheDocument();
  });

  it("searches all projects after switching the scope", async () => {
    vi.mocked(searchPreviews).mockResolvedValue([]);
    renderOverlay();

    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    type("needle");
    await advance(200);

    expect(vi.mocked(searchPreviews).mock.lastCall![0].scope).toEqual({ type: "global" });
    expect(screen.getByText(/該当なし/)).toBeInTheDocument();
  });

  it("ignores a slower response for an older query", async () => {
    let resolveOld!: (value: SearchPreview[]) => void;
    vi.mocked(searchPreviews)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce([preview("new", "New result")]);
    renderOverlay();

    type("old query");
    await advance(200);
    type("new query");
    await advance(200);
    await act(async () => resolveOld([preview("old", "Old result")]));

    expect(screen.getByText("New result")).toBeInTheDocument();
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();
  });

  it("opens the module route of a result and closes", async () => {
    vi.mocked(searchPreviews).mockResolvedValue([preview("i1", "Needle prompt")]);
    const onClose = renderOverlay();

    type("needle");
    await advance(200);
    fireEvent.click(screen.getByRole("button", { name: /Needle prompt/ }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/m/prompt/i1");
  });
});
