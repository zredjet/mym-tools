/**
 * 「変換」の節の操作の一覧 (§8.13)。節 (`ConvertSection`) とショートカット (`canvas/shortcuts.ts`) が使う。
 *
 * - G: パスに変換 (`path/flatten.ts`)、ブーリアン演算の 4 つ (`model/booleanOps.ts`)
 * - I: 線のアウトライン化 (`outline/convertAction.ts` の `OUTLINE_CONVERT_ACTIONS`)
 * - J: 編集できる形に変換 (`svgconvert/convertAction.ts` の `SVG_CONVERT_ACTIONS`)
 *
 * 操作の型と約束は `convertSupport.ts`。並びは節に出す順。
 */
import {
  Spline,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { IS_MAC } from "../../canvas/input";
import { booleanCandidates, createBooleanFromNodes } from "../../model/booleanOps";
import { BOOLEAN_OP_NAMES } from "../../model/create";
import { createId } from "../../model/ids";
import { CANVAS_LIMITS } from "../../model/limits";
import {
  canBeBooleanChild,
  canHaveChildOfType,
  getAncestors,
  getNode,
  getParent,
  sameParent,
  type ParentRef,
} from "../../model/tree";
import type { BooleanOp, CanvasDocument, CanvasNode, NodeId, NodeType } from "../../model/types";
import { OUTLINE_CONVERT_ACTIONS } from "../../outline/convertAction";
import { FLATTEN_FAILURE_MESSAGES, flattenNodes } from "../../path/flatten";
import { SVG_CONVERT_ACTIONS } from "../../svgconvert/convertAction";
import { memoBySelection } from "../selection";
import {
  applyConvertChange,
  refuseConvert,
  type ConvertAction,
  type ConvertAvailability,
  type ConvertContext,
  type ConvertStore,
} from "./convertSupport";

/** ショートカットの表示。macOS は記号、ほかは文字。 */
function keyLabel(keys: { mod?: boolean; alt?: boolean; shift?: boolean; key: string }): string {
  if (IS_MAC)
    return `${keys.alt ? "⌥" : ""}${keys.shift ? "⇧" : ""}${keys.mod ? "⌘" : ""}${keys.key}`;
  return [keys.mod && "Ctrl", keys.alt && "Alt", keys.shift && "Shift", keys.key]
    .filter(Boolean)
    .join("+");
}

// ---------------------------------------------------------------------------
// 選択の形 (節の出し分け用)
// ---------------------------------------------------------------------------

interface SelectionShape {
  /** 祖先も選ばれているノードを除いた選択 (選択の順。重なり順には並べない) */
  tops: CanvasNode[];
  /** すべて同じ親か */
  sameParent: boolean;
  /** 同じ親ならその親 */
  parent: ParentRef | null;
}

/**
 * 節の出し分けに使う選択の形。文書と選択の組ごとに 1 回だけ求め、5 つの操作で使い回す
 * (パネルは文書が変わるたびに描き直すので、ドラッグ中も軽く済むように)。文書全体はたどらず
 * (`topLevelIds` の重なり順の並べ替えは要らない)、選んだノードの親と祖先だけを見る。
 */
const selectionShape = memoBySelection((doc, selection): SelectionShape => {
  const selected = new Set(selection);
  const tops: CanvasNode[] = [];
  let parent: ParentRef | null = null;
  let same = true;
  for (const id of selected) {
    const node = getNode(doc, id);
    if (!node || getAncestors(doc, id).some((ancestor) => selected.has(ancestor.id))) continue;
    tops.push(node);
    const p = getParent(doc, id);
    if (!p) same = false;
    else if (parent === null) parent = p;
    else if (!sameParent(parent, p)) same = false;
  }
  return { tops, sameParent: same, parent: same ? parent : null };
});

const FLATTENABLE: ReadonlySet<NodeType> = new Set(["rect", "ellipse", "line", "path", "boolean"]);

// ---------------------------------------------------------------------------
// パスに変換
// ---------------------------------------------------------------------------

function flattenAvailability({ doc, selection }: ConvertContext): ConvertAvailability | null {
  const { tops, sameParent: same } = selectionShape(doc, selection);
  if (tops.length === 0 || !tops.every((node) => FLATTENABLE.has(node.type))) return null;
  if (tops.length === 1 && tops[0]?.type === "path") return null;
  // 種類が合っていて親だけが違うときは、押せない理由を出す
  return same
    ? { enabled: true }
    : { enabled: false, reason: FLATTEN_FAILURE_MESSAGES.differentParents };
}

/** パスに変換する (Cmd/Ctrl+E)。当てられなければ理由を出す。 */
export function flattenSelection(store: ConvertStore): void {
  const state = store.getState();
  if (state.editingPathId !== null || state.selection.length === 0) return;
  const outcome = flattenNodes(state.doc, state.selection, createId(state.doc.nodes));
  if (!outcome.ok) {
    // 対象にならない選択 (テキストなど) とパス 1 個では黙って何もしない (ボタンも出ていない)
    if (outcome.reason !== "unsupported" && outcome.reason !== "alreadyPath")
      refuseConvert(FLATTEN_FAILURE_MESSAGES[outcome.reason]);
    return;
  }
  applyConvertChange(store, () => outcome);
}

// ---------------------------------------------------------------------------
// ブーリアン演算
// ---------------------------------------------------------------------------

export const BOOLEAN_OP_ICONS: Readonly<Record<BooleanOp, LucideIcon>> = {
  union: SquaresUnite,
  subtract: SquaresSubtract,
  intersect: SquaresIntersect,
  exclude: SquaresExclude,
};

/** ショートカットの文字 (Alt+Shift+この文字。§8.13)。 */
export const BOOLEAN_OP_KEYS: Readonly<Record<BooleanOp, string>> = {
  union: "U",
  subtract: "S",
  intersect: "I",
  exclude: "E",
};

const BOOLEAN_OPS: readonly BooleanOp[] = ["union", "subtract", "intersect", "exclude"];

const DIFFERENT_PARENTS = "ブーリアンにするには、同じ親の中で選んでください。";
const BOOLEAN_LIMITS = `ノードの数 (${CANVAS_LIMITS.maxNodes} 個) か入れ子の深さ (${CANVAS_LIMITS.maxDepth} 段) の上限を超えるため、ブーリアンにできません。`;

/** 2 個以上の、子にできる種類だけの選択か (親は問わない)。 */
function booleanableSelection(doc: CanvasDocument, selection: readonly NodeId[]): boolean {
  const { tops } = selectionShape(doc, selection);
  return tops.length >= 2 && tops.every((node) => canBeBooleanChild(node.type));
}

function booleanAvailability({ doc, selection }: ConvertContext): ConvertAvailability | null {
  if (!booleanableSelection(doc, selection)) return null;
  const { sameParent: same, parent } = selectionShape(doc, selection);
  return same && parent && canHaveChildOfType(doc, parent, "boolean")
    ? { enabled: true }
    : { enabled: false, reason: DIFFERENT_PARENTS };
}

/**
 * 選択をブーリアンにし、できたブーリアンを選ぶ (Alt+Shift+U / S / I / E)。
 * 作れない選択では何もしない。同じ親でないときと上限を超えるときは理由を出す。
 */
export function booleanSelection(store: ConvertStore, op: BooleanOp): void {
  const state = store.getState();
  if (state.editingPathId !== null) return;
  const { doc, selection } = state;
  if (!booleanableSelection(doc, selection)) return;
  if (!booleanCandidates(doc, selection)) {
    refuseConvert(DIFFERENT_PARENTS);
    return;
  }
  const id = createId(doc.nodes);
  const changed = applyConvertChange(store, (current) => {
    const next = createBooleanFromNodes(current, selection, op, id);
    return { doc: next, ids: next === current ? [] : [id] };
  });
  if (!changed) refuseConvert(BOOLEAN_LIMITS);
}

const booleanActions: ConvertAction[] = BOOLEAN_OPS.map((op) => ({
  id: `boolean.${op}`,
  label: BOOLEAN_OP_NAMES[op],
  icon: BOOLEAN_OP_ICONS[op],
  shortcut: keyLabel({ alt: true, shift: true, key: BOOLEAN_OP_KEYS[op] }),
  variant: "icon",
  availability: booleanAvailability,
  run: (store) => booleanSelection(store, op),
}));

// ---------------------------------------------------------------------------
// 一覧
// ---------------------------------------------------------------------------

/** 節に出す順の一覧。 */
export const CONVERT_ACTIONS: readonly ConvertAction[] = [
  {
    id: "flatten",
    label: "パスに変換",
    icon: Spline,
    shortcut: keyLabel({ mod: true, key: "E" }),
    availability: flattenAvailability,
    run: flattenSelection,
  },
  ...booleanActions,
  ...OUTLINE_CONVERT_ACTIONS,
  ...SVG_CONVERT_ACTIONS,
];

export interface AvailableConvertAction {
  action: ConvertAction;
  availability: ConvertAvailability;
}

/** 今の状態で節に出す操作。点の編集中は出さない (§8.7.3)。 */
export function availableConvertActions(
  context: ConvertContext & { editingPathId: NodeId | null },
  actions: readonly ConvertAction[] = CONVERT_ACTIONS,
): AvailableConvertAction[] {
  if (context.editingPathId !== null) return [];
  const result: AvailableConvertAction[] = [];
  for (const action of actions) {
    const availability = action.availability(context);
    if (availability) result.push({ action, availability });
  }
  return result;
}
