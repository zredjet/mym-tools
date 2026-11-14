/**
 * `canvas/shortcuts.ts` の「編集」の節 (このセッションが足したもの) の検査。
 */
import { describe, expect, it } from "vitest";
import type { KeyInput } from "../../canvas/input";
import { runShortcut, type ShortcutEnv } from "../../canvas/shortcuts";
import { sampleDocument } from "../../model/testing";
import { fixedWidthMeasurer } from "../../render/testing";
import { editorClipboard } from "../../state/clipboard";
import { createEditorStore } from "../../state/store";

function key(patch: Partial<KeyInput>): KeyInput {
  return {
    key: "",
    code: "",
    repeat: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...patch,
  };
}

function setup() {
  const store = createEditorStore(sampleDocument());
  const env: ShortcutEnv = {
    store,
    size: { width: 800, height: 600 },
    measurer: fixedWidthMeasurer(),
  };
  // macOS の割当で調べる (mod = Cmd)
  const run = (patch: Partial<KeyInput>) =>
    runShortcut(key(patch), env, undefined, true)?.id ?? null;
  return { store, run, s: () => store.getState() };
}

describe("編集のショートカット", () => {
  it("矢印は 1 px、Shift と一緒なら 10 px", () => {
    const { run, s } = setup();
    s().setSelection(["r0"]);
    expect(run({ key: "ArrowRight" })).toBe("edit.nudge.ArrowRight.1");
    expect(run({ key: "ArrowDown", shiftKey: true })).toBe("edit.nudge.ArrowDown.10");
    expect(s().doc.nodes.r0).toMatchObject({ x: 1, y: 10 });
    s().setSelection([]);
    expect(run({ key: "ArrowLeft" })).toBeNull();
  });

  it("Undo / Redo", () => {
    const { run, s } = setup();
    s().setSelection(["r0"]);
    run({ key: "ArrowRight" });
    expect(run({ key: "z", metaKey: true })).toBe("edit.undo");
    expect(s().doc.nodes.r0).toMatchObject({ x: 0 });
    expect(run({ key: "Z", metaKey: true, shiftKey: true })).toBe("edit.redo");
    expect(s().doc.nodes.r0).toMatchObject({ x: 1 });
  });

  it("コピー・貼り付け・切り取り・複製・削除・すべて選択", () => {
    const { run, s } = setup();
    editorClipboard.clear();
    s().setSelection(["r0"]);
    expect(run({ key: "c", metaKey: true })).toBe("edit.copy");
    expect(run({ key: "v", metaKey: true })).toBe("edit.paste");
    const pasted = s().selection[0]!;
    expect(s().doc.nodes[pasted]).toMatchObject({ x: 10, y: 10 });
    expect(run({ key: "d", metaKey: true })).toBe("edit.duplicate");
    const copy = s().selection[0]!;
    expect(s().doc.nodes[copy]).toMatchObject({ x: 20, y: 20 });
    expect(run({ key: "Backspace" })).toBe("edit.delete");
    expect(s().doc.nodes[copy]).toBeUndefined();
    expect(run({ key: "Delete" })).toBeNull(); // 選択がなければ処理しない
    s().setSelection([pasted]);
    expect(run({ key: "x", metaKey: true })).toBe("edit.cut");
    expect(s().doc.nodes[pasted]).toBeUndefined();
    expect(run({ key: "a", metaKey: true })).toBe("edit.selectAll");
    expect(s().selection).toEqual(["f", "r0"]);
    editorClipboard.clear();
  });

  it("グループ化と解除", () => {
    const { run, s } = setup();
    s().setSelection(["r1", "grp"]);
    expect(run({ key: "g", metaKey: true })).toBe("edit.group");
    const group = s().selection[0]!;
    expect(s().doc.nodes[group]?.type).toBe("group");
    expect(run({ key: "G", metaKey: true, shiftKey: true })).toBe("edit.ungroup");
    expect(s().selection).toEqual(["r1", "grp"]);
  });

  it("重なり順", () => {
    const { run, s } = setup();
    const order = () => (s().doc.nodes.f as { children: string[] }).children.join(",");
    s().setSelection(["r1"]);
    expect(run({ key: "]" })).toBe("edit.bringToFront");
    expect(order()).toBe("grp,f2,r1");
    expect(run({ key: "[", metaKey: true })).toBe("edit.sendBackward");
    expect(order()).toBe("grp,r1,f2");
    expect(run({ key: "[" })).toBe("edit.sendToBack");
    expect(order()).toBe("r1,grp,f2");
    expect(run({ key: "]", metaKey: true })).toBe("edit.bringForward");
    expect(order()).toBe("grp,r1,f2");
  });

  it("Enter と Esc", () => {
    const { run, s } = setup();
    s().setSelection(["grp"]);
    expect(run({ key: "Enter" })).toBe("edit.enter");
    expect(s().scopeId).toBe("grp");
    expect(run({ key: "Enter", repeat: true })).toBeNull();
    expect(run({ key: "Escape" })).toBe("edit.escape");
    expect(s()).toMatchObject({ scopeId: null, selection: ["grp"] });
    expect(run({ key: "Escape" })).toBe("edit.escape");
    expect(s().selection).toEqual([]);
    expect(run({ key: "Escape" })).toBeNull();
    // ほかのツールの Esc は選択ツールへ戻す (選択は解除しない)
    s().setSelection(["r0"]);
    s().setTool("rect");
    expect(run({ key: "Escape" })).toBe("tool.escape");
    expect(s().selection).toEqual(["r0"]);
  });

  it("Cmd/Ctrl+S と Cmd/Ctrl+N は取らない (作品バーの担当)", () => {
    const { run } = setup();
    expect(run({ key: "s", metaKey: true })).toBeNull();
    expect(run({ key: "n", metaKey: true })).toBeNull();
  });
});
