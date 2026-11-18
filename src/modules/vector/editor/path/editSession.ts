/**
 * パスの点の編集とペンのセッション (`docs/canvas-editor-design.md` §8.7.1)。
 *
 * 選んでいる点、ホバーしている点・ハンドル・線分、ペンの描きかけの状態を持つ。store には入れない
 * (文書でも履歴でもなく、未保存の判定に関係しない)。点の編集のツール (`tools/pathEditTool.ts`)、ペン
 * (`tools/penTool.ts`)、重ね描き、プロパティパネルの点の節が使う。
 *
 * パネルが読む口:
 * - `subscribePathEdit(listener)` / `getPathEditSnapshot()`: React は `usePathEditSnapshot()`
 *   (`useSyncExternalStore`)。スナップショットは変わるまで同じオブジェクト
 * - `selectedPoints(doc, editingPathId)`: 今も有効な、選んでいる点
 *
 * 選んでいる点の有効性: 選んだ時点のパスの ID と、そのパスの `subpaths` のオブジェクトを覚える。
 * 文書のパスの `subpaths` が別のオブジェクトになったら (Undo / Redo、ほかの操作で形が変わったとき) 選択は
 * 無効 (空) とみなす。点の添字は形が変わるとずれるため。自分の操作で形を変えたら `syncSelectedPoints` で
 * 覚え直す。Undo / Redo のキーでは、形が同じでも `clearSelectedPoints` で外す (§8.7.1)。
 */
import { useSyncExternalStore } from "react";
import type { StoreApi } from "zustand";
import { getNode, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, PathNode, Point, Subpath } from "../model/types";
import { editorStore } from "../state/store";
import type { EditorStore } from "../state/types";

/** 輪郭 `subpath` の `index` 番目の点。 */
export interface PointRef {
  subpath: number;
  index: number;
}

export type HandleSide = "in" | "out";

/** ホバーしているもの (重ね描きで強調する)。 */
export type PathEditHover =
  | { kind: "point"; ref: PointRef }
  | { kind: "handle"; ref: PointRef; side: HandleSide }
  | { kind: "segment"; subpath: number; segment: number }
  | null;

/**
 * ペンのまだ文書にない点 (描き始めの 1 点)。ページ座標。ハンドルは描く向きの `out` (ドラッグの向き) と
 * その反対の `in`。文書に入れるときに親の座標系へ直して丸める。
 */
export interface PenPoint {
  x: number;
  y: number;
  /** 描く向きで、次の点へ出るハンドル (ページ座標のベクトル)。null は角 */
  out: Point | null;
}

/**
 * ペンの描きかけ (§8.7.4)。
 * - `pathId` が null: 新しいパスの最初の点だけ (`origin`)。まだ文書にない
 * - `created` が "path" / "subpath": この描画で作ったパス / 輪郭。Undo で消えたら最初の点だけの状態に戻り、
 *   Redo で戻ればまたそれを続ける (`pathId` と輪郭の添字は消えても残す)
 * - `created` が null: 既にある開いた輪郭の端から続けている
 */
export interface PenDrawing {
  pathId: NodeId | null;
  /** 新しいパスを入れる親 (`pathId` が null のときに使う) */
  parent: ParentRef;
  /** 描いている輪郭の添字 (`pathId` があるとき) */
  subpath: number;
  /** 伸ばす端。"start" は先頭の前に足していく (描く向きが保存の順と逆) */
  end: "start" | "end";
  /** 描き始めの点 (まだ文書にないとき、作ったものが Undo で消えたときに使う) */
  origin: PenPoint;
  created: "path" | "subpath" | null;
  /** 続けた輪郭の、描き始めたときの点の数 (Backspace で消せるのはそれより後に足した点) */
  baseCount: number;
  /**
   * 描き始めたときのパスの輪郭の数 (点の編集の中で輪郭を足す・続けるとき)。輪郭の数がこれと合わなければ
   * (Undo で描き始めより前に戻ったなど) 添字がほかの輪郭を指しうるので、描くのを終える
   */
  subpathCount: number;
  /**
   * この描画で 1 点ずつ確定した後の文書 (古い順)。今の文書がこのどれかなら、それより後にほかの操作はないので、
   * Backspace は最後の点を消す代わりに Undo で取り消す (作ったパスの 2 点目なら作成ごと取り消す、§8.7.4)
   */
  commits: readonly CanvasDocument[];
  /** 点の編集の中から描き始めたか (終えたら点の編集に戻る) */
  fromEdit: boolean;
  /** 予定の線のためのポインターの位置 (ページ座標)。キャンバスの外なら null */
  pointer: Point | null;
}

