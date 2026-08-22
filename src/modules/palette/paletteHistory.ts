import type { HarmonyRule, PaletteColors, PaletteIndex } from "@/lib/types";

export interface PaletteSnapshot {
  colors: PaletteColors;
  harmony: HarmonyRule;
  baseIndex: PaletteIndex;
  locked: [boolean, boolean, boolean, boolean, boolean];
}

export interface PaletteHistory {
  past: PaletteSnapshot[];
  present: PaletteSnapshot;
  future: PaletteSnapshot[];
}

export function createHistory(present: PaletteSnapshot): PaletteHistory {
  return { past: [], present, future: [] };
}

export function commitHistory(history: PaletteHistory, next: PaletteSnapshot): PaletteHistory {
  if (snapshotKey(history.present) === snapshotKey(next)) return history;
  return {
    past: [...history.past.slice(-99), history.present],
    present: next,
    future: [],
  };
}

export function undoHistory(history: PaletteHistory): PaletteHistory {
  const previous = history.past[history.past.length - 1];
  if (previous == null) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, 100),
  };
}

export function redoHistory(history: PaletteHistory): PaletteHistory {
  const next = history.future[0];
  if (next == null) return history;
  return {
    past: [...history.past.slice(-99), history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function snapshotKey(snapshot: PaletteSnapshot): string {
  return JSON.stringify(snapshot);
}
