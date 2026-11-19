/**
 * 右クリックのメニューの項目 (§5.8)。どの項目もショートカット・パネルのボタンと同じ関数を呼ぶ
 * (履歴 1 件、断る理由の知らせも同じ)。開いた時点の状態で、当てられない項目を使えない表示にする。
 *
 * 並びと区切りは Figma にならう:
 * - 選択があるとき: 編集 (切り取り・コピー・貼り付け・複製・削除) / 重なり順 (最前面へ・前面へ・背面へ・最背面へ) /
 *   構造 (グループ化・グループ解除・パスに変換・線のアウトライン化・編集できる形に変換) /
 *   ブーリアン (合体・型抜き・交差・中マド) / 反転 (左右・上下)
 * - 何もない所: 貼り付け、すべて選択
 *
 * 変換の項目は「変換」の節の登録口 `CONVERT_ACTIONS` から作る。パスに変換と線のアウトライン化は常に出し
 * (当てられなければ使えない表示にして、ショートカットと同じ理由を title に出す)、そのほかの変換 (編集できる形に
 * 変換など) は節に出るときだけ出す。
 *
 * 使えるかは開くたびに軽く求める (ノード 8,000 個を選んでも数 ms)。文書を丸ごと作り直す試し (貼り付け・複製・
 * グループ化・削除の結果) はしない: 削除・複製は選んだノードがあれば、貼り付けはクリップボードに中身があれば、
 * グループ化は入れ先が group を子にできるか (`groupPlacement`)、解除は group かブーリアンを含むか、重なり順は
 * 選んでいない兄弟が前面・背面にあるか (`reorderAvailability`) で決める。
 * 上限を超えるかは実行の関数が確かめ直し、超えれば何もしない (ショートカットと同じ)。
 */
import type { StoreApi } from "zustand";

import { deleteKeyLabel, shortcutLabel } from "../canvas/shortcutLabel";
import { groupPlacement, reorderAvailability, type ReorderDirection } from "../model/structure";
import { getNode, isGroupLike } from "../model/tree";
import type { CanvasDocument, NodeId } from "../model/types";
import { OUTLINE_FAILURE_MESSAGES, outlineTargets } from "../outline/nodes";
import { FLATTEN_FAILURE_MESSAGES, flattenTargets } from "../path/flatten";
import {
  BOOLEAN_CONVERT_ACTIONS,
  BOOLEAN_NEEDS_SELECTION,
  BOOLEAN_OPS,
  CONVERT_ACTIONS,
} from "../panels/sections/convertActions";
import { convertContextOf, type ConvertAction } from "../panels/sections/convertSupport";
import { editorClipboard, type EditorClipboard } from "../state/clipboard";
import {
  copySelection,
  cutSelection,
  deleteSelection,
  groupSelection,
  reorderSelection,
  selectableInScope,
  selectAll,
  ungroupSelection,
} from "../state/commands";
import type { EditorStore } from "../state/types";
import {
  canFlipSelection,
  duplicateWithinLimits,
  flipSelection,
  pasteWithinLimits,
} from "../tools/select/actions";
import type { MenuEntry, MenuItem } from "./MenuList";

type Store = StoreApi<EditorStore>;

/**
 * 変換の項目のうち、当てられなくても出すものと、そのときの理由 (パスに変換と線のアウトライン化はショートカットが
 * 出すのと同じ文、ブーリアンはツールバーのボタンと同じ文)。ほかの変換は節に出るときだけ出す。
 */
const ALWAYS_SHOWN_CONVERT: ReadonlyMap<
  string,
  (doc: CanvasDocument, selection: readonly NodeId[]) => string | undefined
> = new Map([
  [
    "flatten",
    (doc: CanvasDocument, selection: readonly NodeId[]) => {
      const targets = flattenTargets(doc, selection);
      return targets.ok ? undefined : FLATTEN_FAILURE_MESSAGES[targets.reason];
    },
  ],
  ...BOOLEAN_OPS.map(
    (op) => [BOOLEAN_CONVERT_ACTIONS[op].id, () => BOOLEAN_NEEDS_SELECTION] as const,
  ),
  [
    "outline",
    (doc: CanvasDocument, selection: readonly NodeId[]) => {
      const targets = outlineTargets(doc, selection);
      return targets.ok ? undefined : OUTLINE_FAILURE_MESSAGES[targets.reason];
    },
  ],
]);

function item(
  id: string,
  label: string,
  shortcut: string | undefined,
  enabled: boolean,
  run: () => void,
  title?: string,
): MenuItem {
  return { type: "item", id, label, shortcut, disabled: !enabled, title, run };
}

const separator = (id: string): MenuEntry => ({ type: "separator", id });

