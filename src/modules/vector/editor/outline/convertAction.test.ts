import { afterEach, describe, expect, it } from "vitest";

import { getImportStatus, resetImportStatus } from "../assets/status";
import { runShortcut, type ShortcutEnv } from "../canvas/shortcuts";
import type { KeyInput } from "../canvas/input";
import {
  createBoolean,
  createEllipse,
  createRect,
  createStroke,
  createText,
} from "../model/create";
import type { CanvasDocument, CanvasNode } from "../model/types";
import { availableConvertActions } from "../panels/sections/convertActions";
import { convertContextOf } from "../panels/sections/convertSupport";
import { fixedWidthMeasurer } from "../render/testing";
import { createEditorStore } from "../state/store";
import { OUTLINE_CONVERT_ACTIONS, outlineAvailability, outlineSelection } from "./convertAction";
import { OUTLINE_FAILURE_MESSAGES } from "./nodes";

function docOf(children: string[], nodes: CanvasNode[]): CanvasDocument {
  return {
    pages: [{ id: "p1", name: "ページ 1", children, guides: [] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    assets: {},
  };
}

function sample(): CanvasDocument {
  return docOf(
    ["r", "e", "t", "b"],
    [
      createRect({ id: "r", stroke: createStroke("#000000", 4), fill: null }),
      createEllipse({ id: "e", x: 200 }),
      createText({ id: "t" }),
      createBoolean("union", ["c1", "c2"], { id: "b", stroke: null }),
      createRect({ id: "c1", stroke: createStroke("#000000", 2) }),
      createRect({ id: "c2", x: 50 }),
    ],
  );
}

function storeWith(selection: string[]) {
  const store = createEditorStore(sample());
  store.getState().setSelection(selection);
  return store;
}

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

afterEach(() => resetImportStatus());

describe("線のアウトライン化の操作", () => {
  it("出すのは、対象の種類だけの選択に線のあるノード (ブーリアンの子を除く) があるとき", () => {
    const at = (selection: string[]) =>
      outlineAvailability(convertContextOf(storeWith(selection).getState()));
    expect(at(["r"])).toEqual({ enabled: true });
    expect(at(["r", "e"])).toEqual({ enabled: true });
    expect(at(["e"])).toBeNull();
    expect(at(["c1"])).toBeNull();
    expect(at(["r", "t"])).toBeNull();
    expect(at([])).toBeNull();
  });

  it("「変換」の節の一覧に入っていて、点の編集中は出さない", () => {
    const state = storeWith(["r"]).getState();
    const shown = availableConvertActions({ ...convertContextOf(state), editingPathId: null });
    expect(shown.map((s) => s.action.id)).toContain("outline");
    expect(OUTLINE_CONVERT_ACTIONS[0]!.shortcut).toMatch(/O/);
    expect(
      availableConvertActions({ ...convertContextOf(state), editingPathId: "r" }).map(
        (s) => s.action.id,
      ),
    ).not.toContain("outline");
  });

  it("押すと線のあるノードに当て (履歴 1 件)、結果を選ぶ。Undo で戻る", () => {
    const store = storeWith(["r", "e"]);
    const before = store.getState().doc;
    outlineSelection(store);
    const state = store.getState();
    expect(state.doc).not.toBe(before);
    expect(state.doc.nodes["r"]?.type).toBe("path");
    expect(state.doc.nodes["e"]).toBe(before.nodes["e"]);
    expect(state.selection).toEqual(["r"]);
    state.undo();
    expect(store.getState().doc).toBe(before);
  });

  it("当てられないとき (ショートカットで線のないノードやブーリアンの子だけ) は文書を変えず、理由を出す", () => {
    for (const [id, reason] of [
      ["e", "noStroke"],
      ["c1", "booleanChild"],
    ] as const) {
      const store = storeWith([id]);
      const before = store.getState().doc;
      outlineSelection(store);
      expect(store.getState().doc).toBe(before);
      expect(getImportStatus().notice?.message).toBe(OUTLINE_FAILURE_MESSAGES[reason]);
    }
  });

  it("Shift+Cmd/Ctrl+O で当てる。押しっぱなしの繰り返しは受けて何もしない", () => {
    const store = storeWith(["r"]);
    const env: ShortcutEnv = {
      store,
      size: { width: 800, height: 600 },
      measurer: fixedWidthMeasurer(),
    };
    const repeat = runShortcut(
      key({ key: "O", shiftKey: true, metaKey: true, repeat: true }),
      env,
      undefined,
      true,
    );
    expect(repeat?.id).toBe("convert.outline.ignoreRepeat");
    expect(store.getState().doc.nodes["r"]?.type).toBe("rect");
    const hit = runShortcut(key({ key: "O", shiftKey: true, metaKey: true }), env, undefined, true);
    expect(hit?.id).toBe("convert.outline");
    expect(store.getState().doc.nodes["r"]?.type).toBe("path");
    const win = storeWith(["r"]);
    runShortcut(
      key({ key: "O", shiftKey: true, ctrlKey: true }),
      { ...env, store: win },
      undefined,
      false,
    );
    expect(win.getState().doc.nodes["r"]?.type).toBe("path");
    // 選択がなければ受けない (ほかのショートカットへ回す)
    const empty = storeWith([]);
    expect(
      runShortcut(
        key({ key: "O", shiftKey: true, metaKey: true }),
        { ...env, store: empty },
        undefined,
        true,
      ),
    ).toBeNull();
  });
});
