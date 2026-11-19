/**
 * 選択ツールの操作中だけの補助表示 (範囲選択の矩形、スマートガイド、回転の角度)。
 *
 * ドラッグの間だけの値で、文書にも store の状態にも入れない (履歴や未保存の判定に関係しない)。
 * `SelectionOverlay` が `useSyncExternalStore` で購読する。
 */
import { useSyncExternalStore } from "react";
import type { Rect } from "../../model/geometry";
import type { Point } from "../../model/types";
import type { SnapGuide } from "../../snap/snap";

export interface SelectOverlayState {
  /** 範囲選択の矩形 (ページ座標) */
  marquee: Rect | null;
  /** スマートガイド (ページ座標) */
  guides: readonly SnapGuide[];
  /**
   * 回転のドラッグの角度 (§4.11.3)。`value` は表示する角度 (度)、`at` はポインターの位置 (ページ座標)。
   * 画面座標の重ね描き (`SelectionScreenLabels`) が、ポインターの近くに数値で出す
   */
  angle: { value: number; at: Point } | null;
}

const EMPTY: SelectOverlayState = { marquee: null, guides: [], angle: null };

let current: SelectOverlayState = EMPTY;
const listeners = new Set<() => void>();

export function getSelectOverlay(): SelectOverlayState {
  return current;
}

export function setSelectOverlay(patch: Partial<SelectOverlayState>): void {
  const next = { ...current, ...patch };
  if (
    next.marquee === current.marquee &&
    next.guides === current.guides &&
    next.angle === current.angle
  )
    return;
  if (next.marquee === null && next.guides.length === 0 && next.angle === null) {
    if (current === EMPTY) return;
    current = EMPTY;
  } else current = next;
  for (const listener of listeners) listener();
}

/** 回転の角度の表示 (例: `30°`、`-12.5°`)。小数第 2 位まで。 */
export function formatAngle(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded === 0 ? 0 : rounded}°`;
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
