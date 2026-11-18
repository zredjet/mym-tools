/**
 * パスの点の編集 (`docs/canvas-editor-design.md` §4.13.1〜§4.13.3)。ツールバーには出さず、`startPathEdit` が
 * 切り替える。編集しているパスは store の `editingPathId`、選んでいる点は `path/editSession.ts`。
 *
 * ポインター:
 * - ハンドルの先のドラッグで曲線を変える (`mirror` の連動。Alt で `none`)
 * - 点を押すと選ぶ (Shift で足す・外す)。選んだ点のドラッグで動かす (§4.6 のスナップの候補に、同じパスの
 *   ほかの点を足す。Shift で水平・垂直)。Cmd/Ctrl を押しながらのドラッグはハンドルを引き出す
 * - 点のダブルクリックで角と滑らかを切り替える。線分のダブルクリックで点を足す。線分を押すと両端の点を選ぶ
 * - 何もない場所からのドラッグで範囲選択 (Shift で足す)。動かさずに離したら、パスの上なら点の選択を外し、
 *   パスの外なら編集を終えて、押した所のノード (なければ何も) を選ぶ
 *
 * キー (ショートカットより先に受ける。§4.4):
 * - Enter / Esc で編集を終える。Delete / Backspace で選んだ点を消す。矢印で 1 px、Shift で 10 px
 *   (ページの向き)。Cmd/Ctrl+A ですべての点を選ぶ
 * - ノードに対する編集のショートカット (コピー、切り取り、貼り付け、複製、グループ化、重なり順、反転、パスに変換、
 *   線のアウトライン化、ブーリアン) は受けて何もしない。Undo / Redo は選んでいる点を外してから store へ回す
 *
 * 操作 1 回が履歴 1 件。ドラッグは `beginGesture` / `updateGesture` / `commitGesture` を自分で開いて閉じ、
 * Esc とフォーカス喪失 (`onCancel`) で自分のジェスチャーだけを取り消す (§4.4)。形を変えたら同じ変更の中で
 * `fitPathNodes` を通し (`withSubpaths`)、§3.5 の上限を超える結果は当てない。
 */
import {
  alignedGuides,
  collectSnapTargets,
  SNAP_THRESHOLD,
  snapValue,
  type SnapGuide,
  type SnapOptions,
  type SnapTargets,
} from "../snap/snap";
import { hitTestPath, pickTarget } from "../hit/hitTest";
import { rectContainsPoint, rectFromPoints } from "../model/geometry";
import { getCoordinateFrame, getNode, getParent } from "../model/tree";
import type { CanvasDocument, NodeId, PathNode, Point } from "../model/types";
import {
  allPointRefs,
  clearSelectedPoints,
  getPathEditSnapshot,
  hasRef,
  selectedPoints,
  setPathEditHover,
  setSelectedPoints,
  syncSelectedPoints,
  type HandleSide,
  type PathEditHover,
  type PointRef,
} from "../path/editSession";
import type { EditorStore } from "../state/types";
import { resetSelectOverlay, setSelectOverlay } from "./select/overlayState";
import { constrainAxis } from "./select/move";
import { DRAG_THRESHOLD } from "./selectTool";
import type { CanvasKeyEvent, CanvasPointerEvent, Tool, ToolContext } from "./types";
import {
  deletePoints,
  hitHandle,
  hitPoint,
  hitSegment,
  insertPoint,
  movePoints,
  pageGeometry,
  pagePointOf,
  pageVectorToLocalRounded,
  pullHandles,
  segmentEnds,
  setHandle,
  toggleSmooth,
  visibleHandles,
  withSubpaths,
  type PageGeometry,
  type PagePoint,
  type PathSpace,
} from "./pathEdit/ops";
import { PathEditOverlay } from "./pathEdit/PathEditOverlay";

type Store = ToolContext["store"];

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

interface Press {
  page: Point;
  screen: Point;
  /** 押す前に選んでいた点 (取り消したら戻す) */
  selected: readonly PointRef[];
}

