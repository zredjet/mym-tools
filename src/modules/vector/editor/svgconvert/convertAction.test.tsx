import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getImportStatus, resetImportStatus } from "../assets/status";
import { createRect, createSvg } from "../model/create";
import type { CanvasDocument, CanvasNode, GroupNode, SvgAsset } from "../model/types";
import { validateSvg } from "../../policy/svg-policy.js";
import policy from "../../policy/policy.json";
import { convertContextOf } from "../panels/sections/convertSupport";
import { createEditorStore } from "../state/store";
import { ConvertConfirmDialog } from "./ConvertConfirmDialog";
import { openConvertConfirm } from "./openConvertConfirm";
import { convertSelectedSvg, SVG_CONVERT_ACTIONS } from "./convertAction";
import { measurer, svgOf } from "./testing";

const action = SVG_CONVERT_ACTIONS[0]!;

function storeWith(svg: string) {
  const asset: SvgAsset = {
    kind: "svg",
    svg,
    text: validateSvg(svg, policy).text,
    width: 100,
    height: 100,
  };
  const nodes: CanvasNode[] = [
    createRect({ id: "r", width: 10, height: 10 }),
    createSvg("a", { id: "s", name: "アイコン", x: 20, y: 20, width: 100, height: 100 }),
  ];
  const doc: CanvasDocument = {
    pages: [{ id: "p1", name: "ページ 1", children: ["r", "s"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    assets: { a: asset },
  };
  return createEditorStore(doc);
}

afterEach(() => {
  resetImportStatus();
  document.body.innerHTML = "";
});

describe("編集できる形に変換の操作", () => {
  it("埋め込み SVG を 1 個だけ選んでいるときだけ出す", () => {
    const store = storeWith(svgOf('<rect width="10" height="10"/>'));
    const state = () => convertContextOf(store.getState());
    store.getState().setSelection(["s"]);
    expect(action.availability(state())).toEqual({ enabled: true });
    store.getState().setSelection(["r"]);
    expect(action.availability(state())).toBeNull();
    store.getState().setSelection(["r", "s"]);
    expect(action.availability(state())).toBeNull();
  });

  it("落とすものがなければ確かめずに変換し、履歴 1 件で、作った group を選ぶ", async () => {
    const store = storeWith(
      svgOf('<rect width="10" height="10"/><circle cx="50" cy="50" r="10"/>'),
    );
    store.getState().setSelection(["s"]);
    const confirm = vi.fn(async () => true);
    expect(await convertSelectedSvg(store, { confirm, measurer })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    const state = store.getState();
    const id = state.selection[0]!;
    const group = state.doc.nodes[id] as GroupNode;
    expect(group).toMatchObject({ type: "group", name: "アイコン" });
    expect(group.children.map((c) => state.doc.nodes[c]?.type)).toEqual(["rect", "ellipse"]);
    expect(state.doc.pages[0]!.children).toEqual(["r", id]);
    state.undo();
    expect(store.getState().doc.nodes["s"]?.type).toBe("svg");
    expect(store.getState().doc.pages[0]!.children).toEqual(["r", "s"]);
  });

  it("落とすものがあれば確かめ、やめたら何もしない", async () => {
    const store = storeWith(
      svgOf('<rect width="10" height="10" filter="url(#f)"/><filter id="f"/>'),
    );
    store.getState().setSelection(["s"]);
    const before = store.getState().doc;
    const confirm = vi.fn(async () => false);
    expect(await convertSelectedSvg(store, { confirm, measurer })).toBe(false);
    expect(confirm).toHaveBeenCalledWith([
      { kind: "filter", label: expect.any(String) as string, count: 1 },
    ]);
    expect(store.getState().doc).toBe(before);
    confirm.mockResolvedValue(true);
    expect(await convertSelectedSvg(store, { confirm, measurer })).toBe(true);
    expect(store.getState().doc.nodes["s"]).toBeUndefined();
  });

  it("確かめている間に文書が変わったら、今の文書で作り直す", async () => {
    const store = storeWith(
      svgOf('<rect width="10" height="10" filter="url(#f)"/><filter id="f"/>'),
    );
    store.getState().setSelection(["s"]);
    const confirm = async () => {
      store.getState().apply((doc) => ({
        ...doc,
        nodes: { ...doc.nodes, r: { ...(doc.nodes["r"] as CanvasNode), name: "変えた" } },
      }));
      return true;
    };
    expect(await convertSelectedSvg(store, { confirm, measurer })).toBe(true);
    const doc = store.getState().doc;
    expect(doc.nodes["r"]?.name).toBe("変えた");
    expect(doc.nodes["s"]).toBeUndefined();
  });

  it("変換できる形がなければ理由を出す", async () => {
    const store = storeWith(svgOf('<rect width="10" height="10" fill="none"/>'));
    store.getState().setSelection(["s"]);
    expect(await convertSelectedSvg(store, { measurer })).toBe(false);
    expect(getImportStatus().notice?.tone).toBe("error");
    expect(getImportStatus().notice?.message).toMatch(/変換できる形/);
  });
});

describe("確認のダイアログ", () => {
  const items = [
    { kind: "filter" as const, label: "フィルタ", count: 2 },
    { kind: "mask" as const, label: "マスク", count: 1 },
  ];

  it("種類と件数を出し、変換するにフォーカスを置く。Enter で変換する", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConvertConfirmDialog items={items} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("フィルタ")).toBeTruthy();
    expect(screen.getByText("2 件")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "変換する" });
    expect(document.activeElement).toBe(confirm);
    const event = fireEvent.keyDown(confirm, { key: "Enter" });
    expect(event).toBe(false); // preventDefault (キャンバスへ渡さない)
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("やめるにフォーカスがあれば Enter でやめる。Esc でもやめる", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConvertConfirmDialog items={items} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "やめる" }), { key: "Enter" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();

    const second = vi.fn();
    render(<ConvertConfirmDialog items={items} onConfirm={onConfirm} onCancel={second} />);
    const escape = fireEvent.keyDown(screen.getByRole("button", { name: "変換する" }), {
      key: "Escape",
    });
    expect(escape).toBe(false);
    expect(second).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("openConvertConfirm は選んだ結果を返して片付ける", async () => {
    vi.useFakeTimers();
    try {
      let result!: Promise<boolean>;
      act(() => {
        result = openConvertConfirm(items);
      });
      const button = screen.getByRole("button", { name: "変換する" });
      act(() => {
        fireEvent.click(button);
      });
      await expect(result).resolves.toBe(true);
      act(() => {
        vi.runAllTimers();
      });
      expect(document.querySelector("[data-svg-convert-confirm]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
