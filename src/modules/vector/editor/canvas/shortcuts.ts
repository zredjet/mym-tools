/**
 * キャンバスのショートカット (§5.4)。ここが唯一の割当表で、`CanvasView` が 1 つの keydown で引く。
 *
 * - 入力欄にフォーカスがある間と日本語入力の変換中は、`CanvasView` がここへ来る前に止める
 * - 現在のツールの `onKeyDown` が先に受け、false を返したときだけここを引く
 * - Cmd/Ctrl+1〜6、Cmd/Ctrl+\、Cmd/Ctrl+B はアプリ全体の割当 (`ui-design.md` §8.1) なので使わない
 * - 編集のショートカット (Undo、コピー、削除、矢印、グループ化、重なり順など) は
 *   「選択と変形」のセッションが「編集」の節に足す
 */
import {
  copySelection,
  cutSelection,
  deleteSelection,
  groupSelection,
  reorderSelection,
  selectAll,
  ungroupSelection,
} from "../state/commands";
import type { ToolId } from "../state/types";
import {
  duplicateWithinLimits,
  enterSelection,
  escapeSelection,
  nudgeSelection,
  pasteWithinLimits,
} from "../tools/select/actions";
import type { KeyInput } from "./input";
import { IS_MAC, isModPressed } from "./input";
import { runViewCommand, type ViewCommandEnv } from "./viewCommands";

export type ShortcutEnv = ViewCommandEnv;

export interface KeySpec {
  /** `KeyboardEvent.key` の候補 (1 文字の英字は大文字小文字を区別しない) */
  key?: readonly string[];
  /** `KeyboardEvent.code` の候補。Shift や Option で `key` が変わるキーに使う */
  code?: readonly string[];
  /** 省略は false (押していないこと)。"any" はどちらでもよい */
  mod?: boolean | "any";
  shift?: boolean | "any";
  alt?: boolean | "any";
  /** false なら押しっぱなしの繰り返しを無視する (切替の操作) */
  repeat?: boolean;
}

export interface Shortcut {
  id: string;
  keys: readonly KeySpec[];
  /** 処理しなかったら false を返す (次の候補へ回る)。何も返さなければ処理したとみなす */
  run(env: ShortcutEnv): boolean | void;
}

function modifierMatches(expected: boolean | "any" | undefined, actual: boolean): boolean {
  return expected === "any" || (expected ?? false) === actual;
}

/** キーの組み合わせが合うか。`mac` は Cmd と Ctrl のどちらを mod とするか。 */
export function keyMatches(spec: KeySpec, input: KeyInput, mac = IS_MAC): boolean {
  if (spec.repeat === false && input.repeat) return false;
  if (!modifierMatches(spec.mod, isModPressed(input, mac))) return false;
  if (!modifierMatches(spec.shift, input.shiftKey)) return false;
  if (!modifierMatches(spec.alt, input.altKey)) return false;
  // mod でない方の Ctrl (macOS) / Cmd (Windows) が押されていたら合わない
  if (mac ? input.ctrlKey : input.metaKey) return false;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const keyHit = spec.key?.some((k) => (k.length === 1 ? k.toLowerCase() : k) === key) ?? false;
  const codeHit = spec.code?.includes(input.code) ?? false;
  return keyHit || codeHit;
}

const tool = (id: string, key: string, toolId: ToolId): Shortcut => ({
  id,
  keys: [{ key: [key] }],
  run: ({ store }) => store.getState().setTool(toolId),
});

