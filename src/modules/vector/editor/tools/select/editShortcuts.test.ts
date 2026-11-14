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
  // 既定は macOS の割当 (mod = Cmd)。Windows は mac = false (mod = Ctrl)
  const run = (patch: Partial<KeyInput>, mac = true) =>
    runShortcut(key(patch), env, undefined, mac)?.id ?? null;
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
    // 選択がなければ削除はせず、ブラウザへも回さない
    const before = s().doc;
    expect(run({ key: "Delete" })).toBe("edit.ignoreRepeat");
    expect(s().doc).toBe(before);
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

  it("押しっぱなしの繰り返しを受けるのは矢印と Undo / Redo だけ。ほかは何もせずに受ける", () => {
    const { run, s } = setup();
    s().setSelection(["r1", "grp"]);
    expect(run({ key: "g", metaKey: true, repeat: true })).toBe("edit.ignoreRepeat");
    expect(s().revision).toBe(0);
    expect(run({ key: "g", metaKey: true })).toBe("edit.group");
    const group = s().selection[0]!;
    // 押しっぱなしで group が入れ子に増えない
    expect(run({ key: "g", metaKey: true, repeat: true })).toBe("edit.ignoreRepeat");
    expect(s().selection).toEqual([group]);
    expect(s().revision).toBe(1);
    for (const k of ["d", "a", "c", "v", "x"])
      expect(run({ key: k, metaKey: true, repeat: true })).toBe("edit.ignoreRepeat");
    expect(run({ key: "]", repeat: true })).toBe("edit.ignoreRepeat");
    expect(run({ key: "]", metaKey: true, repeat: true })).toBe("edit.ignoreRepeat");
    expect(run({ key: "[", metaKey: true, repeat: true })).toBe("edit.ignoreRepeat");
    expect(run({ key: "G", metaKey: true, shiftKey: true, repeat: true })).toBe(
      "edit.ignoreRepeat",
    );
    expect(run({ key: "Backspace", repeat: true })).toBe("edit.ignoreRepeat");
    expect(s().revision).toBe(1);
    expect(run({ key: "Enter", repeat: true })).toBeNull();
    expect(run({ key: "Escape", repeat: true })).toBeNull();
    // 矢印と Undo / Redo は繰り返す
    expect(run({ key: "ArrowRight", repeat: true })).toBe("edit.nudge.ArrowRight.1");
    expect(run({ key: "z", metaKey: true, repeat: true })).toBe("edit.undo");
    expect(run({ key: "z", metaKey: true, shiftKey: true, repeat: true })).toBe("edit.redo");
  });

  it("Windows の割当 (mod = Ctrl)", () => {
    const { run, s } = setup();
    editorClipboard.clear();
    s().setSelection(["r0"]);
    expect(run({ key: "ArrowRight" }, false)).toBe("edit.nudge.ArrowRight.1");
    expect(run({ key: "z", ctrlKey: true }, false)).toBe("edit.undo");
    expect(s().doc.nodes.r0).toMatchObject({ x: 0 });
    expect(run({ key: "Z", ctrlKey: true, shiftKey: true }, false)).toBe("edit.redo");
    expect(run({ key: "d", ctrlKey: true }, false)).toBe("edit.duplicate");
    expect(run({ key: "a", ctrlKey: true }, false)).toBe("edit.selectAll");
    s().setSelection(["r1", "grp"]);
    expect(run({ key: "g", ctrlKey: true }, false)).toBe("edit.group");
    expect(run({ key: "G", ctrlKey: true, shiftKey: true }, false)).toBe("edit.ungroup");
    expect(run({ key: "]", ctrlKey: true }, false)).toBe("edit.bringForward");
    // Windows で Cmd (meta) は mod ではない
    expect(run({ key: "z", metaKey: true }, false)).toBeNull();
    expect(run({ key: "s", ctrlKey: true }, false)).toBeNull();
    editorClipboard.clear();
  });
});
