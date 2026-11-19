import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetImportStatus } from "../assets/status";
import { createFrame, createRect } from "../model/create";
import type { BooleanNode, CanvasDocument, CanvasNode } from "../model/types";
import { editorStore } from "../state/store";
import { Toolbar } from "./Toolbar";
import {
  BOOLEAN_IN_PATH_EDIT,
  BOOLEAN_NEEDS_SELECTION,
  booleanButtonBlockReason,
} from "./toolbarItems";

const state = () => editorStore.getState();

/** 同じ親の矩形 a・b と、frame f の中の矩形 c。 */
function booleanDocument(): CanvasDocument {
  const nodes: CanvasNode[] = [
    createRect({ id: "a", x: 0, y: 0, width: 20, height: 20 }),
    createRect({ id: "b", x: 10, y: 10, width: 20, height: 20 }),
    createFrame({ id: "f", x: 100, y: 0, width: 100, height: 100, children: ["c"] }),
    createRect({ id: "c", x: 10, y: 10, width: 20, height: 20 }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["a", "b", "f"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

const booleanButton = () => screen.getByRole("button", { name: "ブーリアン演算" });
const zoomButton = () => screen.getByRole("button", { name: "倍率" });
const menuItem = (name: string) => screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });
const createdBoolean = () =>
  Object.values(state().doc.nodes).find((node): node is BooleanNode => node.type === "boolean");

beforeEach(() => {
  resetImportStatus();
  state().load(booleanDocument());
});

afterEach(cleanup);

describe("ツールバーのブーリアンのボタン (§5.1)", () => {
  it("倍率の前に置き、作れない選択では使えない表示にして理由を title に出す", () => {
    render(<Toolbar />);
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.slice(-3)).toEqual(["手のひら", "ブーリアン演算", "倍率"]);
    expect(booleanButton()).toHaveAttribute("aria-disabled", "true");
    expect(booleanButton().title).toContain(BOOLEAN_NEEDS_SELECTION);
    fireEvent.click(booleanButton(), { detail: 1 });
    expect(screen.queryByRole("menu")).toBeNull();

    act(() => state().setSelection(["a", "c"]));
    expect(booleanButton()).toHaveAttribute("aria-disabled", "true");
    expect(booleanButton().title).toContain("同じ親の中で選んでください");

    act(() => state().setSelection(["a", "b"]));
    expect(booleanButton()).not.toHaveAttribute("aria-disabled");
    expect(booleanButton()).toHaveAttribute("title", "ブーリアン演算");
  });

  it("点の編集中は使えない (判定は節と同じ booleanAvailability)", () => {
    const base = { ...state(), selection: ["a", "b"] };
    expect(booleanButtonBlockReason(base)).toBeNull();
    expect(booleanButtonBlockReason({ ...base, editingPathId: "a" })).toBe(BOOLEAN_IN_PATH_EDIT);
  });

  it("押すと 4 つの演算のメニューを開き、選んだ演算で作る (履歴 1 件)。ボタンのアイコンが変わる", () => {
    act(() => state().setSelection(["a", "b"]));
    render(<Toolbar />);
    expect(booleanButton().querySelector("[data-op]")).toHaveAttribute("data-op", "union");
    // マウスで押してもフォーカスを取らない
    expect(fireEvent.mouseDown(booleanButton())).toBe(false);
    fireEvent.click(booleanButton(), { detail: 1 });
    const menu = screen.getByRole("menu", { name: "ブーリアン演算" });
    expect(booleanButton()).toHaveAttribute("aria-expanded", "true");
    expect(booleanButton()).toHaveAttribute("aria-controls", menu.id);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "合体Alt+Shift+U",
      "型抜きAlt+Shift+S",
      "交差Alt+Shift+I",
      "中マドAlt+Shift+E",
    ]);
    // マウスで開いたときはフォーカスを動かさない
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(menuItem("型抜き"));
    expect(screen.queryByRole("menu")).toBeNull();
    const created = createdBoolean();
    expect(created?.op).toBe("subtract");
    expect(created?.children).toEqual(["a", "b"]);
    expect(state().selection).toEqual([created?.id]);
    expect(state().revision).toBe(1);
    expect(booleanButton().querySelector("[data-op]")).toHaveAttribute("data-op", "subtract");
  });

  it("キーボードで開き (Enter / Space)、↓ で移って Enter で選ぶ。Esc で閉じたらボタンへ戻る", () => {
    act(() => state().setSelection(["a", "b"]));
    render(<Toolbar />);
    booleanButton().focus();
    // キーボードで押したクリックは detail 0
    fireEvent.click(booleanButton(), { detail: 0 });
    expect(menuItem("合体")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(booleanButton()).toHaveFocus();

    fireEvent.keyDown(booleanButton(), { key: "ArrowDown" });
    expect(menuItem("合体")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(menuItem("交差")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(createdBoolean()?.op).toBe("intersect");
    expect(booleanButton()).toHaveFocus();
  });

  it("外を押すと閉じる。開いている間はキャンバスのショートカットを効かせない", () => {
    act(() => state().setSelection(["a", "b"]));
    render(<Toolbar />);
    fireEvent.click(booleanButton(), { detail: 1 });
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(state().doc.nodes.a).toBeDefined();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("開いている間に作れない選択になったら閉じる", () => {
    act(() => state().setSelection(["a", "b"]));
    render(<Toolbar />);
    fireEvent.click(booleanButton(), { detail: 1 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => state().setSelection(["a"]));
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => state().setSelection(["a", "b"]));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("倍率のメニュー (共通の部品)", () => {
  it("押すと開き、選ぶと閉じる。選択がなければ「選択範囲を表示」は使えない表示", () => {
    act(() => state().setViewport({ x: 0, y: 0, zoom: 2 }));
    render(<Toolbar />);
    fireEvent.click(zoomButton(), { detail: 1 });
    expect(screen.getByRole("menu", { name: "倍率" })).toBeInTheDocument();
    expect(menuItem("選択範囲を表示")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(menuItem("100%"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(state().viewport.zoom).toBe(1);
  });
});