/** 割当表。上から順に調べ、最初に合って処理したものだけを実行する。 */
export const CANVAS_SHORTCUTS: Shortcut[] = [
  // ---- ツール ----
  tool("tool.select", "v", "select"),
  tool("tool.frame", "f", "frame"),
  tool("tool.rect", "r", "rect"),
  tool("tool.ellipse", "o", "ellipse"),
  tool("tool.line", "l", "line"),
  tool("tool.text", "t", "text"),
  tool("tool.hand", "h", "hand"),
  {
    // 作成ツールや手のひらのときの Esc は選択ツールへ戻る (途中の操作は CanvasView が先に取り消す)
    id: "tool.escape",
    keys: [{ key: ["Escape"] }],
    run: ({ store }) => {
      const state = store.getState();
      if (state.toolId === "select") return false;
      state.setTool("select");
    },
  },

  // ---- 表示 ----
  {
    id: "view.zoomIn",
    // JIS 配列の「;」キー (Shift で「+」) もズームインにする
    keys: [
      { key: ["+", "=", ";"], mod: true, shift: "any" },
      { code: ["NumpadAdd"], mod: true },
    ],
    run: (env) => runViewCommand("zoomIn", env),
  },
  {
    id: "view.zoomOut",
    keys: [
      { key: ["-", "_"], mod: true, shift: "any" },
      { code: ["NumpadSubtract"], mod: true },
    ],
    run: (env) => runViewCommand("zoomOut", env),
  },
  {
    id: "view.zoomTo100",
    keys: [{ code: ["Digit0"], shift: true }],
    run: (env) => runViewCommand("zoomTo100", env),
  },
  {
    id: "view.zoomToFit",
    keys: [{ code: ["Digit1"], shift: true }],
    run: (env) => runViewCommand("zoomToFit", env),
  },
  {
    id: "view.zoomToSelection",
    keys: [{ code: ["Digit2"], shift: true }],
    run: (env) => runViewCommand("zoomToSelection", env),
  },
  {
    id: "view.rulers",
    keys: [{ code: ["KeyR"], shift: true, repeat: false }],
    run: ({ store }) => {
      const state = store.getState();
      state.setView({ rulers: !state.view.rulers });
    },
  },
  {
    id: "view.grid",
    // JIS 配列の「'」は Shift+7 なので Shift はどちらでもよい
    keys: [
      { key: ["'"], mod: true, shift: "any", repeat: false },
      { code: ["Quote"], mod: true, repeat: false },
    ],
    run: ({ store }) => {
      const state = store.getState();
      state.setView({ grid: !state.view.grid });
    },
  },
  {
    id: "view.layersPanel",
    // macOS の Option+1 は key が「¡」になるので code で見る
    keys: [{ code: ["Digit1"], alt: true, repeat: false }],
    run: ({ store }) => {
      const state = store.getState();
      state.setView({ layersPanel: !state.view.layersPanel });
    },
  },

  // ---- 編集 ----
  // 文書の操作は `state/commands.ts`、範囲の確認・Enter・Esc は `tools/select/actions.ts`。
  // Cmd/Ctrl+S と Cmd/Ctrl+N は作品バーの担当なので、ここには置かない。
  // 押しっぱなしの繰り返しを受けるのは、矢印と Undo / Redo だけ (§5.4)
  {
    id: "edit.undo",
    keys: [{ key: ["z"], mod: true }],
    run: ({ store }) => store.getState().undo(),
  },
  {
    id: "edit.redo",
    keys: [{ key: ["z"], mod: true, shift: true }],
    run: ({ store }) => store.getState().redo(),
  },
  {
    id: "edit.copy",
    keys: [{ key: ["c"], mod: true, repeat: false }],
    run: ({ store }) => {
      copySelection(store);
    },
  },
  {
    id: "edit.cut",
    keys: [{ key: ["x"], mod: true, repeat: false }],
    run: ({ store }) => cutSelection(store),
  },
  {
    id: "edit.paste",
    keys: [{ key: ["v"], mod: true, repeat: false }],
    run: ({ store }) => pasteWithinLimits(store),
  },
  {
    id: "edit.duplicate",
    keys: [{ key: ["d"], mod: true, repeat: false }],
    run: ({ store }) => duplicateWithinLimits(store),
  },
  {
    id: "edit.selectAll",
    keys: [{ key: ["a"], mod: true, repeat: false }],
    run: ({ store }) => selectAll(store),
  },
  {
    id: "edit.delete",
    keys: [{ key: ["Delete", "Backspace"], repeat: false }],
    run: ({ store }) => {
      if (store.getState().selection.length === 0) return false;
      deleteSelection(store);
    },
  },
  ...(
    [
      ["ArrowLeft", -1, 0],
      ["ArrowRight", 1, 0],
      ["ArrowUp", 0, -1],
      ["ArrowDown", 0, 1],
    ] as const
  ).flatMap(([key, x, y]): Shortcut[] =>
    [1, 10].map((step) => ({
      // 矢印は 1 px、Shift と一緒なら 10 px
      id: `edit.nudge.${key}.${step}`,
      keys: [{ key: [key], shift: step === 10 }],
      run: ({ store }) => nudgeSelection(store, x * step, y * step),
    })),
  ),
  {
    id: "edit.group",
    keys: [{ key: ["g"], mod: true, repeat: false }],
    run: ({ store }) => groupSelection(store),
  },
  {
    id: "edit.ungroup",
    keys: [{ key: ["g"], mod: true, shift: true, repeat: false }],
    run: ({ store }) => ungroupSelection(store),
  },
  {
    id: "edit.bringForward",
    keys: [{ key: ["]"], mod: true, repeat: false }],
    run: ({ store }) => reorderSelection(store, "forward"),
  },
  {
    id: "edit.sendBackward",
    keys: [{ key: ["["], mod: true, repeat: false }],
    run: ({ store }) => reorderSelection(store, "backward"),
  },
  {
    id: "edit.bringToFront",
    keys: [{ key: ["]"], repeat: false }],
    run: ({ store }) => reorderSelection(store, "front"),
  },
  {
    id: "edit.sendToBack",
    keys: [{ key: ["["], repeat: false }],
    run: ({ store }) => reorderSelection(store, "back"),
  },
  {
    // テキストなら本文の編集、frame / group なら中に入る
    id: "edit.enter",
    keys: [{ key: ["Enter"], repeat: false }],
    run: ({ store }) => enterSelection(store),
  },
  {
    // 何もしていないときの Esc: 本文の編集の終了 → スコープを 1 段外へ → 選択の解除
    // (操作の途中の Esc は CanvasView が先に取り消す。ほかのツールの Esc は上の tool.escape)
    id: "edit.escape",
    keys: [{ key: ["Escape"], repeat: false }],
    run: ({ store }) => escapeSelection(store),
  },
  {
    // 上の編集のキーの押しっぱなしの繰り返しは、何もせずに受ける
    // (ブラウザのすべて選択や検索などへ回さない)
    id: "edit.ignoreRepeat",
    keys: [
      { key: ["c", "x", "v", "d", "a"], mod: true },
      { key: ["g"], mod: true, shift: "any" },
      { key: ["[", "]"], mod: "any" },
      { key: ["Delete", "Backspace"] },
    ],
    run: () => {},
  },
];

/** 合うショートカットを上から順に実行し、処理したものを返す。なければ null。 */
export function runShortcut(
  input: KeyInput,
  env: ShortcutEnv,
  shortcuts: readonly Shortcut[] = CANVAS_SHORTCUTS,
  mac = IS_MAC,
): Shortcut | null {
  for (const shortcut of shortcuts) {
    if (!shortcut.keys.some((spec) => keyMatches(spec, input, mac))) continue;
    if (shortcut.run(env) !== false) return shortcut;
  }
  return null;
}
