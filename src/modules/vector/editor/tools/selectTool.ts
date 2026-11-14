/**
 * 選択ツール (§4.4〜§4.6)。クリックでの選択、範囲選択、移動、リサイズ、線の端点、ガイド線の移動。
 *
 * 押してから `DRAG_THRESHOLD` 画面 px 動くまではクリックとして扱い、動かないクリックは文書を変えない
 * (履歴も revision も増えない)。しきい値を越えたらドラッグを始める。文書を変えるドラッグは
 * `beginGesture` / `updateGesture` / `commitGesture` で 1 件の履歴にし、Esc とフォーカス喪失
 * (`onCancel`) で取り消す。取り消すのは自分のドラッグが開いたジェスチャーだけ (§4.4)。
 * 押してから取り消したら、選択とスコープは押す前に戻す (§4.5)。
 *
 * 計算はページ座標で行う。ドラッグの途中でホイールやピンチにより表示位置が変わると、キャンバスが
 * 今のポインター位置で `onPointerMove` を呼ぶので、そのまま追従する。
 *
 * 状態はモジュールの変数に持つ (ツールは 1 つだけで、同時に追うポインターも 1 本だけ)。
 */
import { canEnter, hitFrameLabel, hitTestPath, isInteractive, pickTarget } from "../hit/hitTest";
import {
  guideAt,
  guideCursor,
  handleAt,
  handleCursor,
  lineEndAt,
  LINE_END_CURSOR,
  type LineEnd,
  type ResizeHandle,
} from "../hit/handles";
import {
  dropFrames,
  dropTargetAt,
  marqueeCandidates,
  marqueeSelect,
  type DropFrame,
  type MarqueeCandidate,
} from "../hit/marquee";
import {
  getSelectionBounds,
  nodeOrigin,
  rectContainsPoint,
  rectFromPoints,
  type Rect,
} from "../model/geometry";
import { duplicateNodes } from "../model/structure";
import { resizeNodes, updateNode } from "../model/transform";
import { getNode, getPage, getParent, isAncestorOf, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, Point } from "../model/types";
import { geometryWithinLimits } from "../panels/limits";
import type { EditorStore } from "../state/types";
import {
  alignedGuides,
  collectSnapTargets,
  EMPTY_SNAP_TARGETS,
  rectGuides,
  SNAP_THRESHOLD,
  snapMove,
  type SnapGuide,
  type SnapOptions,
  type SnapTargets,
} from "../snap/snap";
import { fitTextNodes } from "../text/fit";
import { addToSelection, transformableIds } from "./select/actions";
import {
  beginMoveGuide,
  endGuideDrag,
  isOverRuler,
  updateGuideDrag,
  type GuideDrag,
} from "./select/guideDrag";
import { constrainAxis, coordinateFrameId, moveDocument } from "./select/move";
import { resetSelectOverlay, setSelectOverlay } from "./select/overlayState";
import { grabOffset, moveLineEnd, resizeRect } from "./select/resize";
import type { CanvasPointerEvent, Tool, ToolContext } from "./types";

/** クリックとドラッグを分ける距離 (画面 px)。押してからこれ以上動いたらドラッグ。 */
export const DRAG_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

interface Press {
  page: Point;
  screen: Point;
  /** 押す前の選択とスコープ (取り消したら戻す) */
  selection: readonly NodeId[];
  scopeId: NodeId | null;
}

/**
 * 移動でつかんだもの。
 * - `node`: ノードの上。ポインターの下の frame が今の親と違えば付け替える
 * - `space`: frame のラベルや選択の中の何もない場所。押した点の下と違う frame に入ったときだけ付け替える
 */
type Grab = "node" | "space";

/** しきい値を越えたときに始めるドラッグ。 */
type DragIntent =
  | { kind: "move"; grab: Grab }
  | { kind: "resize"; handle: ResizeHandle }
  | { kind: "lineEnd"; id: NodeId; end: LineEnd }
  | { kind: "marquee"; scopeId: NodeId | null; base: readonly NodeId[] }
  | { kind: "guide"; index: number };

