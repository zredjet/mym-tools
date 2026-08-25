import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createItem } from "@/ipc/items";

import { LinkMemoItemDialog } from "./LinkMemoItemDialog";

vi.mock("@/ipc/items", () => ({ createItem: vi.fn(), updateItem: vi.fn() }));
vi.mock("@/ipc/linkmemo", () => ({ linkmemoNormalizeTarget: vi.fn() }));

describe("LinkMemoItemDialog after the split", () => {
  beforeEach(() => vi.mocked(createItem).mockResolvedValue("link-1"));

  it("offers URL and Path only and retains the optional Link note", async () => {
    const user = userEvent.setup();
    render(
      <LinkMemoItemDialog
        mode="create"
        projectId="project-1"
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Path" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memo" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("タイトル"), "Docs");
    await user.type(screen.getByLabelText("URL"), "https://example.com");
    await user.type(screen.getByLabelText("メモ (任意)"), "link note");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() =>
      expect(createItem).toHaveBeenCalledWith(
        expect.objectContaining({
          moduleId: "linkmemo",
          payload: { type: "url", target: "https://example.com", body: "link note" },
        }),
      ),
    );
  });
});
