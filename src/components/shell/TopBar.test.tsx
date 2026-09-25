import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "@/store/useAppStore";

import { TopBar } from "./TopBar";

describe("TopBar sidebar toggle", () => {
  beforeEach(() => useAppStore.setState({ sidebarCollapsed: false }));

  it("closes and reopens the sidebar from the same button", () => {
    render(
      <MemoryRouter>
        <TopBar currentProject={null} onOpenSearch={() => undefined} />
      </MemoryRouter>,
    );

    const close = screen.getByRole("button", { name: "サイドバーを閉じる" });
    expect(close).toHaveAttribute("aria-expanded", "true");
    expect(close).toHaveAttribute("title", "サイドバーを閉じる (⌘B)");
    fireEvent.click(close);
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);

    const open = screen.getByRole("button", { name: "サイドバーを開く" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });
});