interface MoveDrag {
  kind: "move";
  /** 動かす前の文書 (Alt で複製したときは複製した後) */
  doc: CanvasDocument;
  ids: readonly NodeId[];
  /** Alt で複製したノード。最初の更新で選択し直す */
  duplicated: boolean;
  start: Rect;
  frames: DropFrame[];
  grab: Grab;
  /** 押した点の下の frame (null はページ直下)。`grab` が `space` のときの基準 */
  startTarget: NodeId | null;
  /** 動かすノードの座標系の frame がすべて同じならその ID (ページ直下は null)、ばらばらなら undefined */
  ownFrame: NodeId | null | undefined;
  snapCache: Map<string, SnapTargets>;
}

interface ResizeDrag {
  kind: "resize";
  handle: ResizeHandle;
  ids: readonly NodeId[];
  start: Rect;
  offset: Point;
  /** 画像と埋め込み SVG だけなら、既定で縦横比を固定する */
  lockAspect: boolean;
  hasText: boolean;
  targets: SnapTargets;
}

interface LineEndDrag {
  kind: "lineEnd";
  id: NodeId;
  end: LineEnd;
  origin: Point;
  from: Point;
  other: Point;
  offset: Point;
  targets: SnapTargets;
}

interface MarqueeDrag {
  kind: "marquee";
  candidates: MarqueeCandidate[];
  base: readonly NodeId[];
}

interface GuideDragState {
  kind: "guide";
  drag: GuideDrag;
  /** ガイド線の位置と押した位置の差 (押した所からずれずに動かす) */
  offset: number;
}

type Drag = MoveDrag | ResizeDrag | LineEndDrag | MarqueeDrag | GuideDragState;

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; press: Press; intent: DragIntent; onClick: (() => void) | null }
  | { kind: "drag"; press: Press; drag: Drag }
  /** 押したが何もしない (ドラッグしても何も起こさない) */
  | { kind: "inert" };

let phase: Phase = { kind: "idle" };
let lastCursor: string | null = null;
/** 今のドラッグが開いたジェスチャーが開いているか (ほかが開いたジェスチャーは閉じない) */
let ownsGesture = false;

/** テスト用: 状態を捨てる。 */
export function resetSelectTool(): void {
  phase = { kind: "idle" };
  lastCursor = null;
  ownsGesture = false;
  resetSelectOverlay();
}

