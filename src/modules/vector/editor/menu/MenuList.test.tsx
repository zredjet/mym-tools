import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MenuList, type MenuEntry } from "./MenuList";
import { nextEnabledIndex } from "./menuNavigation";

afterEach(cleanup);

function entries(run = vi.fn()): MenuEntry[] {
  return [
    { type: "item", id: "a", label: "A", shortcut: "⌘A", run: () => run("a") },
    {
      type: "item",
      id: "b",
      label: "B",
      disabled: true,
      title: "使えない理由",
      run: () => run("b"),
    },
    { type: "separator", id: "s" },
    { type: "item", id: "c", label: "C", run: () => run("c") },
  ];
}

const item = (name: string) => screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });

describe("nextEnabledIndex", () => {
  it("使えない項目と区切りを飛ばし、端では反対の端へ回る", () => {
    const list = entries();
    expect(nextEnabledIndex(list, -1, 1)).toBe(0);
    expect(nextEnabledIndex(list, -1, -1)).toBe(3);
    expect(nextEnabledIndex(list, 0, 1)).toBe(3);
    expect(nextEnabledIndex(list, 3, 1)).toBe(0);
    expect(nextEnabledIndex(list, 3, -1)).toBe(0);
    expect(nextEnabledIndex(list, 0, -1)).toBe(3);
    expect(nextEnabledIndex([{ type: "separator", id: "s" }], -1, 1)).toBe(-1);
  });
});