type Intent =
  /** 選んだ点を動かす。`grab` は吸着させる点 (線分をつかんだときは null) */
  | { kind: "points"; grab: PointRef | null }
  | { kind: "pull"; ref: PointRef }
  | { kind: "handle"; ref: PointRef; side: HandleSide }
  | { kind: "marquee"; base: readonly PointRef[] };

interface PointsDrag {
  kind: "points";
  node: PathNode;
  space: PathSpace;
  refs: readonly PointRef[];
  grab: PagePoint | null;
  targets: SnapTargets;
}

interface PullDrag {
  kind: "pull";
  node: PathNode;
  space: PathSpace;
  ref: PointRef;
  at: Point;
}

interface HandleDrag {
  kind: "handle";
  node: PathNode;
  space: PathSpace;
  ref: PointRef;
  side: HandleSide;
  at: Point;
  /** ハンドルの先と押した位置の差 (押した所からずれずに動かす) */
  offset: Point;
}

interface MarqueeDrag {
  kind: "marquee";
  base: readonly PointRef[];
  points: PagePoint[];
}

type Drag = PointsDrag | PullDrag | HandleDrag | MarqueeDrag;

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; press: Press; intent: Intent; onClick: (() => void) | null }
  | { kind: "drag"; press: Press; drag: Drag }
  /** 押したが何もしない。`press` があれば、取り消したときに点の選択を押す前に戻す */
  | { kind: "inert"; press: Press | null };

let phase: Phase = { kind: "idle" };
/** 今のドラッグが開いたジェスチャーが開いているか (ほかが開いたジェスチャーは閉じない) */
let ownsGesture = false;

/** テスト用: 状態を捨てる。 */
export function resetPathEditTool(): void {
  phase = { kind: "idle" };
  ownsGesture = false;
  resetSelectOverlay();
}

