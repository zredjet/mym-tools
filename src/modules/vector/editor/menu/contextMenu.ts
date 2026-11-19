/**
 * 右クリックのメニュー (§5.8) の開閉と、右クリックで選ぶもの。
 *
 * - キャンバス (`canvas/useCanvasInput.ts` の `contextmenu`) とレイヤーパネルの行 (`panels/LayersPanel.tsx`) が
 *   `openContextMenu` を呼び、`ContextMenu.tsx` の `ContextMenuHost` (エディタの中に 1 つ) が出す
 * - 出さないとき (`canOpenContextMenu`): 点の編集中、ペンで描いている間、本文の編集中、ポインターのドラッグの途中
 * - 項目は開いた時点の状態で決める (`contextMenuItems.ts`)
 */
import { useSyncExternalStore } from "react";
import type { StoreApi } from "zustand";

import { isPointerDragActive } from "../canvas/pointerDrag";
import { hitFrameLabel, hitTestPath, pickTarget } from "../hit/hitTest";
import type { Point } from "../model/types";
import { getPathEditSnapshot } from "../path/editSession";
import type { TextMeasurer } from "../render/types";
import type { EditorStore } from "../state/types";
import { transformableIds } from "../tools/select/actions";
import { selectionBoxContains, selectionBoxOf } from "../tools/select/selectionBox";
import { contextMenuEntries } from "./contextMenuItems";
import type { MenuEntry } from "./MenuList";

type Store = StoreApi<EditorStore>;

// ---------------------------------------------------------------------------
// 開閉の状態
// ---------------------------------------------------------------------------

export interface ContextMenuRequest {
  /** 押した位置 (クライアント座標) */
  clientX: number;
  clientY: number;
  entries: readonly MenuEntry[];
  /** 何もない所のメニューか (読み上げの名前を変える) */
  empty: boolean;
  /** 開くたびに増える (同じ位置で開き直しても作り直す) */
  key: number;
}

let current: ContextMenuRequest | null = null;
let nextKey = 1;
const listeners = new Set<() => void>();

function emit(next: ContextMenuRequest | null) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getContextMenu(): ContextMenuRequest | null {
  return current;
}

export function subscribeContextMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useContextMenu(): ContextMenuRequest | null {
  return useSyncExternalStore(subscribeContextMenu, getContextMenu, getContextMenu);
}

export function closeContextMenu(): void {
  emit(null);
}

/** 開いているか。 */
export function isContextMenuOpen(): boolean {
  return current !== null;
}

// ---------------------------------------------------------------------------
// 出すか、何を選ぶか
// ---------------------------------------------------------------------------

/**
 * 今メニューを出してよいか。点の編集中、ペンで描いている間、本文の編集中、ポインターのドラッグの途中
 * (ルーラーからガイド線を引き出している間を含む) は出さない。
 */
export function canOpenContextMenu(
  state: Pick<EditorStore, "editingPathId" | "editingTextId" | "toolId">,
): boolean {
  if (state.editingPathId !== null || state.editingTextId !== null) return false;
  if (state.toolId === "pen" && getPathEditSnapshot().pen !== null) return false;
  return !isPointerDragActive();
}

/**
 * キャンバスの右クリックで先に選ぶ (§5.8)。当たりはクリックと同じ規則 (スコープ、非表示とロック、frame の
 * ラベル、`deep` は Cmd/Ctrl) で、Shift なしのクリックと同じものを選ぶ。
 * - 選んでいるノード (選択の外接矩形の中の何もない所を含む) の上なら、選択を変えない
 * - 選んでいないノードの上なら、それだけを選ぶ (スコープもクリックと同じく変える)
 * - 何もない所なら選択を外す
 */
export function selectForContextMenu(
  store: Store,
  point: Point,
  deep: boolean,
  measurer: TextMeasurer,
): void {
  const state = store.getState();
  const selected = new Set(state.selection);
  const label = hitFrameLabel(state.doc, state.pageId, point, state.viewport.zoom, measurer);
  if (label !== null) {
    if (selected.has(label)) return;
    state.setScope(null);
    store.getState().setSelection([label]);
    return;
  }
  const path = hitTestPath(state.doc, state.pageId, point, state.viewport.zoom, state.scopeId);
  const pick = pickTarget(state.doc, path, state.scopeId, { deep, selection: selected, point });
  if (pick.id !== null) {
    if (selected.has(pick.id)) return;
    if (pick.scopeId !== state.scopeId) state.setScope(pick.scopeId);
    store.getState().setSelection([pick.id]);
    return;
  }
  const movable = transformableIds(state.doc, state.selection);
  const box = movable.length > 0 ? selectionBoxOf(state.doc, movable) : null;
  if (box && selectionBoxContains(box, point)) return;
  if (pick.scopeId !== state.scopeId) state.setScope(pick.scopeId);
  store.getState().setSelection([]);
}

/** 今の選択でメニューを開く (選ぶのは呼ぶ側が先に済ませる)。 */
export function openContextMenu(store: Store, client: { clientX: number; clientY: number }): void {
  const empty = store.getState().selection.length === 0;
  emit({
    clientX: client.clientX,
    clientY: client.clientY,
    entries: contextMenuEntries(store),
    empty,
    key: nextKey++,
  });
}

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------

export interface Box {
  width: number;
  height: number;
}

/** 画面の端からあける間 (px)。 */
export const MENU_MARGIN = 4;

/**
 * メニューの左上 (`bounds` の中の座標)。押した位置の右下に開き、右にはみ出すなら押した位置の左へ、
 * 下にはみ出すなら上へ開く。どちらにも収まらなければ、端から `MENU_MARGIN` あけて収まる範囲で
 * 押した位置に近い所 (右端・下端にそろえる) へ寄せる。`bounds` より大きければ左端・上端にそろえる。
 */
export function placeMenu(point: Point, menu: Box, bounds: Box, margin = MENU_MARGIN): Point {
  const axis = (at: number, size: number, limit: number) => {
    if (at + size <= limit - margin) return Math.max(at, margin);
    if (at - size >= margin) return at - size;
    return Math.max(margin, limit - margin - size);
  };
  return {
    x: axis(point.x, menu.width, bounds.width),
    y: axis(point.y, menu.height, bounds.height),
  };
}