/** テスト用: 今の状態の種類。 */
export function selectToolPhase(): Phase["kind"] {
  return phase.kind;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

type Store = ToolContext["store"];

function setCursor(ctx: ToolContext, cursor: string | null): void {
  if (cursor === lastCursor) return;
  lastCursor = cursor;
  ctx.setCursor(cursor);
}

function snapOptions(state: EditorStore): SnapOptions {
  return {
    threshold: SNAP_THRESHOLD / state.viewport.zoom,
    gridSize: state.view.snapToGrid ? state.view.gridSize : null,
  };
}

function isSingleLine(doc: CanvasDocument, ids: readonly NodeId[]): boolean {
  return ids.length === 1 && getNode(doc, ids[0] as NodeId)?.type === "line";
}

/** ハンドルを出す選択 (本文の編集中のノードを含むなら出さない)。 */
function handleTargets(state: EditorStore): readonly NodeId[] {
  const ids = transformableIds(state.doc, state.selection);
  if (state.editingTextId !== null && ids.includes(state.editingTextId)) return [];
  return ids;
}

/** 点の下のハンドル (線の端点を含む)。 */
function hitHandle(
  state: EditorStore,
  point: Point,
): { kind: "resize"; handle: ResizeHandle } | { kind: "lineEnd"; id: NodeId; end: LineEnd } | null {
  const ids = handleTargets(state);
  if (ids.length === 0) return null;
  const zoom = state.viewport.zoom;
  if (isSingleLine(state.doc, ids)) {
    const id = ids[0] as NodeId;
    const line = getNode(state.doc, id);
    if (line?.type !== "line") return null;
    const origin = nodeOrigin(state.doc, id);
    const end = lineEndAt(
      { x: origin.x + line.x1, y: origin.y + line.y1 },
      { x: origin.x + line.x2, y: origin.y + line.y2 },
      point,
      zoom,
    );
    return end ? { kind: "lineEnd", id, end } : null;
  }
  const bounds = getSelectionBounds(state.doc, ids);
  const handle = bounds ? handleAt(bounds, point, zoom) : null;
  return handle ? { kind: "resize", handle } : null;
}

function hitGuide(state: EditorStore, point: Point): number | null {
  const guides = getPage(state.doc, state.pageId)?.guides ?? [];
  return guides.length === 0 ? null : guideAt(guides, point, state.viewport.zoom);
}

/** ホバーとクリックで選ぶノード (frame のラベルを含む)。スコープは変えない。 */
function pickAt(
  state: EditorStore,
  point: Point,
  deep: boolean,
  measurer: ToolContext["measurer"],
) {
  const label = hitFrameLabel(state.doc, state.pageId, point, state.viewport.zoom, measurer);
  if (label !== null) return { id: label, scopeId: null, label: true };
  const path = hitTestPath(state.doc, state.pageId, point, state.viewport.zoom);
  return { ...pickTarget(state.doc, path, state.scopeId, { deep, point }), label: false };
}

function sameIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Shift のクリック: 選択済みなら外し、そうでなければ足す (祖先・子孫は入れ替える)。 */
function toggleInSelection(store: Store, id: NodeId): void {
  const state = store.getState();
  state.setSelection(
    state.selection.includes(id)
      ? state.selection.filter((other) => other !== id)
      : addToSelection(state.doc, state.selection, [id]),
  );
}

// ---------------------------------------------------------------------------
// ホバー
// ---------------------------------------------------------------------------

function updateHover(event: CanvasPointerEvent, ctx: ToolContext): void {
  const state = ctx.store.getState();
  const handle = hitHandle(state, event.page);
  if (handle) {
    setCursor(ctx, handle.kind === "resize" ? handleCursor(handle.handle) : LINE_END_CURSOR);
    state.setHovered(null);
    return;
  }
  const guide = hitGuide(state, event.page);
  if (guide !== null) {
    const axis = getPage(state.doc, state.pageId)?.guides[guide]?.axis ?? "x";
    setCursor(ctx, guideCursor(axis));
    state.setHovered(null);
    return;
  }
  setCursor(ctx, null);
  state.setHovered(pickAt(state, event.page, event.mod, ctx.measurer).id);
}

// ---------------------------------------------------------------------------
// 押したとき
// ---------------------------------------------------------------------------

function onPointerDown(event: CanvasPointerEvent, ctx: ToolContext): void {
  resetSelectOverlay();
  ownsGesture = false;
  if (event.button !== 0) {
    phase = { kind: "inert" };
    return;
  }
  const store = ctx.store;
  const state = store.getState();
  state.setHovered(null);
  const press: Press = {
    page: event.page,
    screen: event.screen,
    selection: state.selection,
    scopeId: state.scopeId,
  };
  const pending = (intent: DragIntent, onClick: (() => void) | null = null) => {
    phase = { kind: "pending", press, intent, onClick };
  };

  // ダブルクリックはハンドルとガイド線より中のノードを優先する
  // (group の辺に重なる線をダブルクリックしても中に入れるように)
  const double = event.clickCount >= 2;

  // 1. ハンドル (線の端点)。動かさずに離したら、下にあるものをクリックしたことにする
  const handle = double ? null : hitHandle(state, event.page);
  if (handle) {
    pending(handle, () => clickThrough(event, ctx));
    return;
  }

  // 2. ガイド線。動かさずに離したら、下にあるものをクリックしたことにする
  const guide = double ? null : hitGuide(state, event.page);
  if (guide !== null) {
    pending({ kind: "guide", index: guide }, () => clickThrough(event, ctx));
    return;
  }

  const selection = state.selection;
  const selected = new Set(selection);

  // 3. ページ直下の frame の名前のラベル
  const label = hitFrameLabel(
    state.doc,
    state.pageId,
    event.page,
    state.viewport.zoom,
    ctx.measurer,
  );
  if (label !== null) {
    state.setScope(null);
    if (event.shift) {
      if (selected.has(label))
        pending({ kind: "move", grab: "space" }, () => toggleInSelection(store, label));
      else {
        toggleInSelection(store, label);
        pending({ kind: "move", grab: "space" });
      }
    } else if (selected.has(label))
      pending({ kind: "move", grab: "space" }, () => store.getState().setSelection([label]));
    else {
      state.setSelection([label]);
      pending({ kind: "move", grab: "space" });
    }
    return;
  }

  // 4. ノード
  const point = event.page;
  const path = hitTestPath(state.doc, state.pageId, point, state.viewport.zoom);
  const pick = pickTarget(state.doc, path, state.scopeId, {
    deep: event.mod,
    selection: selected,
    point,
  });
  const plainPick = () =>
    pickTarget(store.getState().doc, path, store.getState().scopeId, { deep: event.mod, point }).id;

  if (pick.id !== null) {
    if (pick.scopeId !== state.scopeId) state.setScope(pick.scopeId);
    const id = pick.id;

    if (double && !event.shift) {
      const node = getNode(state.doc, id);
      if (node?.type === "text") {
        store.getState().startTextEdit(id);
        phase = { kind: "inert" };
        return;
      }
      if (canEnter(state.doc, id)) {
        store.getState().setScope(id);
        const inner = pickTarget(state.doc, path, id, { point }).id;
        store.getState().setSelection(inner === null ? [] : [inner]);
        if (inner === null) phase = { kind: "inert" };
        else pending({ kind: "move", grab: "node" });
        return;
      }
    }

    if (event.shift) {
      shiftPress(store, path, id, plainPick(), pending);
      return;
    }
    if (selected.has(id)) {
      // 選んだままドラッグできる。動かさずに離したら、押した位置で選び直す
      pending({ kind: "move", grab: "node" }, () => {
        const plain = plainPick();
        store.getState().setSelection(plain === null ? [] : [plain]);
      });
    } else {
      state.setSelection([id]);
      pending({ kind: "move", grab: "node" });
    }
    return;
  }

  // 5. 何もない場所。選択の外接矩形の中なら選択を動かす (クリックだけなら選択を解除する)。
  //    このときスコープは変えない
  const movable = transformableIds(state.doc, selection);
  const bounds = movable.length > 0 ? getSelectionBounds(state.doc, movable) : null;
  if (!event.shift && bounds && rectContainsPoint(bounds, point)) {
    pending({ kind: "move", grab: "space" }, () => store.getState().setSelection([]));
    return;
  }
  if (pick.scopeId !== state.scopeId) state.setScope(pick.scopeId);
  // 範囲選択。Shift なら今の選択に足す
  if (!event.shift) state.setSelection([]);
  pending({ kind: "marquee", scopeId: pick.scopeId, base: event.shift ? selection : [] });
}

/**
 * Shift を押してノードを押したとき (§4.5)。足すのは、ふつうのクリックで当たるノード。
 * - 押した所の選択済みのノードが、ふつうのクリックで当たるノードの祖先なら、それを足して祖先と入れ替える
 *   (frame を選んだまま、その子を Shift+クリック)
 * - 選択済みの group / frame そのものに当たるときは、その中の押した所の子を足して入れ替える
 * - 選択済みの葉は、動かさずに離したときに外す (ドラッグなら選択ごと動かす)
 * - 選ばれていなければ足す (祖先・子孫は入れ替える)
 */
function shiftPress(
  store: Store,
  path: readonly NodeId[] | null,
  picked: NodeId,
  plain: NodeId | null,
  pending: (intent: DragIntent, onClick?: (() => void) | null) => void,
): void {
  const state = store.getState();
  const add = (id: NodeId) => {
    state.setSelection(addToSelection(state.doc, state.selection, [id]));
    pending({ kind: "move", grab: "node" });
  };
  if (!state.selection.includes(picked)) {
    add(picked);
    return;
  }
  if (plain !== null && plain !== picked && isAncestorOf(state.doc, picked, plain)) {
    add(plain);
    return;
  }
  const index = path ? path.indexOf(picked) : -1;
  const inner = index >= 0 ? path?.[index + 1] : undefined;
  if (plain === picked && inner !== undefined && isInteractive(state.doc, inner)) {
    add(inner);
    return;
  }
  pending({ kind: "move", grab: "node" }, () => toggleInSelection(store, picked));
}

/**
 * ハンドルやガイド線を動かさずにクリックしたとき。その下のノード (なければ何もない場所) を
 * クリックしたのと同じに選ぶ (選択済みのものは優先しない)。
 */
function clickThrough(event: CanvasPointerEvent, ctx: ToolContext): void {
  const state = ctx.store.getState();
  const picked = pickAt(state, event.page, event.mod, ctx.measurer);
  if (picked.scopeId !== state.scopeId) state.setScope(picked.scopeId);
  const id = picked.id;
  if (event.shift) {
    if (id !== null) toggleInSelection(ctx.store, id);
    return;
  }
  ctx.store.getState().setSelection(id === null ? [] : [id]);
}

// ---------------------------------------------------------------------------
// ドラッグの開始
// ---------------------------------------------------------------------------

function startDrag(
  intent: DragIntent,
  start: Press,
  event: CanvasPointerEvent,
  ctx: ToolContext,
): Drag | null {
  const store = ctx.store;
  const state = store.getState();
  switch (intent.kind) {
    case "move":
      return startMove(state, event.alt, start.page, intent.grab);
    case "resize": {
      const ids = handleTargets(state);
      const bounds = getSelectionBounds(state.doc, ids);
      if (!bounds) return null;
      state.beginGesture();
      ownsGesture = true;
      const nodes = ids.map((id) => getNode(state.doc, id));
      return {
        kind: "resize",
        handle: intent.handle,
        ids,
        start: bounds,
        offset: grabOffset(bounds, intent.handle, start.page),
        lockAspect: nodes.every((node) => node?.type === "image" || node?.type === "svg"),
        hasText: ids.some((id) => containsText(state.doc, id)),
        targets: ownSnapTargets(state, ids),
      };
    }
    case "lineEnd": {
      const line = getNode(state.doc, intent.id);
      if (line?.type !== "line") return null;
      state.beginGesture();
      ownsGesture = true;
      const origin = nodeOrigin(state.doc, intent.id);
      const p1 = { x: origin.x + line.x1, y: origin.y + line.y1 };
      const p2 = { x: origin.x + line.x2, y: origin.y + line.y2 };
      const from = intent.end === "start" ? p1 : p2;
      return {
        kind: "lineEnd",
        id: intent.id,
        end: intent.end,
        origin,
        from,
        other: intent.end === "start" ? p2 : p1,
        offset: { x: from.x - start.page.x, y: from.y - start.page.y },
        targets: ownSnapTargets(state, [intent.id]),
      };
    }
    case "marquee":
      return {
        kind: "marquee",
        candidates: marqueeCandidates(state.doc, state.pageId, intent.scopeId),
        base: intent.base,
      };
    case "guide": {
      const guide = getPage(state.doc, state.pageId)?.guides[intent.index];
      const drag = guide ? beginMoveGuide(store, intent.index) : null;
      if (!drag || !guide) return null;
      ownsGesture = true;
      const pressed = guide.axis === "x" ? start.page.x : start.page.y;
      return { kind: "guide", drag, offset: guide.position - pressed };
    }
  }
}

function containsText(doc: CanvasDocument, id: NodeId): boolean {
  const node = getNode(doc, id);
  if (!node) return false;
  if (node.type === "text") return true;
  return (
    (node.type === "group" || node.type === "frame") &&
    node.children.some((c) => containsText(doc, c))
  );
}

/** 動かすノードの兄弟と座標系の frame から集めたスナップの候補。 */
function ownSnapTargets(state: EditorStore, ids: readonly NodeId[], doc = state.doc): SnapTargets {
  const parents = ids.map((id) => getParent(doc, id)).filter((p): p is ParentRef => p !== null);
  const frames = ids.map((id) => coordinateFrameId(doc, id)).filter((f): f is NodeId => f !== null);
  return collectSnapTargets(doc, state.pageId, { parents, frames, exclude: new Set(ids) });
}

function startMove(state: EditorStore, alt: boolean, pressed: Point, grab: Grab): MoveDrag | null {
  let ids = transformableIds(state.doc, state.selection);
  if (ids.length === 0) return null;
  let doc = state.doc;
  let duplicated = false;
  // Alt: 開始時に 1 回だけ複製し、ドラッグの間は同じ複製を動かす (§4.10)。
  // 複製できない (ノード数の上限など) ときは、元を動かさずに何もしない (§4.6)
  if (alt) {
    const result = duplicateNodes(doc, ids);
    if (result.doc === doc || !geometryWithinLimits(result.doc, result.ids)) return null;
    doc = result.doc;
    ids = result.ids;
    duplicated = true;
  }
  const start = getSelectionBounds(doc, ids);
  if (!start) return null;
  state.beginGesture();
  ownsGesture = true;
  const frames = dropFrames(doc, state.pageId, new Set(ids));
  const ownFrames = ids.map((id) => coordinateFrameId(doc, id));
  const snapCache = new Map<string, SnapTargets>();
  snapCache.set("own", ownSnapTargets(state, ids, doc));
  return {
    kind: "move",
    doc,
    ids,
    duplicated,
    start,
    frames,
    grab,
    startTarget: dropTargetAt(frames, pressed),
    ownFrame: ownFrames.every((frame) => frame === ownFrames[0])
      ? (ownFrames[0] ?? null)
      : undefined,
    snapCache,
  };
}

/**
 * 移動の付け替え先 (§4.6)。undefined は親を変えない。
 * ノードをつかんだときは、ポインターの下の最も前面の frame (なければページ直下)。
 * ラベルや選択の中の何もない場所をつかんだときは、押した点の下と違う frame に入ったときだけ。
 */
function moveDropTarget(drag: MoveDrag, pointer: Point): NodeId | null | undefined {
  const under = dropTargetAt(drag.frames, pointer);
  if (drag.grab === "space" && under === drag.startTarget) return undefined;
  return under;
}

/**
 * スナップの候補。親を変えないときは動かすノードの兄弟と座標系の frame、
 * 変えるときはドロップ先の子と frame。
 */
function moveSnapTargets(
  state: EditorStore,
  drag: MoveDrag,
  target: NodeId | null | undefined,
): SnapTargets {
  if (target === undefined || (drag.ownFrame !== undefined && drag.ownFrame === target))
    return drag.snapCache.get("own") ?? EMPTY_SNAP_TARGETS;
  const key = `t:${target ?? ""}`;
  let targets = drag.snapCache.get(key);
  if (!targets) {
    const parent: ParentRef =
      target === null ? { kind: "page", id: state.pageId } : { kind: "node", id: target };
    targets = collectSnapTargets(drag.doc, state.pageId, {
      parents: [parent],
      frames: target === null ? [] : [target],
      exclude: new Set(drag.ids),
    });
    drag.snapCache.set(key, targets);
  }
  return targets;
}

// ---------------------------------------------------------------------------
// ドラッグの途中
// ---------------------------------------------------------------------------

function updateDrag(drag: Drag, start: Press, event: CanvasPointerEvent, ctx: ToolContext): void {
  const store = ctx.store;
  const state = store.getState();
  switch (drag.kind) {
    case "move": {
      let raw = { x: event.page.x - start.page.x, y: event.page.y - start.page.y };
      if (event.shift) raw = constrainAxis(raw);
      const axes = event.shift ? { x: raw.x !== 0, y: raw.y !== 0 } : { x: true, y: true };
      const target = moveDropTarget(drag, event.page);
      // 押した位置へ戻したら吸着もしない (文書を変えない)
      const snapping = !event.mod && (raw.x !== 0 || raw.y !== 0);
      const targets = snapping ? moveSnapTargets(state, drag, target) : null;
      let delta = raw;
      if (targets) {
        const moved = { ...drag.start, x: drag.start.x + raw.x, y: drag.start.y + raw.y };
        const snap = snapMove(moved, targets, snapOptions(state), axes);
        delta = { x: raw.x + snap.dx, y: raw.y + snap.dy };
      }
      const next = moveDocument({
        doc: drag.doc,
        pageId: state.pageId,
        ids: drag.ids,
        delta,
        dropTarget: target,
      });
      if (next) {
        state.updateGesture(() => next);
        if (drag.duplicated && !sameIds(store.getState().selection, drag.ids))
          store.getState().setSelection(drag.ids);
      }
      const bounds = targets ? getSelectionBounds(store.getState().doc, drag.ids) : null;
      setSelectOverlay({ guides: bounds && targets ? rectGuides(bounds, targets, axes) : [] });
      return;
    }
    case "resize": {
      const pointer = { x: event.page.x + drag.offset.x, y: event.page.y + drag.offset.y };
      const snap = event.mod ? null : { targets: drag.targets, options: snapOptions(state) };
      const rect = resizeRect({
        start: drag.start,
        handle: drag.handle,
        pointer,
        keepAspect: drag.lockAspect ? !event.shift : event.shift,
        fromCenter: event.alt,
        snap,
      });
      const ids = drag.ids;
      const measurer = ctx.measurer;
      const start = drag.start;
      const recipe = (doc: CanvasDocument) => {
        let next = resizeNodes(doc, ids, start, rect, { round: true });
        if (drag.hasText) next = fitTextNodes(next, ids, measurer);
        return next === doc || geometryWithinLimits(next, ids) ? next : null;
      };
      // 範囲を超えるなら当てない (前の結果を残す)
      state.updateGesture((doc) => recipe(doc) ?? store.getState().doc);
      setSelectOverlay({
        guides: snap ? resizeGuides(store.getState().doc, drag, snap.targets) : [],
      });
      return;
    }
    case "lineEnd": {
      const pointer = { x: event.page.x + drag.offset.x, y: event.page.y + drag.offset.y };
      const snap = event.mod ? null : { targets: drag.targets, options: snapOptions(state) };
      const [moved, opposite] = moveLineEnd({
        from: drag.from,
        other: drag.other,
        pointer,
        constrain: event.shift,
        fromCenter: event.alt,
        snap,
      });
      const local = (p: Point) => ({
        x: Math.round(p.x - drag.origin.x) || 0,
        y: Math.round(p.y - drag.origin.y) || 0,
      });
      const a = local(moved);
      const b = local(opposite);
      const patch =
        drag.end === "start"
          ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
          : { x2: a.x, y2: a.y, x1: b.x, y1: b.y };
      state.updateGesture((doc) => {
        const next = updateNode(doc, drag.id, patch);
        return geometryWithinLimits(next, [drag.id]) ? next : store.getState().doc;
      });
      const point = { x: a.x + drag.origin.x, y: a.y + drag.origin.y, width: 0, height: 0 };
      setSelectOverlay({
        guides:
          snap && !event.shift
            ? [
                ...alignedGuides("x", [point.x], drag.targets.x, point),
                ...alignedGuides("y", [point.y], drag.targets.y, point),
              ]
            : [],
      });
      return;
    }
    case "marquee": {
      const rect = rectFromPoints(start.page, event.page);
      const hits = marqueeSelect(drag.candidates, rect);
      state.setSelection(
        drag.base.length === 0 ? hits : addToSelection(state.doc, drag.base, hits),
      );
      setSelectOverlay({ marquee: rect });
      return;
    }
    case "guide":
      updateGuideDrag(
        store,
        drag.drag,
        guidePointer(drag, event),
        isOverRuler(drag.drag.axis, event.screen, state.view.rulers),
      );
      return;
  }
}

/** ガイド線を動かす先 (押した位置との差を保つ)。 */
function guidePointer(drag: GuideDragState, event: CanvasPointerEvent): Point {
  return { x: event.page.x + drag.offset, y: event.page.y + drag.offset };
}

/** リサイズで動いた辺にそろった線。 */
function resizeGuides(doc: CanvasDocument, drag: ResizeDrag, targets: SnapTargets): SnapGuide[] {
  const bounds = getSelectionBounds(doc, drag.ids);
  if (!bounds) return [];
  const s = drag.start;
  const xs = [
    ...(bounds.x !== s.x ? [bounds.x] : []),
    ...(bounds.x + bounds.width !== s.x + s.width ? [bounds.x + bounds.width] : []),
  ];
  const ys = [
    ...(bounds.y !== s.y ? [bounds.y] : []),
    ...(bounds.y + bounds.height !== s.y + s.height ? [bounds.y + bounds.height] : []),
  ];
  return [
    ...alignedGuides("x", xs, targets.x, bounds),
    ...alignedGuides("y", ys, targets.y, bounds),
  ];
}

/** 自分のドラッグが開いたジェスチャーが、まだ開いているか。 */
function ownGestureOpen(store: Store): boolean {
  return ownsGesture && store.getState().gestureActive;
}

function onPointerMove(event: CanvasPointerEvent, ctx: ToolContext): void {
  if (event.clickCount === 0 || phase.kind === "idle") {
    if (phase.kind === "idle") updateHover(event, ctx);
    return;
  }
  if (phase.kind === "inert") return;
  if (phase.kind === "pending") {
    const dx = event.screen.x - phase.press.screen.x;
    const dy = event.screen.y - phase.press.screen.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    const drag = startDrag(phase.intent, phase.press, event, ctx);
    if (!drag) {
      phase = { kind: "inert" };
      return;
    }
    phase = { kind: "drag", press: phase.press, drag };
  }
  if (phase.kind !== "drag") return;
  // Undo などで外からジェスチャーが閉じられたら、それ以上動かさない
  if (phase.drag.kind !== "marquee" && !ownGestureOpen(ctx.store)) {
    ownsGesture = false;
    phase = { kind: "inert" };
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
      if (drag.kind === "guide")
        endGuideDrag(
          store,
          drag.drag,
          guidePointer(drag, event),
          isOverRuler(drag.drag.axis, event.screen, store.getState().view.rulers),
        );
      else {
        updateDrag(drag, current.press, event, ctx);
        store.getState().commitGesture();
      }
    }
  }
  ownsGesture = false;
  resetSelectOverlay();
  updateHover(event, ctx);
}

function onCancel(ctx: ToolContext): void {
  const current = phase;
  phase = { kind: "idle" };
  resetSelectOverlay();
  lastCursor = null;
  const store = ctx.store;
  store.getState().setHovered(null);
  // 取り消すのは自分のドラッグが開いたジェスチャーだけ (本文の編集や色の選択のジェスチャーは残す)
  if (current.kind === "drag" && current.drag.kind !== "marquee" && ownGestureOpen(store))
    store.getState().cancelGesture();
  ownsGesture = false;
  // 押してから取り消したら、選択とスコープは押す前に戻す
  if (current.kind === "pending" || current.kind === "drag") {
    const { selection, scopeId } = current.press;
    store.getState().setScope(scopeId);
    store.getState().setSelection(selection);
  }
}

export const selectTool: Tool = {
  id: "select",
  cursor: "default",
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onCancel,
};
