/**
 * スナップショット式の履歴 (§4.2)。文書と選択の組を積む。
 * 文書は書き換えない約束なので、スナップショットは参照を持つだけで複製しない
 * (変わらないノードや大きな画像のアセットは前後の文書で同じオブジェクトを共有する)。
 */
import type { CanvasDocument, NodeId } from "../model/types";

export const HISTORY_LIMIT = 100;

export interface Snapshot {
  doc: CanvasDocument;
  selection: readonly NodeId[];
}

export interface History {
  /** 古いものが先 */
  past: readonly Snapshot[];
  /** 次に Redo するものが先 */
  future: readonly Snapshot[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };

/** 変更の直前の状態を積む。Redo の履歴は捨てる。 */
export function pushHistory(history: History, before: Snapshot): History {
  return { past: [...history.past, before].slice(-HISTORY_LIMIT), future: [] };
}

/** 1 つ戻す。戻せなければ null。 */
export function undoHistory(
  history: History,
  present: Snapshot,
): { history: History; snapshot: Snapshot } | null {
  const snapshot = history.past[history.past.length - 1];
  if (!snapshot) return null;
  return {
    snapshot,
    history: {
      past: history.past.slice(0, -1),
      future: [present, ...history.future].slice(0, HISTORY_LIMIT),
    },
  };
}

/** 1 つ進める。進められなければ null。 */
export function redoHistory(
  history: History,
  present: Snapshot,
): { history: History; snapshot: Snapshot } | null {
  const snapshot = history.future[0];
  if (!snapshot) return null;
  return {
    snapshot,
    history: {
      past: [...history.past, present].slice(-HISTORY_LIMIT),
      future: history.future.slice(1),
    },
  };
}
