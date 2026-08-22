import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { ModuleAccess } from "@/App";
import { modules } from "@/modules/registry";
import { useAppStore } from "@/store/useAppStore";

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

describe("ModuleAccess", () => {
  beforeEach(() => {
    useAppStore.setState({
      lastOpenedProjectId: null,
      lastOpenedModuleId: null,
      moduleEnabled: {},
    });
  });

  it("syncs direct module routes into the startup restore state", async () => {
    const color = modules.find((module) => module.id === "color")!;
    render(
      <MemoryRouter initialEntries={["/projects/p-direct/m/color"]}>
        <Routes>
          <Route
            path="/projects/:projectId/m/color"
            element={
              <ModuleAccess module={color}>
                <span>カラー画面</span>
              </ModuleAccess>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("カラー画面")).toBeInTheDocument();
    await waitFor(() => {
      expect(useAppStore.getState().lastOpenedProjectId).toBe("p-direct");
      expect(useAppStore.getState().lastOpenedModuleId).toBe("color");
    });
  });

  it("redirects a disabled module to the first enabled module", async () => {
    useAppStore.setState({ moduleEnabled: { prompt: false } });
    const prompt = modules.find((module) => module.id === "prompt")!;
    render(
      <MemoryRouter initialEntries={["/projects/p1/m/prompt"]}>
        <Routes>
          <Route
            path="/projects/:projectId/m/prompt"
            element={
              <ModuleAccess module={prompt}>
                <span>表示されない</span>
              </ModuleAccess>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/m/linkmemo"),
    );
    expect(screen.queryByText("表示されない")).not.toBeInTheDocument();
  });
});