describe("MenuList", () => {
  it("menu / menuitem / separator で出し、使えない項目は aria-disabled と理由の title", () => {
    render(<MenuList label="テスト" entries={entries()} onClose={() => {}} />);
    expect(screen.getByRole("menu", { name: "テスト" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(item("B")).toHaveAttribute("aria-disabled", "true");
    expect(item("B")).toHaveAttribute("title", "使えない理由");
    expect(item("A")).not.toHaveAttribute("aria-disabled");
    expect(item("A")).toHaveTextContent("⌘A");
  });

  it("first なら最初の使える項目にフォーカスを置き、↑↓ で使える項目だけを移る", () => {
    render(<MenuList label="テスト" entries={entries()} initialFocus="first" onClose={() => {}} />);
    expect(item("A")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(item("C")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(item("A")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(item("C")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(item("A")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(item("C")).toHaveFocus();
  });

  it("menu (既定) ならメニューそのものにフォーカスを置き、↓ で最初の項目へ入る", () => {
    render(<MenuList label="テスト" entries={entries()} onClose={() => {}} />);
    expect(screen.getByRole("menu")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(item("A")).toHaveFocus();
  });

  it("切り取られたメニューでは、移った項目が見えるようにメニューの中をスクロールする", () => {
    render(<MenuList label="テスト" entries={entries()} onClose={() => {}} />);
    const menu = screen.getByRole("menu");
    const place = (element: HTMLElement, top: number) => {
      Object.defineProperty(element, "offsetParent", { value: menu, configurable: true });
      Object.defineProperty(element, "offsetTop", { value: top, configurable: true });
      Object.defineProperty(element, "offsetHeight", { value: 28, configurable: true });
    };
    Object.defineProperty(menu, "clientHeight", { value: 40, configurable: true });
    place(item("A"), 4);
    place(item("C"), 70);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(item("C")).toHaveFocus();
    expect(menu.scrollTop).toBe(70 + 28 - 40);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(menu.scrollTop).toBe(4);
  });

  it("Enter と Space で選ぶ。閉じてから run を呼ぶ", () => {
    const order: string[] = [];
    const run = vi.fn((id: string) => order.push(`run:${id}`));
    const onClose = vi.fn((reason: string) => order.push(`close:${reason}`));
    const view = render(
      <MenuList label="テスト" entries={entries(run)} initialFocus="first" onClose={onClose} />,
    );
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(order).toEqual(["close:select", "run:a"]);
    view.unmount();
    render(
      <MenuList label="テスト" entries={entries(run)} initialFocus="first" onClose={onClose} />,
    );
    fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("押しっぱなしの Enter / Space の繰り返しでは選ばない", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(
      <MenuList label="テスト" entries={entries(run)} initialFocus="first" onClose={onClose} />,
    );
    fireEvent.keyDown(document.activeElement!, { key: "Enter", repeat: true });
    fireEvent.keyDown(document.activeElement!, { key: " ", repeat: true });
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("飲み込むキーは既定の動きも止める (ブラウザのすべて選択などに落とさない)", () => {
    render(<MenuList label="テスト" entries={entries()} onClose={() => {}} />);
    expect(fireEvent.keyDown(document.activeElement!, { key: "a", metaKey: true })).toBe(false);
    expect(fireEvent.keyDown(document.activeElement!, { key: "r" })).toBe(false);
  });

  it("ダイアログがフォーカスを取ったら閉じ、ダイアログのキーはそのまま通す", () => {
    const onClose = vi.fn();
    const dialogKeys = vi.fn();
    render(
      <>
        <MenuList label="テスト" entries={entries()} initialFocus="first" onClose={onClose} />
        <div role="dialog" aria-modal="true" onKeyDown={(event) => dialogKeys(event.key)}>
          <button type="button">ダイアログの保存</button>
        </div>
      </>,
    );
    const save = screen.getByRole("button", { name: "ダイアログの保存" });
    act(() => save.focus());
    expect(onClose).toHaveBeenCalledWith("outside");
    expect(fireEvent.keyDown(save, { key: "Enter" })).toBe(true);
    expect(dialogKeys).toHaveBeenCalledWith("Enter");
  });

  it("モーダルが開いていれば、メニューの中のキーでも閉じて通す", () => {
    const onClose = vi.fn();
    render(
      <>
        <MenuList label="テスト" entries={entries()} initialFocus="first" onClose={onClose} />
        <div aria-modal="true" />
      </>,
    );
    expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(true);
    expect(onClose).toHaveBeenCalledWith("outside");
  });

  it("使えない項目は押しても何もせず、閉じない", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<MenuList label="テスト" entries={entries(run)} onClose={onClose} />);
    fireEvent.click(item("B"));
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(item("C"));
    expect(run).toHaveBeenCalledWith("c");
    expect(onClose).toHaveBeenCalledWith("select");
  });

  it("Esc で閉じ、開く前の要素へフォーカスを戻す。開いている間のキーはほかへ渡さない", () => {
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    const onClose = vi.fn();
    render(<button type="button">開く前</button>);
    const before = screen.getByRole("button", { name: "開く前" });
    before.focus();
    render(<MenuList label="テスト" entries={entries()} initialFocus="first" onClose={onClose} />);
    expect(item("A")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "r" });
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("escape");
    expect(before).toHaveFocus();
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outer);
  });

  it("StrictMode (開いたときの処理が 2 回走る) でも、開く前の要素へフォーカスを戻す", () => {
    render(<button type="button">開く前</button>);
    const before = screen.getByRole("button", { name: "開く前" });
    before.focus();
    render(
      <StrictMode>
        <MenuList label="テスト" entries={entries()} initialFocus="first" onClose={() => {}} />
      </StrictMode>,
    );
    expect(item("A")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(before).toHaveFocus();
  });

  it("Tab で閉じる (既定の移動に任せる)", () => {
    const onClose = vi.fn();
    render(<MenuList label="テスト" entries={entries()} initialFocus="first" onClose={onClose} />);
    const event = fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(event).toBe(true); // preventDefault していない
    expect(onClose).toHaveBeenCalledWith("tab");
  });

  it("ウィンドウのフォーカスが外れたら閉じる", () => {
    const onClose = vi.fn();
    render(<MenuList label="テスト" entries={entries()} onClose={onClose} />);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(onClose).toHaveBeenCalledWith("blur");
  });

  it("外を押すと閉じ、中 (insideRef を含む) を押しても閉じない", () => {
    const onClose = vi.fn();
    const inside = { current: null as HTMLElement | null };
    render(
      <>
        <button type="button" ref={(el) => void (inside.current = el)}>
          開くボタン
        </button>
        <button type="button">外</button>
        <MenuList label="テスト" entries={entries()} insideRef={inside} onClose={onClose} />
      </>,
    );
    fireEvent.pointerDown(item("A"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "開くボタン" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "外" }));
    expect(onClose).toHaveBeenCalledWith("outside");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("マウスで押してもフォーカスを取らない", () => {
    render(<MenuList label="テスト" entries={entries()} onClose={() => {}} />);
    expect(fireEvent.mouseDown(item("A"))).toBe(false);
  });
});
