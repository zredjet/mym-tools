/**
 * 選択に関するキー操作 (§5.4 の「編集」の節から呼ぶ)。
 * 文書の操作は `state/commands.ts` の関数を使い、ここでは次だけを足す。
 * - 結果の座標が §3.5 の範囲を超える操作を当てない (矢印、複製、貼り付け)
 * - ロック中・非表示のノードを動かさない (矢印)
 * - Enter / Esc の段階的な動作
 * - 回転した frame の中の矢印は frame の軸に沿って動かす (§8.5.2)
 * - 反転 (Shift+H / Shift+V。§8.5.6)
 */
import type { StoreApi } from "zustand";
import { insertFragment } from "../../model/fragment";
import { coordinateMatrix, isTranslation } from "../../model/geometry";
import { canFlip, flipNodes, type FlipAxis } from "../../model/rotate";
import { duplicateNodes } from "../../model/structure";
import { mapNodes, type NodePatch } from "../../model/transform";
import { getAncestors, getNode, getParentNode, isGroupLike, topLevelIds } from "../../model/tree";
import type { CanvasDocument, CanvasNode, NodeId, PageId } from "../../model/types";
import { geometryWithinLimits } from "../../panels/limits";
import { editorClipboard, PASTE_OFFSET, type EditorClipboard } from "../../state/clipboard";
import { duplicateSelection, pasteClipboard, pasteTarget } from "../../state/commands";
import type { EditorStore } from "../../state/types";
import { isInteractive, isTopLevelFrame } from "../../hit/hitTest";
import { moveDocument, translateRounded } from "./move";

type Store = StoreApi<EditorStore>;

const NONE: readonly NodeId[] = [];
let lastTransformable: {
  doc: CanvasDocument;
  selection: readonly NodeId[];
  ids: readonly NodeId[];
} | null = null;

/**
 * 動かせる選択 (祖先も選ばれているものを除き、本人と祖先が表示中でロックされていないもの)。
 * ホバーのたびに呼ぶので、文書と選択が同じなら前の結果を返す (返した配列は書き換えない)。
 */
export function transformableIds(
  doc: CanvasDocument,
  selection: readonly NodeId[],
): readonly NodeId[] {
  if (selection.length === 0) return NONE;
  const last = lastTransformable;
  if (last && last.doc === doc && last.selection === selection) return last.ids;
  const ids = topLevelIds(doc, selection).filter((id) => isInteractive(doc, id));
  lastTransformable = { doc, selection, ids };
  return ids;
}

/**
 * 選択にノードを足す。祖先と子孫は同時に選ばないので、足すノードの祖先や子孫が選択にあれば
 * 外して入れ替える (§4.5)。足すノード同士は互いに祖先・子孫でないこと。
 * 足すノードの祖先の集合を先に作るので、選択と足すノードが数千個でも
 * (選択の数 + 足す数) × 深さ で済む。
 */
export function addToSelection(
  doc: CanvasDocument,
  selection: readonly NodeId[],
  ids: readonly NodeId[],
): NodeId[] {
  if (ids.length === 0) return [...selection];
  const adding = new Set(ids);
  // 足すノードの祖先 (選択にあれば外す)
  const ancestorsOfAdding = new Set<NodeId>();
  for (const id of adding)
    for (const ancestor of getAncestors(doc, id)) {
      if (ancestorsOfAdding.has(ancestor.id)) break; // ここから上は登録済み
      ancestorsOfAdding.add(ancestor.id);
    }
  const related = (id: NodeId) =>
    adding.has(id) ||
    ancestorsOfAdding.has(id) ||
    // 足すノードの子孫 (選択にあれば外す)
    getAncestors(doc, id).some((ancestor) => adding.has(ancestor.id));
  return [...selection.filter((id) => !related(id)), ...adding];
}

/** 矢印キー: 選択を動かす (1 px、Shift で 10 px)。動かせるものがなければ false。 */
export function nudgeSelection(store: Store, dx: number, dy: number): boolean {
  const state = store.getState();
  const ids = transformableIds(state.doc, state.selection);
  if (ids.length === 0) return false;
  state.apply((doc) => nudgeDocument(doc, state.pageId, ids, dx, dy) ?? doc);
  return true;
}

/** 平行移動で座標が変わる葉 (group とブーリアンは座標系を作らないので子。frame の子は動かさない)。 */
function movedLeaves(doc: CanvasDocument, ids: readonly NodeId[]): NodeId[] {
  const result: NodeId[] = [];
  const visit = (id: NodeId) => {
    const node = getNode(doc, id);
    if (!node) return;
    if (isGroupLike(node)) node.children.forEach(visit);
    else result.push(id);
  };
  ids.forEach(visit);
  return result;
}

/** 親の座標系で (dx, dy) 動かし、x と y の両方を整数に丸める (回転した親の中の移動。§8.5.2)。 */
function shiftRounded(node: CanvasNode, dx: number, dy: number): NodePatch | null {
  const round = (v: number) => {
    const r = Math.round(v);
    return r === 0 ? 0 : r;
  };
  switch (node.type) {
    case "group":
    case "boolean":
      return null;
    case "line":
      return {
        x1: round(node.x1 + dx),
        y1: round(node.y1 + dy),
        x2: round(node.x2 + dx),
        y2: round(node.y2 + dy),
      };
    default:
      return { x: round(node.x + dx), y: round(node.y + dy) };
  }
}

