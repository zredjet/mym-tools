/**
 * 選択ツールの操作中だけの補助表示 (範囲選択の矩形とスマートガイド)。
 *
 * ドラッグの間だけの値で、文書にも store の状態にも入れない (履歴や未保存の判定に関係しない)。
 * `SelectionOverlay` が `useSyncExternalStore` で購読する。
 */
import { useSyncExternalStore } from "react";
import type { Rect } from "../../model/geometry";
import type { SnapGuide } from "../../snap/snap";

export interface SelectOverlayState {
  /** 範囲選択の矩形 (ページ座標) */
  marquee: Rect | null;
  /** スマートガイド (ページ座標) */
  guides: readonly SnapGuide[];
}

const EMPTY: SelectOverlayState = { marquee: null, guides: [] };

let current: SelectOverlayState = EMPTY;
const listeners = new Set<() => void>();

export function getSelectOverlay(): SelectOverlayState {
  return current;
}

export function setSelectOverlay(patch: Partial<SelectOverlayState>): void {
  const next = { ...current, ...patch };
  if (next.marquee === current.marquee && next.guides === current.guides) return;
  if (next.marquee === null && next.guides.length === 0) {
    if (current === EMPTY) return;
    current = EMPTY;
  } else current = next;
  for (const listener of listeners) listener();
}

export function resetSelectOverlay(): void {
  setSelectOverlay(EMPTY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSelectOverlay(): SelectOverlayState {
  return useSyncExternalStore(subscribe, getSelectOverlay, getSelectOverlay);
}
