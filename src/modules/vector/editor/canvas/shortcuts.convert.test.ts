import { describe, expect, it } from "vitest";

import { createEllipse, createRect, createText } from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import type { KeyInput } from "./input";
import { CANVAS_SHORTCUTS, runShortcut, type ShortcutEnv } from "./shortcuts";

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

function doc(): CanvasDocument {
  const nodes: CanvasNode[] = [
    createRect({ id: "a", width: 10, height: 10 }),
    createEllipse({ id: "b", x: 5, width: 10, height: 10 }),
    createText({ id: "t" }),
  ];
  return {
    pages: [{ id: "p1", name: "ページ 1", children: ["a", "b", "t"], guides: [] }],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    assets: {},
  };
}

function env(selection: string[]): ShortcutEnv {
  const store = createEditorStore(doc());
  store.getState().setSelection(selection);
  return { store, size: { width: 800, height: 600 }, measurer: fixedWidthMeasurer() };
}

const run = (e: ShortcutEnv, input: Partial<KeyInput>, mac = true) =>
  runShortcut(key(input), e, CANVAS_SHORTCUTS, mac)?.id ?? null;

describe("変換のショートカット (§8.13)", () => {
  it("Cmd/Ctrl+E でパスに変換", () => {
    const e = env(["a"]);
    expect(run(e, { key: "e", code: "KeyE", metaKey: true })).toBe("convert.flatten");
    expect(e.store.getState().doc.nodes["a"]?.type).toBe("path");
    const w = env(["b"]);
    expect(run(w, { key: "e", code: "KeyE", ctrlKey: true }, false)).toBe("convert.flatten");
    expect(w.store.getState().doc.nodes["b"]?.type).toBe("path");
  });

  it("Alt+Shift+U / S / I / E は code で判定する (macOS の Option で文字が変わっても効く)", () => {
    for (const [code, op, typed] of [
      ["KeyU", "union", "¨"],
      ["KeyS", "subtract", "Í"],
      ["KeyI", "intersect", "ˆ"],
      ["KeyE", "exclude", "´"],
    ] as const) {
      const e = env(["a", "b"]);
      expect(run(e, { key: typed, code, altKey: true, shiftKey: true })).toBe(
        `convert.boolean.${op}`,
      );
      const state = e.store.getState();
      const [id] = state.selection;
      expect(state.doc.nodes[id!]).toMatchObject({ type: "boolean", op });
    }
  });

  it("作れない選択では文書を変えない。選択が空なら処理しない", () => {
    const e = env(["a", "t"]);
    const before = e.store.getState().doc;
    run(e, { key: "¨", code: "KeyU", altKey: true, shiftKey: true });
    run(e, { key: "e", code: "KeyE", metaKey: true });
    expect(e.store.getState().doc).toBe(before);
    expect(run(env([]), { key: "e", code: "KeyE", metaKey: true })).toBeNull();
  });

  it("押しっぱなしの繰り返しは何もせずに受ける", () => {
    const e = env(["a", "b"]);
    expect(run(e, { key: "e", code: "KeyE", metaKey: true, repeat: true })).toBe(
      "convert.ignoreRepeat",
    );
    expect(e.store.getState().revision).toBe(0);
  });
});
