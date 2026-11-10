import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { moveItem } from "@/ipc/items";
import { listProjects } from "@/ipc/projects";
import type { Project } from "@/lib/types";

import { MoveItemDialog } from "./MoveItemDialog";

vi.mock("@/ipc/items", () => ({ moveItem: vi.fn() }));
vi.mock("@/ipc/projects", () => ({ listProjects: vi.fn() }));

function project(id: string, name: string, position: number): Project {
  return {
    id,
    name,
    description: null,
    position,
    created_at: "2026-11-10T00:00:00.000+09:00",
    updated_at: "2026-11-10T00:00:00.000+09:00",
  };
}

const projects = [
  project("p-work", "Work", 0),
  project("p-home", "Home", 1),
  project("p-lab", "Lab", 2),
];

function renderDialog(overrides: Partial<Parameters<typeof MoveItemDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onMoved = vi.fn();
  const view = render(
    <MoveItemDialog
      item={{ id: "item-1", title: "週次レポート" }}
      moduleId="prompt"
      currentProjectId="p-work"
      entityLabel="プロンプト"
      onClose={onClose}
      onMoved={onMoved}
      {...overrides}
    />,
  );
  return { onClose, onMoved, ...view };
}

describe("MoveItemDialog", () => {
  beforeEach(() => {
    vi.mocked(moveItem).mockReset().mockResolvedValue(undefined);
    vi.mocked(listProjects).mockReset().mockResolvedValue(projects);
  });

  it("is closed and loads nothing while there is no item", () => {
    renderDialog({ item: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("lists the other projects in sidebar order and needs a choice before moving", async () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: "プロンプトを別のプロジェクトへ移動" }),
    ).toBeVisible();
    expect(screen.getByText("「週次レポート」の移動先を選んでください。")).toBeVisible();

    const radios = await screen.findAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual(["Home", "Lab"]);
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "移動" })).toBeDisabled();
  });

  it("moves the item to the chosen project, then reports it and closes", async () => {
    const { onClose, onMoved } = renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: "Lab" }));
    fireEvent.click(screen.getByRole("button", { name: "移動" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(moveItem).toHaveBeenCalledWith({
      moduleId: "prompt",
      itemId: "item-1",
      targetProjectId: "p-lab",
    });
    expect(onMoved).toHaveBeenCalledWith(projects[2]);
  });

  it("keeps the dialog open and shows the error when the move fails", async () => {
    vi.mocked(moveItem).mockRejectedValue({ code: "not_found", message: "project not found" });
    const { onClose, onMoved } = renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "移動" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("[not_found] project not found");
    expect(onMoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "移動" })).toBeEnabled();
  });

  it("explains that there is nowhere to move when this is the only project", async () => {
    vi.mocked(listProjects).mockResolvedValue([projects[0]!]);
    renderDialog();
    expect(await screen.findByText(/移動先にできるプロジェクトがありません/)).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移動" })).toBeDisabled();
  });

  it("shows the error when the project list cannot be loaded", async () => {
    vi.mocked(listProjects).mockRejectedValue("database is locked");
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
    expect(screen.getByRole("button", { name: "移動" })).toBeDisabled();
  });

  it("closes without moving on cancel", async () => {
    const { onClose } = renderDialog();
    await screen.findAllByRole("radio");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(moveItem).not.toHaveBeenCalled();
  });
});