/** テスト用: 今の状態の種類。 */
export function pathEditToolPhase(): Phase["kind"] {
  return phase.kind;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function snapOptions(state: EditorStore): SnapOptions {
  return {
    threshold: SNAP_THRESHOLD / state.viewport.zoom,
    gridSize: state.view.snapToGrid ? state.view.gridSize : null,
  };
}

function editing(state: EditorStore): { id: NodeId; geometry: PageGeometry } | null {
  const id = state.editingPathId;
  if (id === null) return null;
  const geometry = pageGeometry(state.doc, id);
  return geometry ? { id, geometry } : null;
}

/** 形を変える。範囲を超えるなら当てない。変えたら点の選択を `refs` で覚え直す。 */
export function applyShape(
  store: Store,
  id: NodeId,
  change: (node: PathNode, doc: CanvasDocument) => CanvasDocument | null,
  refs?: readonly PointRef[],
): boolean {
  const state = store.getState();
  const node = getNode(state.doc, id);
  if (node?.type !== "path") return false;
  const next = change(node, state.doc);
  if (!next || next === state.doc) return false;
  state.apply(() => next);
  const after = store.getState();
  if (getNode(after.doc, id)?.type === "path") syncSelectedPoints(after.doc, id, refs);
  else clearSelectedPoints();
  return true;
}

function ownGestureOpen(store: Store): boolean {
  return ownsGesture && store.getState().gestureActive;
}

/** 吸着の候補: §4.6 と同じ (兄弟と座標系の frame、ガイド線) に、同じパスの動かさない点を足す。 */
function pointSnapTargets(
  state: EditorStore,
  geometry: PageGeometry,
  moving: readonly PointRef[],
): SnapTargets {
  const id = geometry.node.id;
  const parent = getParent(state.doc, id);
  const frame = getCoordinateFrame(state.doc, id);
  const targets = collectSnapTargets(state.doc, state.pageId, {
    parents: parent ? [parent] : [],
    frames: frame ? [frame.id] : [],
    exclude: new Set([id]),
  });
  for (const sub of geometry.points)
    for (const p of sub) {
      if (hasRef(moving, p.ref)) continue;
      targets.x.push({ pos: p.at.x, start: p.at.y, end: p.at.y });
      targets.y.push({ pos: p.at.y, start: p.at.x, end: p.at.x });
    }
  return targets;
}

// ---------------------------------------------------------------------------
// ホバー
// ---------------------------------------------------------------------------

function hoverAt(state: EditorStore, page: Point): PathEditHover {
  const edit = editing(state);
  if (!edit) return null;
  const zoom = state.viewport.zoom;
  const { geometry } = edit;
  const handles = visibleHandles(
    geometry.node.subpaths,
    selectedPoints(state.doc, state.editingPathId),
  );
  const handle = hitHandle(geometry, handles, page, zoom);
  if (handle) return { kind: "handle", ref: handle.ref, side: handle.side };
  const point = hitPoint(geometry, page, zoom);
  if (point) return { kind: "point", ref: point };
  const segment = hitSegment(geometry, page, zoom);
  return segment ? { kind: "segment", subpath: segment.subpath, segment: segment.segment } : null;
}

// ---------------------------------------------------------------------------
// 押したとき
// ---------------------------------------------------------------------------

function onPointerDown(event: CanvasPointerEvent, ctx: ToolContext): void {
  resetSelectOverlay();
  ownsGesture = false;
  const store = ctx.store;
  const state = store.getState();
  setPathEditHover(null);
  if (event.button !== 0) {
    phase = { kind: "inert", press: null };
    return;
  }
  const edit = editing(state);
  if (!edit) {
    state.endPathEdit();
    phase = { kind: "inert", press: null };
    return;
  }
  const { id, geometry } = edit;
  const zoom = state.viewport.zoom;
  const selected = selectedPoints(state.doc, id);
  const press: Press = { page: event.page, screen: event.screen, selected };
  const pending = (intent: Intent, onClick: (() => void) | null = null) => {
    phase = { kind: "pending", press, intent, onClick };
  };
  const select = (refs: readonly PointRef[]) => setSelectedPoints(store.getState().doc, id, refs);
  const double = event.clickCount >= 2;
  const subpaths = geometry.node.subpaths;

  // 1. ハンドルの先 (選んだ点とその前後)
  const handle = double
    ? null
    : hitHandle(geometry, visibleHandles(subpaths, selected), event.page, zoom);
  if (handle) {
    pending({ kind: "handle", ref: handle.ref, side: handle.side });
    return;
  }

  // 2. 点
  const point = hitPoint(geometry, event.page, zoom);
  if (point) {
    if (double && !event.shift) {
      // 角と滑らかの切替
      select([point]);
      applyShape(
        store,
        id,
        (node, doc) => withSubpaths(doc, id, toggleSmooth(node.subpaths, point)),
        [point],
      );
      phase = { kind: "inert", press: null };
      return;
    }
    if (event.mod && !event.shift) {
      select([point]);
      pending({ kind: "pull", ref: point });
      return;
    }
    const isSelected = hasRef(selected, point);
    if (event.shift) {
      if (isSelected)
        pending({ kind: "points", grab: point }, () =>
          select(
            selected.filter((ref) => ref.subpath !== point.subpath || ref.index !== point.index),
          ),
        );
      else {
        select([...selected, point]);
        pending({ kind: "points", grab: point });
      }
      return;
    }
    if (isSelected) pending({ kind: "points", grab: point }, () => select([point]));
    else {
      select([point]);
      pending({ kind: "points", grab: point });
    }
    return;
  }

  // 3. 線分
  const segment = hitSegment(geometry, event.page, zoom);
  if (segment) {
    if (double && !event.shift) {
      // 点を足す (曲線の形を変えずに分ける)
      const inserted = insertPoint(subpaths, segment);
      if (inserted)
        applyShape(store, id, (_node, doc) => withSubpaths(doc, id, inserted.subpaths, true), [
          inserted.ref,
        ]);
      phase = { kind: "inert", press: null };
      return;
    }
    const ends = segmentEnds(subpaths, segment);
    select(event.shift ? [...selected, ...ends] : ends);
    pending({ kind: "points", grab: null });
    return;
  }

  // 4. 何もない場所。範囲選択 (Shift なら足す)。動かさずに離したら、パスの上なら点の選択を外し、
  //    パスの外なら編集を終えて押した所のノードを選ぶ
  const hits = hitTestPath(state.doc, state.pageId, event.page, zoom, state.scopeId);
  const onPath = hits?.includes(id) ?? false;
  if (!event.shift) select([]);
  pending({ kind: "marquee", base: event.shift ? selected : [] }, () => {
    if (event.shift) return;
    if (onPath) return;
    const current = store.getState();
    const pick = pickTarget(current.doc, hits, current.scopeId, { point: event.page });
    // 選択を変えると store が点の編集を終える (§4.13.1)
    current.setSelection(pick.id === null ? [] : [pick.id]);
    if (store.getState().editingPathId === null) store.getState().setScope(pick.scopeId);
  });
}

// ---------------------------------------------------------------------------
// ドラッグ
// ---------------------------------------------------------------------------

function startDrag(intent: Intent, press: Press, store: Store): Drag | null {
  const state = store.getState();
  const edit = editing(state);
  if (!edit) return null;
  const { geometry } = edit;
  const { node, space } = geometry;
  switch (intent.kind) {
    case "points": {
      const refs = selectedPoints(state.doc, edit.id);
      if (refs.length === 0) return null;
      state.beginGesture();
      ownsGesture = true;
      return {
        kind: "points",
        node,
        space,
        refs,
        grab: intent.grab ? pagePointOf(geometry, intent.grab) : null,
        targets: pointSnapTargets(state, geometry, refs),
      };
    }
    case "pull": {
      const at = pagePointOf(geometry, intent.ref)?.at;
      if (!at) return null;
      state.beginGesture();
      ownsGesture = true;
      return { kind: "pull", node, space, ref: intent.ref, at };
    }
    case "handle": {
      const p = pagePointOf(geometry, intent.ref);
      const tip = intent.side === "in" ? p?.inTip : p?.outTip;
      if (!p || !tip) return null;
      state.beginGesture();
      ownsGesture = true;
      return {
        kind: "handle",
        node,
        space,
        ref: intent.ref,
        side: intent.side,
        at: p.at,
        offset: { x: tip.x - press.page.x, y: tip.y - press.page.y },
      };
    }
    case "marquee":
      return { kind: "marquee", base: intent.base, points: geometry.points.flat() };
  }
}

function updateDrag(drag: Drag, press: Press, event: CanvasPointerEvent, ctx: ToolContext): void {
  const store = ctx.store;
  const state = store.getState();
  switch (drag.kind) {
    case "points": {
      let delta = { x: event.page.x - press.page.x, y: event.page.y - press.page.y };
      if (event.shift) delta = constrainAxis(delta);
      let guides: SnapGuide[] = [];
      if (!event.mod && drag.grab && (delta.x !== 0 || delta.y !== 0)) {
        const axes = event.shift ? { x: delta.x !== 0, y: delta.y !== 0 } : { x: true, y: true };
        const options = snapOptions(state);
        const moved = { x: drag.grab.at.x + delta.x, y: drag.grab.at.y + delta.y };
        const dx = axes.x ? snapValue(moved.x, drag.targets.x, options) : 0;
        const dy = axes.y ? snapValue(moved.y, drag.targets.y, options) : 0;
        delta = { x: delta.x + dx, y: delta.y + dy };
        const at = { x: moved.x + dx, y: moved.y + dy, width: 0, height: 0 };
        guides = [
          ...(axes.x ? alignedGuides("x", [at.x], drag.targets.x, at) : []),
          ...(axes.y ? alignedGuides("y", [at.y], drag.targets.y, at) : []),
        ];
      }
      const subpaths = movePoints(drag.node.subpaths, drag.refs, drag.space, delta, "position");
      update(store, drag.node.id, subpaths, drag.refs);
      setSelectOverlay({ guides });
      return;
    }
    case "pull": {
      const v = { x: event.page.x - drag.at.x, y: event.page.y - drag.at.y };
      const out = pageVectorToLocalRounded(drag.space, v);
      update(store, drag.node.id, pullHandles(drag.node.subpaths, drag.ref, out), [drag.ref]);
      return;
    }
    case "handle": {
      const tip = { x: event.page.x + drag.offset.x, y: event.page.y + drag.offset.y };
      const vector = pageVectorToLocalRounded(drag.space, {
        x: tip.x - drag.at.x,
        y: tip.y - drag.at.y,
      });
      const subpaths = setHandle(drag.node.subpaths, drag.ref, drag.side, vector, event.alt);
      update(store, drag.node.id, subpaths, [drag.ref]);
      return;
    }
    case "marquee": {
      const rect = rectFromPoints(press.page, event.page);
      const inside = drag.points.filter((p) => rectContainsPoint(rect, p.at)).map((p) => p.ref);
      const id = state.editingPathId;
      if (id !== null) setSelectedPoints(state.doc, id, [...drag.base, ...inside]);
      setSelectOverlay({ marquee: rect });
      return;
    }
  }
}

/** ジェスチャーの中で形を変える。範囲を超えるなら前の結果を残す。 */
function update(
  store: Store,
  id: NodeId,
  subpaths: Parameters<typeof withSubpaths>[2],
  refs: readonly PointRef[],
): void {
  store
    .getState()
    .updateGesture((base) => withSubpaths(base, id, subpaths) ?? store.getState().doc);
  syncSelectedPoints(store.getState().doc, id, refs);
}

function onPointerMove(event: CanvasPointerEvent, ctx: ToolContext): void {
  if (event.clickCount === 0 || phase.kind === "idle") {
    if (phase.kind === "idle") setPathEditHover(hoverAt(ctx.store.getState(), event.page));
    return;
  }
  if (phase.kind === "inert") return;
  if (phase.kind === "pending") {
    const dx = event.screen.x - phase.press.screen.x;
    const dy = event.screen.y - phase.press.screen.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    const drag = startDrag(phase.intent, phase.press, ctx.store);
    if (!drag) {
      phase = { kind: "inert", press: phase.press };
      return;
    }
    phase = { kind: "drag", press: phase.press, drag };
  }
  if (phase.kind !== "drag") return;
  // Undo などで外からジェスチャーが閉じられたら、それ以上動かさない
  if (phase.drag.kind !== "marquee" && !ownGestureOpen(ctx.store)) {
    ownsGesture = false;
    phase = { kind: "inert", press: phase.press };
    resetSelectOverlay();
    return;
  }
  updateDrag(phase.drag, phase.press, event, ctx);
}

function onPointerUp(event: CanvasPointerEvent, ctx: ToolContext): void {
  const current = phase;
  phase = { kind: "idle" };
  const store = ctx.store;
  if (current.kind === "pending") current.onClick?.();
  else if (current.kind === "drag") {
    const drag = current.drag;
    if (drag.kind === "marquee") updateDrag(drag, current.press, event, ctx);
    else if (ownGestureOpen(store)) {
      updateDrag(drag, current.press, event, ctx);
      const refs = selectedPoints(store.getState().doc, drag.node.id);
      store.getState().commitGesture();
      const after = store.getState();
      if (getNode(after.doc, drag.node.id)?.type === "path")
        syncSelectedPoints(after.doc, drag.node.id, refs);
    }
  }
  ownsGesture = false;
  resetSelectOverlay();
  if (store.getState().toolId === "pathEdit")
    setPathEditHover(hoverAt(store.getState(), event.page));
}

function onCancel(ctx: ToolContext): void {
  const current = phase;
  phase = { kind: "idle" };
  resetSelectOverlay();
  setPathEditHover(null);
  const store = ctx.store;
  // 取り消すのは自分のドラッグが開いたジェスチャーだけ
  if (current.kind === "drag" && current.drag.kind !== "marquee" && ownGestureOpen(store))
    store.getState().cancelGesture();
  ownsGesture = false;
  // 押してから取り消したら、点の選択は押す前に戻す
  const press = current.kind === "idle" ? null : current.press;
  const state = store.getState();
  if (press && state.editingPathId !== null)
    setSelectedPoints(state.doc, state.editingPathId, press.selected);
}

// ---------------------------------------------------------------------------
// キー
// ---------------------------------------------------------------------------

const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** 修飾キーそのものの keydown (止めるショートカットではない)。 */
const MODIFIER_KEYS = new Set(["Shift", "Alt", "Meta", "Control"]);

/**
 * 点の編集の中で効かせないノードの編集のショートカット (§4.13.3)。コピー、切り取り、貼り付け、複製、
 * グループ化と解除、重なり順、反転 (Shift+H / V)、パスに変換 (Cmd/Ctrl+E)、線のアウトライン化
 * (Shift+Cmd/Ctrl+O)、ブーリアン (Alt+Shift+文字)。Cmd/Ctrl なしの Alt+Shift は、キーの文字に関係なくすべて止める
 * (macOS では Alt で文字が変わり、配列によってはデッドキー (`Dead`) になる。ブーリアンは `code` で判定されるため)。
 */
export function isBlockedInPathEdit(event: CanvasKeyEvent): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.mod && !event.alt && ["c", "x", "v", "d", "g", "e", "[", "]"].includes(key))
    return true;
  if (event.mod && event.shift && !event.alt && key === "o") return true;
  if (!event.mod && !event.alt && (key === "[" || key === "]")) return true;
  if (!event.mod && !event.alt && event.shift && (key === "h" || key === "v")) return true;
  return !event.mod && event.alt && event.shift && !MODIFIER_KEYS.has(key);
}