/** 変換の操作を項目にする。出さないなら null。 */
function convertItem(store: Store, action: ConvertAction): MenuItem | null {
  const state = store.getState();
  const availability = action.availability(convertContextOf(state));
  const whyNot = ALWAYS_SHOWN_CONVERT.get(action.id);
  if (availability === null && !whyNot) return null;
  const enabled = availability?.enabled === true;
  const reason =
    availability === null
      ? whyNot?.(state.doc, state.selection)
      : availability.enabled
        ? undefined
        : availability.reason;
  return item(
    `convert.${action.id}`,
    action.label,
    action.shortcut,
    enabled,
    () => action.run(store),
    reason,
  );
}

/** 重なり順の項目。4 つ目は、前面へ動かすもの (true) か背面へ動かすもの (false) か。 */
const REORDER: readonly [ReorderDirection, string, string, boolean][] = [
  ["front", "最前面へ", shortcutLabel({ key: "]" }), true],
  ["forward", "前面へ", shortcutLabel({ mod: true, key: "]" }), true],
  ["backward", "背面へ", shortcutLabel({ mod: true, key: "[" }), false],
  ["back", "最背面へ", shortcutLabel({ key: "[" }), false],
];

/** 選択があるときのメニュー。 */
function selectionEntries(store: Store, clipboard: EditorClipboard): MenuEntry[] {
  const state = store.getState();
  const { doc, selection } = state;
  const hasNodes = selection.some((id) => getNode(doc, id) !== undefined);
  const canPaste = clipboard.hasContent();
  const order = reorderAvailability(doc, selection);
  const entries: MenuEntry[] = [
    item("cut", "切り取り", shortcutLabel({ mod: true, key: "X" }), hasNodes, () =>
      cutSelection(store, clipboard),
    ),
    item("copy", "コピー", shortcutLabel({ mod: true, key: "C" }), hasNodes, () => {
      copySelection(store, clipboard);
    }),
    item("paste", "貼り付け", shortcutLabel({ mod: true, key: "V" }), canPaste, () =>
      pasteWithinLimits(store, clipboard),
    ),
    item("duplicate", "複製", shortcutLabel({ mod: true, key: "D" }), hasNodes, () =>
      duplicateWithinLimits(store),
    ),
    item("delete", "削除", deleteKeyLabel(), hasNodes, () => deleteSelection(store)),
    separator("sep.order"),
    ...REORDER.map(([direction, label, shortcut, toFront]) =>
      item(`order.${direction}`, label, shortcut, toFront ? order.toFront : order.toBack, () =>
        reorderSelection(store, direction),
      ),
    ),
    separator("sep.structure"),
    item(
      "group",
      "グループ化",
      shortcutLabel({ mod: true, key: "G" }),
      groupPlacement(doc, selection) !== null,
      () => groupSelection(store),
    ),
    item(
      "ungroup",
      "グループ解除",
      shortcutLabel({ mod: true, shift: true, key: "G" }),
      selection.some((id) => {
        const node = getNode(doc, id);
        return node !== undefined && isGroupLike(node);
      }),
      () => ungroupSelection(store),
    ),
  ];

  const booleanIds = new Set(BOOLEAN_OPS.map((op) => BOOLEAN_CONVERT_ACTIONS[op].id));
  for (const action of CONVERT_ACTIONS) {
    if (booleanIds.has(action.id)) continue;
    const converted = convertItem(store, action);
    if (converted) entries.push(converted);
  }

  entries.push(separator("sep.boolean"));
  for (const op of BOOLEAN_OPS) {
    const converted = convertItem(store, BOOLEAN_CONVERT_ACTIONS[op]);
    if (converted) entries.push(converted);
  }

  const flippable = canFlipSelection(state);
  entries.push(
    separator("sep.flip"),
    item("flip.horizontal", "左右反転", shortcutLabel({ shift: true, key: "H" }), flippable, () => {
      flipSelection(store, "horizontal");
    }),
    item("flip.vertical", "上下反転", shortcutLabel({ shift: true, key: "V" }), flippable, () => {
      flipSelection(store, "vertical");
    }),
  );
  return entries;
}

/** 何もない所のメニュー。 */
function emptyEntries(store: Store, clipboard: EditorClipboard): MenuEntry[] {
  const state = store.getState();
  return [
    item("paste", "貼り付け", shortcutLabel({ mod: true, key: "V" }), clipboard.hasContent(), () =>
      pasteWithinLimits(store, clipboard),
    ),
    item(
      "selectAll",
      "すべて選択",
      shortcutLabel({ mod: true, key: "A" }),
      selectableInScope(state).length > 0,
      () => selectAll(store),
    ),
  ];
}

/**
 * 今の状態のメニューの項目。選択があれば選択のメニュー、なければ何もない所のメニュー。
 * 点の編集中など、メニューを出さない状態かは呼ぶ側 (`canOpenContextMenu`) で確かめる。
 */
export function contextMenuEntries(
  store: Store,
  clipboard: EditorClipboard = editorClipboard,
): MenuEntry[] {
  return store.getState().selection.length > 0
    ? selectionEntries(store, clipboard)
    : emptyEntries(store, clipboard);
}