/**
 * 矢印キーの移動の結果。(dx, dy) はノードが座標を持つ座標系 (親の座標系) のずれで、回転した frame の中の
 * ノードは frame の軸に沿って動き、x と y の両方を丸める (§8.5.2)。回転していない座標系のノードは第 1 段階と
 * 同じ (`moveDocument`。動かした向きだけを丸める)。結果が §3.5 の範囲を超えるなら null。
 */
export function nudgeDocument(
  doc: CanvasDocument,
  pageId: PageId,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): CanvasDocument | null {
  const tops = topLevelIds(doc, ids);
  const rotated = tops.filter((id) => !isTranslation(coordinateMatrix(doc, id)));
  if (rotated.length === 0) return moveDocument({ doc, pageId, ids, delta: { x: dx, y: dy } });
  if (dx === 0 && dy === 0) return doc;
  const plain = tops.filter((id) => !rotated.includes(id));
  let next = plain.length > 0 ? translateRounded(doc, plain, dx, dy) : doc;
  next = mapNodes(next, movedLeaves(next, rotated), (node) => shiftRounded(node, dx, dy));
  return next === doc || geometryWithinLimits(next, tops) ? next : null;
}

/**
 * Shift+H / Shift+V: 選択を左右 (上下) に反転する (§8.5.6)。テキスト・画像・埋め込み SVG・frame を (子孫に)
 * 含む選択と、動かせるものがない選択では何もしない (false)。結果が §3.5 の範囲を超えるなら当てない。
 */
export function flipSelection(store: Store, axis: FlipAxis): boolean {
  const state = store.getState();
  const ids = transformableIds(state.doc, state.selection);
  if (ids.length === 0 || !canFlip(state.doc, ids)) return false;
  state.apply((doc) => {
    const next = flipNodes(doc, ids, axis);
    return next === doc || geometryWithinLimits(next, ids) ? next : doc;
  });
  return true;
}

/** Cmd/Ctrl+D: 範囲を超えない場合だけ複製する。 */
export function duplicateWithinLimits(store: Store): void {
  const { doc, selection } = store.getState();
  const dry = duplicateNodes(doc, selection, { x: PASTE_OFFSET, y: PASTE_OFFSET });
  if (dry.doc === doc || !geometryWithinLimits(dry.doc, dry.ids)) return;
  duplicateSelection(store);
}

/** Cmd/Ctrl+V: 範囲を超えない場合だけ貼り付ける。 */
export function pasteWithinLimits(
  store: Store,
  clipboard: EditorClipboard = editorClipboard,
): void {
  const state = store.getState();
  const content = clipboard.content;
  if (!content) return;
  const target = pasteTarget(state, clipboard);
  const offset = clipboard.pasteOffset(state.doc, target);
  if (!offset) return;
  const dry = insertFragment(state.doc, content, target, { offset });
  if (dry.doc === state.doc || !geometryWithinLimits(dry.doc, dry.ids)) return;
  pasteClipboard(store, clipboard);
}

/**
 * Enter: テキストなら本文の編集、frame / group / ブーリアンなら中に入って子を選ぶ。
 * 1 つだけ選んでいないときと、ほかのノードでは何もしない (false)。
 */
export function enterSelection(store: Store): boolean {
  const state = store.getState();
  const [id, ...rest] = state.selection;
  if (id === undefined || rest.length > 0 || !isInteractive(state.doc, id)) return false;
  const node = getNode(state.doc, id);
  if (!node) return false;
  if (node.type === "text") {
    state.startTextEdit(id);
    return true;
  }
  if (node.type !== "frame" && !isGroupLike(node)) return false;
  state.setScope(id);
  state.setSelection(
    node.children.filter((child) => {
      const childNode = getNode(state.doc, child);
      return childNode !== undefined && childNode.visible && !childNode.locked;
    }),
  );
  return true;
}

/**
 * Esc (何もしていないとき): 本文の編集の終了 → スコープを 1 段外へ (出たノードを選ぶ) → 選択の解除。
 * 何もすることがなければ false。
 */
export function escapeSelection(store: Store): boolean {
  const state = store.getState();
  if (state.editingTextId !== null) {
    state.endTextEdit();
    return true;
  }
  if (state.scopeId !== null) {
    const scope = state.scopeId;
    const parent = getParentNode(state.doc, scope);
    // ページ直下の frame の子は直接選べるので、そこまで出たらページ直下として扱う
    const next = parent && !isTopLevelFrame(state.doc, parent.id) ? parent.id : null;
    state.setScope(next);
    state.setSelection(isInteractive(state.doc, scope) ? [scope] : []);
    return true;
  }
  if (state.selection.length > 0) {
    state.setSelection([]);
    return true;
  }
  return false;
}