export interface PathEditSnapshot {
  /** 選んでいる点が属するパス */
  pathId: NodeId | null;
  /** 選んだ時点のパスの `subpaths` (文書のものと違えば選択は無効) */
  subpaths: readonly Subpath[] | null;
  selected: readonly PointRef[];
  hover: PathEditHover;
  pen: PenDrawing | null;
}

const NO_POINTS: readonly PointRef[] = [];

const EMPTY: PathEditSnapshot = {
  pathId: null,
  subpaths: null,
  selected: NO_POINTS,
  hover: null,
  pen: null,
};

let current: PathEditSnapshot = EMPTY;
const listeners = new Set<() => void>();

function update(patch: Partial<PathEditSnapshot>): void {
  const next = { ...current, ...patch };
  const keys = Object.keys(next) as (keyof PathEditSnapshot)[];
  if (keys.every((key) => next[key] === current[key])) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getPathEditSnapshot(): PathEditSnapshot {
  return current;
}

export function subscribePathEdit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePathEditSnapshot(): PathEditSnapshot {
  return useSyncExternalStore(subscribePathEdit, getPathEditSnapshot, getPathEditSnapshot);
}

// ツールがペンから変わったら描きかけを捨てる。キャンバスが画面から外れていてペンの `onCancel` が呼ばれない
// とき (画面を離れた後の `load` など) にも、古い描きかけが残らないように
editorStore.subscribe((state, previous) => {
  if (previous.toolId === "pen" && state.toolId !== "pen" && current.pen) update({ pen: null });
});

/** テスト用: すべて捨てる。 */
export function resetPathEditSession(): void {
  if (current === EMPTY) return;
  current = EMPTY;
  for (const listener of listeners) listener();
}

/**
 * パスの点の編集に入る (§8.7.2。選択ツールのダブルクリックと Enter から呼ぶ)。前の編集で選んでいた点と
 * ペンの描きかけを捨ててから、store の `startPathEdit` を呼ぶ。パスでなければ何もしない。
 */
export function beginPathEdit(store: StoreApi<EditorStore>, id: NodeId): boolean {
  const state = store.getState();
  if (getNode(state.doc, id)?.type !== "path") return false;
  update({ pathId: null, subpaths: null, selected: NO_POINTS, hover: null, pen: null });
  state.startPathEdit(id);
  return store.getState().editingPathId === id;
}

// ---------------------------------------------------------------------------
// 点の参照
// ---------------------------------------------------------------------------

export function sameRef(a: PointRef, b: PointRef): boolean {
  return a.subpath === b.subpath && a.index === b.index;
}

export function hasRef(refs: readonly PointRef[], ref: PointRef): boolean {
  return refs.some((other) => sameRef(other, ref));
}

/** 輪郭と添字の順に並べ、重複と範囲の外を落とす。 */
export function normalizeRefs(subpaths: readonly Subpath[], refs: readonly PointRef[]): PointRef[] {
  const seen = new Set<string>();
  const result: PointRef[] = [];
  for (const ref of refs) {
    const sub = subpaths[ref.subpath];
    if (!sub || !Number.isInteger(ref.index) || ref.index < 0 || ref.index >= sub.points.length)
      continue;
    const key = `${ref.subpath}:${ref.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ subpath: ref.subpath, index: ref.index });
  }
  return result.sort((a, b) => a.subpath - b.subpath || a.index - b.index);
}

/** パスのすべての点。 */
export function allPointRefs(subpaths: readonly Subpath[]): PointRef[] {
  const refs: PointRef[] = [];
  subpaths.forEach((sub, subpath) => {
    sub.points.forEach((_, index) => refs.push({ subpath, index }));
  });
  return refs;
}

function editingPath(doc: CanvasDocument, pathId: NodeId | null): PathNode | null {
  if (pathId === null) return null;
  const node = getNode(doc, pathId);
  return node?.type === "path" ? node : null;
}

// ---------------------------------------------------------------------------
// 選んでいる点
// ---------------------------------------------------------------------------

/**
 * 今も有効な、選んでいる点。点を編集中のパス (`editingPathId`) が選んだ時点と同じで、形 (`subpaths`) が
 * 変わっていないときだけ返す。それ以外は空。
 */
export function selectedPoints(
  doc: CanvasDocument,
  editingPathId: NodeId | null,
  snapshot: PathEditSnapshot = current,
): readonly PointRef[] {
  if (editingPathId === null || snapshot.pathId !== editingPathId) return NO_POINTS;
  const node = editingPath(doc, editingPathId);
  if (!node || node.subpaths !== snapshot.subpaths) return NO_POINTS;
  return snapshot.selected;
}

/** 選ぶ点を決める (`pathId` のパスの今の形に対して)。 */
export function setSelectedPoints(
  doc: CanvasDocument,
  pathId: NodeId,
  refs: readonly PointRef[],
): void {
  const node = editingPath(doc, pathId);
  if (!node) {
    clearSelectedPoints();
    return;
  }
  const selected = normalizeRefs(node.subpaths, refs);
  const same =
    current.pathId === pathId &&
    current.subpaths === node.subpaths &&
    selected.length === current.selected.length &&
    selected.every((ref, i) => sameRef(ref, current.selected[i] as PointRef));
  if (same) return;
  update({
    pathId,
    subpaths: node.subpaths,
    selected: selected.length === 0 ? NO_POINTS : selected,
  });
}

/**
 * 自分の操作で形を変えた後に、同じ添字の点を選んだまま覚え直す (`refs` を渡せば選び直す)。
 * 点の数が変わったら、範囲の外の点は落とす。
 */
export function syncSelectedPoints(
  doc: CanvasDocument,
  pathId: NodeId,
  refs: readonly PointRef[] = current.pathId === pathId ? current.selected : NO_POINTS,
): void {
  setSelectedPoints(doc, pathId, refs);
}

export function clearSelectedPoints(): void {
  if (current.selected.length === 0 && current.pathId === null && current.subpaths === null) return;
  update({ pathId: null, subpaths: null, selected: NO_POINTS });
}

// ---------------------------------------------------------------------------
// ホバーとペン
// ---------------------------------------------------------------------------

function sameHover(a: PathEditHover, b: PathEditHover): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "point":
      return sameRef(a.ref, (b as typeof a).ref);
    case "handle":
      return sameRef(a.ref, (b as typeof a).ref) && a.side === (b as typeof a).side;
    case "segment":
      return a.subpath === (b as typeof a).subpath && a.segment === (b as typeof a).segment;
  }
}

export function setPathEditHover(hover: PathEditHover): void {
  if (sameHover(hover, current.hover)) return;
  update({ hover });
}

export function setPenDrawing(pen: PenDrawing | null): void {
  update({ pen });
}

/** ペンの描きかけを部分的に変える (描いていなければ何もしない)。 */
export function patchPenDrawing(patch: Partial<PenDrawing>): void {
  const pen = current.pen;
  if (!pen) return;
  const keys = Object.keys(patch) as (keyof PenDrawing)[];
  if (keys.every((key) => patch[key] === pen[key])) return;
  update({ pen: { ...pen, ...patch } });
}