/**
 * 点の編集のキーのうち、Enter / Esc 以外 (ペンが点の編集の中で描いていないときにも使う)。
 * 受けたら true。
 */
export function pathEditKey(event: CanvasKeyEvent, store: Store): boolean {
  const state = store.getState();
  const id = state.editingPathId;
  if (id === null) return false;
  const key = event.key;
  if (event.mod && !event.alt && key.toLowerCase() === "z") {
    // Undo / Redo は選んでいる点を外してから store へ回す (§4.13.1)
    clearSelectedPoints();
    return false;
  }
  if ((key === "Delete" || key === "Backspace") && !event.mod && !event.alt) {
    if (event.repeat) return true;
    const refs = selectedPoints(state.doc, id);
    if (refs.length > 0)
      applyShape(
        store,
        id,
        (node, doc) => withSubpaths(doc, id, deletePoints(node.subpaths, refs)),
        [],
      );
    return true;
  }
  const arrow = ARROWS[key];
  if (arrow && !event.mod && !event.alt) {
    const refs = selectedPoints(state.doc, id);
    if (refs.length === 0) return true;
    const step = event.shift ? 10 : 1;
    const delta = { x: arrow.x * step, y: arrow.y * step };
    applyShape(
      store,
      id,
      (node, doc) => {
        const geometry = pageGeometry(doc, id);
        if (!geometry) return null;
        return withSubpaths(
          doc,
          id,
          movePoints(node.subpaths, refs, geometry.space, delta, "none"),
        );
      },
      refs,
    );
    return true;
  }
  if (event.mod && !event.alt && !event.shift && key.toLowerCase() === "a") {
    if (event.repeat) return true;
    const node = getNode(state.doc, id);
    if (node?.type === "path") setSelectedPoints(state.doc, id, allPointRefs(node.subpaths));
    return true;
  }
  return isBlockedInPathEdit(event);
}

function onKeyDown(event: CanvasKeyEvent, ctx: ToolContext): boolean {
  const store = ctx.store;
  if (
    (event.key === "Enter" || event.key === "Escape") &&
    !event.shift &&
    !event.alt &&
    !event.mod
  ) {
    if (event.repeat) return true;
    store.getState().endPathEdit();
    return true;
  }
  return pathEditKey(event, store);
}

export const pathEditTool: Tool = {
  id: "pathEdit",
  cursor: "default",
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  onCancel,
  Overlay: PathEditOverlay,
};

/** テスト用: 今の点の選択 (セッションのスナップショットから)。 */
export function currentPointSelection(state: EditorStore): readonly PointRef[] {
  return selectedPoints(state.doc, state.editingPathId, getPathEditSnapshot());
}
