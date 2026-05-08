/**
 * `ConfirmDeleteDialog` の振る舞い (`docs/ui-design.md` §6.8 C-15 / §8.6)。
 *
 * - 削除ボタンは name と入力が一致したときのみ有効化
 * - キャンセルで `onClose`、削除で `onConfirm`
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

describe("ConfirmDeleteDialog", () => {
  it("renders title with entityLabel and the name to type", () => {
    render(
      <ConfirmDeleteDialog
        open
        entityLabel="プロンプト"
        name="My Important Prompt"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/プロンプトを削除しますか/)).toBeInTheDocument();
    expect(screen.getByText("My Important Prompt")).toBeInTheDocument();
  });

  it("disables delete button until input matches name exactly", () => {
    render(
      <ConfirmDeleteDialog
        open
        entityLabel="プロンプト"
        name="exact-name"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const deleteButton = screen.getByRole("button", { name: /プロンプトを削除$/ });
    expect(deleteButton).toBeDisabled();

    const input = screen.getByLabelText("削除確認");
    fireEvent.change(input, { target: { value: "wrong" } });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "exact-name" } });
    expect(deleteButton).not.toBeDisabled();
  });

  it("calls onConfirm when matched name is submitted", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ConfirmDeleteDialog
        open
        entityLabel="Color"
        name="brand"
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText("削除確認"), { target: { value: "brand" } });
    fireEvent.click(screen.getByRole("button", { name: /Colorを削除$/ }));
    await new Promise((r) => setTimeout(r, 0));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on cancel without onConfirm", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDeleteDialog
        open
        entityLabel="プロンプト"
        name="x"
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
