import { describe, expect, it } from "vitest";
import { createEditorStore } from "../state/store";
import { sampleDocument } from "../model/testing";
import { fixedWidthMeasurer } from "../render/testing";
import type { KeyInput } from "./input";
import { CANVAS_SHORTCUTS, keyMatches, runShortcut, type ShortcutEnv } from "./shortcuts";

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

function env(): ShortcutEnv {
  return {
    store: createEditorStore(sampleDocument()),
    size: { width: 800, height: 600 },
    measurer: fixedWidthMeasurer(),
  };
}

describe("keyMatches", () => {
  it("1 文字の key は大文字小文字を区別せず、指定のない修飾キーは押していないこと", () => {
    expect(keyMatches({ key: ["v"] }, key({ key: "V" }), true)).toBe(true);
    expect(keyMatches({ key: ["v"] }, key({ key: "v", shiftKey: true }), true)).toBe(false);
    expect(keyMatches({ key: ["v"] }, key({ key: "v", metaKey: true }), true)).toBe(false);
  });

  it("mod は macOS で Cmd、Windows で Ctrl。mod でない方が押されていたら合わない", () => {
    const spec = { key: ["="], mod: true };
    expect(keyMatches(spec, key({ key: "=", metaKey: true }), true)).toBe(true);
    expect(keyMatches(spec, key({ key: "=", ctrlKey: true }), true)).toBe(false);
    expect(keyMatches(spec, key({ key: "=", ctrlKey: true }), false)).toBe(true);
    expect(keyMatches(spec, key({ key: "=", metaKey: true }), false)).toBe(false);
  });

  it("repeat: false なら押しっぱなしを無視する", () => {
    expect(
      keyMatches(
        { code: ["KeyR"], shift: true, repeat: false },
        key({ code: "KeyR", shiftKey: true, repeat: true }),
        true,
      ),
    ).toBe(false);
  });
});

describe("割当表", () => {
  const run = (input: Partial<KeyInput>, mac = true, e = env()) => ({
    handled: runShortcut(key(input), e, CANVAS_SHORTCUTS, mac)?.id ?? null,
    state: e.store.getState(),
  });

  it("ツールの切替 (V F R O L T H)", () => {
    const pairs = [
      ["v", "select"],
      ["f", "frame"],
      ["r", "rect"],
      ["o", "ellipse"],
      ["l", "line"],
      ["t", "text"],
      ["h", "hand"],
    ] as const;
    for (const [k, toolId] of pairs) {
      const e = env();
      if (toolId === "select") e.store.getState().setTool("rect");
      expect(run({ key: k }, true, e).state.toolId).toBe(toolId);
    }
  });

  it("Esc は選択以外のツールから選択へ戻す。選択ツールでは処理しない", () => {
    const e = env();
    e.store.getState().setTool("rect");
    expect(run({ key: "Escape" }, true, e)).toMatchObject({
      handled: "tool.escape",
      state: { toolId: "select" },
    });
    expect(run({ key: "Escape" }, true, e).handled).toBeNull();
  });

  it("Shift+0 / Shift+1 / Shift+2 は code で見る (配列や Shift で key が変わるため)", () => {
    const e = env();
    e.store.getState().setViewport({ x: 0, y: 0, zoom: 3 });
    expect(run({ key: ")", code: "Digit0", shiftKey: true }, true, e).state.viewport.zoom).toBe(1);
    expect(run({ key: "!", code: "Digit1", shiftKey: true }, true, e).handled).toBe(
      "view.zoomToFit",
    );
    expect(e.store.getState().viewport.zoom).not.toBe(1);
    // 選択がなければ選択範囲を表示は何もしない (表示位置を変えない)
    const before = e.store.getState().viewport;
    run({ key: "@", code: "Digit2", shiftKey: true }, true, e);
    expect(e.store.getState().viewport).toBe(before);
    e.store.getState().setSelection(["r0"]);
    run({ key: "@", code: "Digit2", shiftKey: true }, true, e);
    expect(e.store.getState().viewport.zoom).toBeGreaterThan(10);
  });

  it("Cmd/Ctrl + `+` / `-` で 1 段階ずつ", () => {
    const e = env();
    run({ key: "=", metaKey: true }, true, e);
    expect(e.store.getState().viewport.zoom).toBe(2);
    run({ key: "-", ctrlKey: true }, false, e);
    expect(e.store.getState().viewport.zoom).toBe(1);
    run({ key: "+", metaKey: true, shiftKey: true }, true, e);
    expect(e.store.getState().viewport.zoom).toBe(2);
  });

  it("Shift+R、Cmd/Ctrl+'、Alt/Option+1 で表示を切り替える", () => {
    const e = env();
    run({ key: "R", code: "KeyR", shiftKey: true }, true, e);
    expect(e.store.getState().view.rulers).toBe(false);
    run({ key: "'", code: "Quote", metaKey: true }, true, e);
    expect(e.store.getState().view.grid).toBe(true);
    // JIS 配列: 「'」は Shift+7
    run({ key: "'", code: "Digit7", metaKey: true, shiftKey: true }, true, e);
    expect(e.store.getState().view.grid).toBe(false);
    // macOS の Option+1 は key が「¡」
    run({ key: "¡", code: "Digit1", altKey: true }, true, e);
    expect(e.store.getState().view.layersPanel).toBe(false);
  });

  it("アプリ全体の割当 (Cmd/Ctrl+1〜6、Cmd/Ctrl+\\、Cmd/Ctrl+B) は使わない", () => {
    for (const k of ["1", "2", "3", "4", "5", "6", "\\", "b"]) {
      const code = /\d/.test(k) ? `Digit${k}` : k === "b" ? "KeyB" : "Backslash";
      expect(run({ key: k, code, metaKey: true }, true).handled).toBeNull();
      expect(run({ key: k, code, ctrlKey: true }, false).handled).toBeNull();
    }
  });
});
