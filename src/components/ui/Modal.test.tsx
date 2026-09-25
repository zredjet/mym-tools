import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "./Modal";

function Stacked({
  onCloseOuter,
  onCloseInner,
}: {
  onCloseOuter: () => void;
  onCloseInner: () => void;
}) {
  return (
    <>
      <Modal open onClose={onCloseOuter} title="外側">
        <button type="button">外側のボタン</button>
      </Modal>
      <Modal open onClose={onCloseInner} title="内側">
        <button type="button">内側 1</button>
        <button type="button">内側 2</button>
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("closes only the top-most modal on Escape", () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(<Stacked onCloseOuter={onCloseOuter} onCloseInner={onCloseInner} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCloseInner).toHaveBeenCalledOnce();
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it("labels each stacked dialog with its own heading", () => {
    render(<Stacked onCloseOuter={vi.fn()} onCloseInner={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "外側" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "内側" })).toBeInTheDocument();
  });

  it("moves focus inside, keeps Tab within the dialog, and restores focus on close", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            開く
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="確認">
            <button type="button">はい</button>
            <button type="button">いいえ</button>
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "開く" });
    opener.focus();
    fireEvent.click(opener);

    const yes = screen.getByRole("button", { name: "はい" });
    const no = screen.getByRole("button", { name: "いいえ" });
    expect(yes).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(no).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(yes).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("keeps an autofocused field focused", () => {
    render(
      <Modal open onClose={vi.fn()} title="検索">
        <button type="button">先頭</button>
        <input aria-label="クエリ" autoFocus />
      </Modal>,
    );
    expect(screen.getByLabelText("クエリ")).toHaveFocus();
  });
});
