import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isContextPress } from "../canvas/input";
import { registerPointerDrag } from "../canvas/pointerDrag";
import {
  createFrame,
  createGroup,
  createPath,
  createRect,
  createStroke,
  createSvg,
} from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { resetPathEditSession, setPenDrawing } from "../path/editSession";
import { fixedWidthMeasurer } from "../render/testing";
import { EditorClipboard } from "../state/clipboard";
import { editorStore } from "../state/store";
import { square } from "../tools/pathEdit/testing";
import { canOpenContextMenu, placeMenu, selectForContextMenu } from "./contextMenu";
import { contextMenuEntries } from "./contextMenuItems";
import type { MenuEntry, MenuItem } from "./MenuList";

const state = () => editorStore.getState();
const measurer = fixedWidthMeasurer();

/**
 * a・b: ページ直下の矩形、f: ページ直下の frame (子 c)、g: group (子 d・e)、l: ロックした矩形、
 * p: 線のあるパス、s: 埋め込み SVG。
 */
function menuDocument(): CanvasDocument {
  const nodes: CanvasNode[] = [
    createRect({ id: "a", x: 0, y: 0, width: 20, height: 20 }),
    createRect({ id: "b", x: 30, y: 0, width: 20, height: 20 }),
    createFrame({ id: "f", name: "F", x: 100, y: 0, width: 100, height: 100, children: ["c"] }),
    createRect({ id: "c", x: 10, y: 10, width: 20, height: 20 }),
    createGroup(["d", "e"], { id: "g" }),
    createRect({ id: "d", x: 0, y: 100, width: 20, height: 20 }),
    createRect({ id: "e", x: 30, y: 100, width: 20, height: 20 }),
    createRect({ id: "l", x: 60, y: 0, width: 20, height: 20, locked: true }),
    createPath([square(20)], { id: "p", x: 0, y: 200, stroke: createStroke() }),
    createSvg("asset", { id: "s", x: 300, y: 300, width: 10, height: 10 }),
  ];
  return {
    pages: [
      { id: "p1", name: "ページ 1", children: ["a", "b", "f", "g", "l", "p", "s"], guides: [] },
    ],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

beforeEach(() => {
  state().load(menuDocument());
  state().setViewport({ x: 0, y: 0, zoom: 1 });
});

afterEach(() => {
  resetPathEditSession();
});

const pick = (x: number, y: number, deep = false) =>
  selectForContextMenu(editorStore, { x, y }, deep, measurer);

describe("isContextPress", () => {
  it("右ボタンと、macOS の Ctrl+クリック", () => {
    expect(isContextPress({ button: 2, ctrlKey: false }, false)).toBe(true);
    expect(isContextPress({ button: 0, ctrlKey: true }, true)).toBe(true);
    expect(isContextPress({ button: 0, ctrlKey: true }, false)).toBe(false);
    expect(isContextPress({ button: 0, ctrlKey: false }, true)).toBe(false);
    expect(isContextPress({ button: 1, ctrlKey: true }, true)).toBe(false);
  });
});

describe("右クリックで選ぶもの (§5.8)", () => {
  it("選んでいないノードの上なら、それだけを選ぶ", () => {
    state().setSelection(["b"]);
    pick(10, 10);
    expect(state().selection).toEqual(["a"]);
  });

  it("選んでいるノードの上と、選択の外接矩形の中の何もない所では選択を変えない", () => {
    state().setSelection(["a", "b"]);
    pick(40, 10);
    expect(state().selection).toEqual(["a", "b"]);
    pick(25, 10);
    expect(state().selection).toEqual(["a", "b"]);
  });

  it("何もない所なら選択を外す。ロックしたノードは当たらない", () => {
    state().setSelection(["a"]);
    pick(70, 10);
    expect(state().selection).toEqual([]);
    state().setSelection(["a"]);
    pick(500, 500);
    expect(state().selection).toEqual([]);
  });

  it("クリックと同じく、group はまず全体を、Cmd/Ctrl ならいちばん深いノードを選ぶ。frame の子は直接選ぶ", () => {
    pick(10, 110);
    expect(state().selection).toEqual(["g"]);
    pick(40, 110, true);
    expect(state().selection).toEqual(["e"]);
    pick(115, 15);
    expect(state().selection).toEqual(["c"]);
  });

  it("group の中のスコープでは、中の子を選ぶ", () => {
    state().setScope("g");
    state().setSelection(["d"]);
    pick(40, 110);
    expect(state().selection).toEqual(["e"]);
    expect(state().scopeId).toBe("g");
  });

  it("frame の名前のラベルの上なら frame を選ぶ", () => {
    pick(104, -10);
    expect(state().selection).toEqual(["f"]);
  });
});

describe("メニューを出さないとき", () => {
  it("点の編集中、本文の編集中、ペンで描いている間、ドラッグの途中", () => {
    const base = { editingPathId: null, editingTextId: null, toolId: "select" as const };
    expect(canOpenContextMenu(base)).toBe(true);
    expect(canOpenContextMenu({ ...base, editingPathId: "p" })).toBe(false);
    expect(canOpenContextMenu({ ...base, editingTextId: "t" })).toBe(false);
    setPenDrawing({ target: { kind: "new" } } as never);
    expect(canOpenContextMenu({ ...base, toolId: "pen" })).toBe(false);
    expect(canOpenContextMenu(base)).toBe(true);
    resetPathEditSession();
    const unregister = registerPointerDrag({ isActive: () => true, cancel: () => true });
    expect(canOpenContextMenu(base)).toBe(false);
    unregister();
  });
});

const labels = (entries: readonly MenuEntry[]) =>
  entries.map((entry) => (entry.type === "separator" ? "---" : entry.label));
const byLabel = (entries: readonly MenuEntry[], label: string): MenuItem => {
  const found = entries.find(
    (entry): entry is MenuItem => entry.type === "item" && entry.label === label,
  );
  if (!found) throw new Error(`no item: ${label}`);
  return found;
};
const enabled = (entries: readonly MenuEntry[]) =>
  entries.flatMap((entry) => (entry.type === "item" && !entry.disabled ? [entry.label] : []));

describe("メニューの項目 (§5.8)", () => {
  it("選択があるとき: Figma にならった並びと区切り。当てられない項目は使えない表示", () => {
    state().setSelection(["a"]);
    const entries = contextMenuEntries(editorStore, new EditorClipboard());
    expect(labels(entries)).toEqual([
      "切り取り",
      "コピー",
      "貼り付け",
      "複製",
      "削除",
      "---",
      "最前面へ",
      "前面へ",
      "背面へ",
      "最背面へ",
      "---",
      "グループ化",
      "グループ解除",
      "パスに変換",
      "線のアウトライン化",
      "---",
      "合体",
      "型抜き",
      "交差",
      "中マド",
      "---",
      "左右反転",
      "上下反転",
    ]);
    expect(enabled(entries)).toEqual([
      "切り取り",
      "コピー",
      "複製",
      "削除",
      "最前面へ",
      "前面へ",
      "グループ化",
      "パスに変換",
      "左右反転",
      "上下反転",
    ]);
    expect(byLabel(entries, "コピー").shortcut).toBe("Ctrl+C");
    expect(byLabel(entries, "合体").shortcut).toBe("Alt+Shift+U");
    expect(byLabel(entries, "最前面へ").shortcut).toBe("]");
  });

  it("同じ親の 2 個ならブーリアンを使え、親が違えば理由を title に出す", () => {
    state().setSelection(["a", "b"]);
    expect(enabled(contextMenuEntries(editorStore))).toContain("中マド");
    state().setSelection(["a", "c"]);
    const entries = contextMenuEntries(editorStore);
    expect(byLabel(entries, "合体").disabled).toBe(true);
    expect(byLabel(entries, "合体").title).toContain("同じ親の中で選んでください");
  });

  it("線のあるパスはアウトライン化でき、group はグループ解除できる。埋め込み SVG は「編集できる形に変換」を出す", () => {
    state().setSelection(["p"]);
    expect(enabled(contextMenuEntries(editorStore))).toContain("線のアウトライン化");
    expect(labels(contextMenuEntries(editorStore))).not.toContain("編集できる形に変換");
    state().setSelection(["g"]);
    expect(enabled(contextMenuEntries(editorStore))).toContain("グループ解除");
    state().setSelection(["s"]);
    const entries = contextMenuEntries(editorStore);
    expect(labels(entries).slice(11, 16)).toEqual([
      "グループ化",
      "グループ解除",
      "パスに変換",
      "線のアウトライン化",
      "編集できる形に変換",
    ]);
    expect(byLabel(entries, "編集できる形に変換").disabled).toBe(false);
    expect(byLabel(entries, "左右反転").disabled).toBe(true);
  });

  it("何もない所: 貼り付けとすべて選択", () => {
    const clipboard = new EditorClipboard();
    let entries = contextMenuEntries(editorStore, clipboard);
    expect(labels(entries)).toEqual(["貼り付け", "すべて選択"]);
    expect(enabled(entries)).toEqual(["すべて選択"]);
    clipboard.copy(state().doc, ["a"]);
    entries = contextMenuEntries(editorStore, clipboard);
    expect(enabled(entries)).toEqual(["貼り付け", "すべて選択"]);
    byLabel(entries, "すべて選択").run();
    // ロックしたノードは選ばない
    expect(state().selection).toEqual(["a", "b", "f", "g", "p", "s"]);
  });

  it("項目はショートカットと同じ関数を呼ぶ (履歴 1 件)", () => {
    const clipboard = new EditorClipboard();
    state().setSelection(["a", "b"]);
    byLabel(contextMenuEntries(editorStore, clipboard), "グループ化").run();
    const group = state().selection[0]!;
    expect(state().doc.nodes[group]?.type).toBe("group");
    expect(state().revision).toBe(1);
    byLabel(contextMenuEntries(editorStore, clipboard), "グループ解除").run();
    expect(state().selection).toEqual(["a", "b"]);
    byLabel(contextMenuEntries(editorStore, clipboard), "型抜き").run();
    const created = state().doc.nodes[state().selection[0]!];
    expect(created?.type === "boolean" && created.op).toBe("subtract");
    expect(state().revision).toBe(3);
    byLabel(contextMenuEntries(editorStore, clipboard), "コピー").run();
    byLabel(contextMenuEntries(editorStore, clipboard), "貼り付け").run();
    expect(state().revision).toBe(4);
    byLabel(contextMenuEntries(editorStore, clipboard), "削除").run();
    expect(state().revision).toBe(5);
    state().undo();
    expect(state().revision).toBe(6);
  });
});

describe("メニューの位置 (placeMenu)", () => {
  const bounds = { width: 800, height: 600 };
  const menu = { width: 200, height: 300 };

  it("押した位置の右下に開く", () => {
    expect(placeMenu({ x: 100, y: 50 }, menu, bounds)).toEqual({ x: 100, y: 50 });
  });

  it("右と下にはみ出すなら、押した位置の左と上へ開く", () => {
    expect(placeMenu({ x: 750, y: 500 }, menu, bounds)).toEqual({ x: 550, y: 200 });
  });

  it("どちらにも収まらなければ、端から 4 px あけて収まる範囲で押した位置に近い所へ寄せる", () => {
    expect(
      placeMenu({ x: 150, y: 250 }, { width: 200, height: 500 }, { width: 300, height: 520 }),
    ).toEqual({ x: 96, y: 16 });
    expect(placeMenu({ x: 0, y: 0 }, { width: 900, height: 700 }, bounds)).toEqual({ x: 4, y: 4 });
  });
});
