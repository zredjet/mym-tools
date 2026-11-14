import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_LIMITS } from "../model/limits";
import { sampleDocument } from "../model/testing";
import { getNode } from "../model/tree";
import { editorStore } from "../state/store";
import { DEFAULT_VIEW_OPTIONS } from "../state/types";
import { LayersPanel } from "./LayersPanel";

const state = () => editorStore.getState();
const rowIds = () =>
  screen.getAllByRole("treeitem").map((row) => row.getAttribute("data-layer-id"));
const row = (id: string) => {
  const found = screen.getAllByRole("treeitem").find((el) => el.dataset.layerId === id);
  if (!found) throw new Error(`row not found: ${id}`);
  return found;
};

beforeEach(() => {
  state().load(sampleDocument());
  state().setView({ ...DEFAULT_VIEW_OPTIONS });
});

describe("LayersPanel の並びと開閉", () => {
  it("前面のノードを上に、木の順に並べる", () => {
    render(<LayersPanel />);
    expect(rowIds()).toEqual(["r0", "f", "f2", "r3", "grp", "l1", "r2", "r1"]);
    expect(row("f")).toHaveAttribute("aria-expanded", "true");
    expect(row("r3")).toHaveAttribute("aria-level", "3");
  });

  it("frame / group を閉じると子の行を出さない", () => {
    render(<LayersPanel />);
    fireEvent.click(within(row("f")).getByRole("button", { name: "閉じる" }));
    expect(rowIds()).toEqual(["r0", "f"]);
    fireEvent.click(within(row("f")).getByRole("button", { name: "開く" }));
    expect(rowIds()).toHaveLength(8);
  });

  it("文書の木が変わると並びも変わる", () => {
    render(<LayersPanel />);
    act(() =>
      state().apply((doc) => ({ ...doc, pages: [{ ...doc.pages[0]!, children: ["r0", "f"] }] })),
    );
    expect(rowIds().slice(0, 2)).toEqual(["f", "f2"]);
  });

  it("パネルを閉じると開くボタンだけになる", () => {
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole("button", { name: "レイヤーパネルを閉じる" }));
    expect(state().view.layersPanel).toBe(false);
    expect(screen.queryByRole("tree")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "レイヤーパネルを開く" }));
    expect(state().view.layersPanel).toBe(true);
    expect(screen.getByRole("tree")).toBeInTheDocument();
  });
});

describe("LayersPanel の選択とホバー", () => {
  it("クリックで選び、Cmd / Ctrl で足し引きする", () => {
    render(<LayersPanel />);
    fireEvent.click(row("r0"));
    expect(state().selection).toEqual(["r0"]);
    expect(row("r0")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(row("r1"), { metaKey: true });
    expect(state().selection).toEqual(["r0", "r1"]);
    fireEvent.click(row("r0"), { ctrlKey: true });
    expect(state().selection).toEqual(["r1"]);
  });

  it("Shift で行の並びの範囲を選ぶ", () => {
    render(<LayersPanel />);
    fireEvent.click(row("f2"));
    fireEvent.click(row("grp"), { shiftKey: true });
    expect(state().selection).toEqual(["f2", "r3", "grp"]);
  });

  it("キャンバスの選択を映し、閉じた祖先を開く", () => {
    render(<LayersPanel />);
    fireEvent.click(within(row("f")).getByRole("button", { name: "閉じる" }));
    act(() => state().setSelection(["r3"]));
    expect(row("r3")).toHaveAttribute("aria-selected", "true");
    expect(row("r0")).toHaveAttribute("aria-selected", "false");
  });

  it("何もない所を押すと選択を外す", () => {
    render(<LayersPanel />);
    act(() => state().setSelection(["r0"]));
    fireEvent.click(screen.getByRole("tree"));
    expect(state().selection).toEqual([]);
  });

  it("ホバーを store と同期する", () => {
    render(<LayersPanel />);
    fireEvent.pointerEnter(row("r1"));
    expect(state().hoveredId).toBe("r1");
    fireEvent.pointerLeave(row("r1"));
    expect(state().hoveredId).toBeNull();
  });
});

describe("LayersPanel の名前の変更", () => {
  const rename = () => {
    fireEvent.doubleClick(row("r0"));
    return screen.getByRole("textbox", { name: "レイヤーの名前" });
  };

  it("Enter で確定する (履歴 1 件)", () => {
    render(<LayersPanel />);
    const input = rename();
    expect(input).toHaveValue("矩形");
    fireEvent.change(input, { target: { value: "背景" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getNode(state().doc, "r0")?.name).toBe("背景");
    expect(state().revision).toBe(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Esc で取り消す", () => {
    render(<LayersPanel />);
    const input = rename();
    fireEvent.change(input, { target: { value: "背景" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(getNode(state().doc, "r0")?.name).toBe("矩形");
    expect(state().revision).toBe(0);
  });

  it("日本語入力の変換中の Enter では確定しない", () => {
    render(<LayersPanel />);
    const input = rename();
    fireEvent.change(input, { target: { value: "はいけい" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(screen.getByRole("textbox", { name: "レイヤーの名前" })).toBeInTheDocument();
    expect(getNode(state().doc, "r0")?.name).toBe("矩形");
  });

  it("上限の文字数で切る", () => {
    render(<LayersPanel />);
    const input = rename();
    fireEvent.change(input, { target: { value: "あ".repeat(CANVAS_LIMITS.maxNameLength + 5) } });
    fireEvent.blur(input);
    expect(Array.from(getNode(state().doc, "r0")?.name ?? "")).toHaveLength(
      CANVAS_LIMITS.maxNameLength,
    );
  });
});

describe("LayersPanel の表示とロック", () => {
  it("切り替えると文書に入り、元に戻せる", () => {
    render(<LayersPanel />);
    fireEvent.click(within(row("r1")).getByRole("button", { name: "非表示にする" }));
    expect(getNode(state().doc, "r1")?.visible).toBe(false);
    expect(within(row("r1")).getByRole("button", { name: "表示する" })).toBeInTheDocument();
    fireEvent.click(within(row("r1")).getByRole("button", { name: "ロックする" }));
    expect(getNode(state().doc, "r1")?.locked).toBe(true);
    // 切替は行の選択を変えない
    expect(state().selection).toEqual([]);
    act(() => state().undo());
    expect(getNode(state().doc, "r1")?.locked).toBe(false);
    expect(getNode(state().doc, "r1")?.visible).toBe(false);
  });
});
