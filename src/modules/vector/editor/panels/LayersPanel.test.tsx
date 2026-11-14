import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_LIMITS } from "../model/limits";
import { sampleDocument } from "../model/testing";
import { deleteNodes } from "../model/structure";
import { getNode, getParent } from "../model/tree";
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

describe("LayersPanel の名前の変更と確定の規則", () => {
  const rename = (id: string) => {
    fireEvent.doubleClick(row(id));
    return screen.getByRole("textbox", { name: "レイヤーの名前" });
  };

  it("編集中の Undo で名前が変わっても、打っていなければ書き戻さない (Redo が残る)", () => {
    render(<LayersPanel />);
    let input = rename("r0");
    fireEvent.change(input, { target: { value: "背景" } });
    fireEvent.keyDown(input, { key: "Enter" });
    input = rename("r0");
    act(() => state().undo());
    fireEvent.blur(input);
    expect(getNode(state().doc, "r0")?.name).toBe("矩形");
    expect(state().canRedo).toBe(true);
  });

  it("編集中にノードが消えたら何もしない", () => {
    render(<LayersPanel />);
    const input = rename("r0");
    fireEvent.change(input, { target: { value: "背景" } });
    act(() => state().apply((doc) => deleteNodes(doc, ["r0"])));
    expect(state().revision).toBe(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("編集中に祖先が閉じられたら、打った名前を確定してから外す", () => {
    render(<LayersPanel />);
    const input = rename("r3");
    fireEvent.change(input, { target: { value: "アイコン" } });
    fireEvent.click(within(row("f")).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(getNode(state().doc, "r3")?.name).toBe("アイコン");
  });
});

describe("LayersPanel のドラッグ", () => {
  const ROW_H = 32;
  let scrollTop = 0;

  /** 行を上から ROW_H ずつ並べた画面を作る (jsdom はレイアウトしないため)。 */
  beforeEach(() => {
    scrollTop = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const rows = screen.queryAllByRole("treeitem");
      const index = rows.indexOf(this);
      if (index >= 0) {
        const top = index * ROW_H - scrollTop;
        return DOMRect.fromRect({ x: 0, y: top, width: 220, height: ROW_H });
      }
      if (this.getAttribute("role") === "tree")
        return DOMRect.fromRect({ x: 0, y: 0, width: 220, height: 1000 });
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (_x: number, y: number) =>
        screen.queryAllByRole("treeitem").filter((el) => {
          const rect = el.getBoundingClientRect();
          return y >= rect.top && y < rect.bottom;
        }),
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementsFromPoint");
    // dnd-kit はドラッグの後 50 ms、次のクリックを止める (ドラッグの直後のクリックを拾わないため)。
    // 次のテストの最初のクリックが止められないよう、それが外れるまで待つ
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  const pointer = (
    type: "pointerDown" | "pointerMove" | "pointerUp",
    target: Element | Document,
    x: number,
    y: number,
  ) =>
    act(() => {
      fireEvent[type](target, {
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
        isPrimary: true,
        pointerId: 1,
      });
    });

  it("ドラッグの途中で一覧がスクロールしても、今ポインターの下にある行で判定する", () => {
    render(<LayersPanel />);
    // 行: r0, f, f2, r3, grp, l1, r2, r1
    pointer("pointerDown", row("r0"), 100, 16);
    pointer("pointerMove", document, 100, 40);
    pointer("pointerMove", document, 100, 100); // r3 の上端 → r3 の前面 (f2 の中)
    expect(row("r3").querySelector("span.absolute")).not.toBeNull();
    scrollTop = ROW_H; // 一覧が 1 行分スクロールした
    act(() => {
      fireEvent.scroll(screen.getByRole("tree"));
    });
    // 同じ画面の位置の下は grp の上端 → grp の前面 (f の中)
    pointer("pointerUp", document, 100, 100);
    expect(getParent(state().doc, "r0")).toEqual({ kind: "node", id: "f" });
  });

  it("開いている最背面の frame の背面へ、最後の行の下の左端から落とせる", () => {
    render(<LayersPanel />);
    pointer("pointerDown", row("r0"), 100, 16);
    pointer("pointerMove", document, 100, 40);
    pointer("pointerMove", document, 2, 8 * ROW_H + 20); // 最後の行 (r1) の下の余白、左端
    pointer("pointerUp", document, 2, 8 * ROW_H + 20);
    expect(state().doc.pages[0]!.children).toEqual(["r0", "f"]);
    expect(state().revision).toBe(1);
  });

  it("落とせない位置 (自分の子孫) には挿入線を出さない", () => {
    render(<LayersPanel />);
    pointer("pointerDown", row("f"), 100, 48);
    pointer("pointerMove", document, 100, 70);
    pointer("pointerMove", document, 100, 100); // r3 は f の子孫
    expect(row("r3").querySelector("span.absolute")).toBeNull();
    pointer("pointerUp", document, 100, 100);
    expect(state().revision).toBe(0);
  });
});

describe("LayersPanel を StrictMode で描く (アプリと同じ)", () => {
  const strict = () =>
    render(
      <StrictMode>
        <LayersPanel />
      </StrictMode>,
    );

  it("名前の編集欄が開いたままで、確定・取消できる", () => {
    strict();
    fireEvent.doubleClick(row("r0"));
    let input = screen.getByRole("textbox", { name: "レイヤーの名前" });
    fireEvent.change(input, { target: { value: "背景" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getNode(state().doc, "r0")?.name).toBe("背景");
    expect(state().revision).toBe(1);
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.doubleClick(row("r0"));
    input = screen.getByRole("textbox", { name: "レイヤーの名前" });
    fireEvent.change(input, { target: { value: "前景" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(getNode(state().doc, "r0")?.name).toBe("背景");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("打ったまま祖先が閉じられたら確定し、打っていなければ何もしない", () => {
    strict();
    fireEvent.doubleClick(row("r3"));
    fireEvent.click(within(row("f")).getByRole("button", { name: "閉じる" }));
    expect(state().revision).toBe(0);
    fireEvent.click(within(row("f")).getByRole("button", { name: "開く" }));

    fireEvent.doubleClick(row("r3"));
    fireEvent.change(screen.getByRole("textbox", { name: "レイヤーの名前" }), {
      target: { value: "アイコン" },
    });
    fireEvent.click(within(row("f")).getByRole("button", { name: "閉じる" }));
    expect(getNode(state().doc, "r3")?.name).toBe("アイコン");
    expect(state().revision).toBe(1);
  });
});
