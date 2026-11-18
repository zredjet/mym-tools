/**
 * ペン (P、`docs/canvas-editor-design.md` §8.7.4)。
 *
 * - クリックで角の点、ドラッグで滑らかな点 (ドラッグの向きと長さが描く向きの `out`、反対が `in`、
 *   `angle-length`) を足す。Shift で、前の点から見て 45° 刻みに固定する (ページの向き。ドラッグのハンドルも)
 * - 描き始めの点をクリックすると輪郭を閉じて終える。最後の点のクリック、Enter と Esc で開いたまま終える。
 *   描いている間の Backspace は最後の点を消す
 * - 何も編集していないときは新しいパスを作る。親は作成ツールと同じ決め方 (`creationParent`。ブーリアンの
 *   スコープではブーリアンの外)。パスは 2 点目を置いたときに作るので、点を 1 個しか置かずに終えたパスは残らない
 * - 点の編集の中 (`editingPathId` を残したままペンに切り替えたとき) は、同じパスに輪郭を足す。開いた輪郭の端の点から
 *   始めるとその輪郭を続け、線分をクリックすると点を足す。終えたら点の編集 (`pathEdit`) に戻る
 * - 描き終えたら、選択ツールに戻って作ったパスを選ぶ (§4.4)
 * - 最後の点からポインターまでの予定の線を重ね描きする (`PathEditOverlay`)
 *
 * 履歴: 2 点目からの 1 点が履歴 1 件 (押してから離すまでのジェスチャー。ドラッグでハンドルを決める)。
 * Undo で消えた点は描きかけから外れ、作ったパスが消えたら最初の点だけの状態に戻る。最初の点だけのときの
 * Cmd/Ctrl+Z は、その点を取り消す (文書の Undo には回さない)。
 */
import { createPath } from "../model/create";
import { createId } from "../model/ids";
import { insertNode } from "../model/structure";
import { getNode, getParent, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, Point } from "../model/types";
import {
  clearSelectedPoints,
  getPathEditSnapshot,
  patchPenDrawing,
  sameRef,
  setPathEditHover,
  setPenDrawing,
  setSelectedPoints,
  type PathEditHover,
  type PenDrawing,
} from "../path/editSession";
import { creationParent, scopeForParent } from "./create/parent";
import { applyShape, isBlockedInPathEdit, pathEditKey } from "./pathEditTool";
import {
  hitPoint,
  hitSegment,
  insertPoint,
  pageGeometry,
  pagePointOf,
  POINT_HIT_RADIUS,
  withSubpaths,
} from "./pathEdit/ops";
import { PathEditOverlay } from "./pathEdit/PathEditOverlay";
import {
  constrainPoint45,
  constrainVector45,
  endIndex,
  penAddPoint,
  penClose,
  penRemoveLast,
  penSecondPoint,
  resolvePen,
  startIndex,
  type PenTarget,
} from "./pathEdit/pen";
import { resetSelectOverlay } from "./select/overlayState";
import { DRAG_THRESHOLD } from "./selectTool";
import type { CanvasKeyEvent, CanvasPointerEvent, Tool, ToolContext } from "./types";

type Store = ToolContext["store"];

/** 押してから離すまで。 */
type Press =
  /** 最初の点を置いた (まだ文書にない)。ドラッグでハンドルを決める */
  | { kind: "pending"; screen: Point; at: Point }
  /** 点を足した / 輪郭を閉じた (ジェスチャーの中)。ドラッグでハンドルを決める */
  | {
      kind: "add" | "close";
      screen: Point;
      at: Point;
      recipe: (base: CanvasDocument, out: Point | null) => CanvasDocument | null;
    }
  /** 何もしない */
  | { kind: "none" };

let press: Press | null = null;
let dragging = false;
/** 今の押下が開いたジェスチャーが開いているか (ほかが開いたジェスチャーは閉じない) */
let ownsGesture = false;

/** テスト用: 状態を捨てる。 */
export function resetPenTool(): void {
  press = null;
  dragging = false;
  ownsGesture = false;
}

function ownGestureOpen(store: Store): boolean {
  return ownsGesture && store.getState().gestureActive;
}

/** 今の描きかけと、それが指す所。描きかけが今の文書で続けられなければ片付ける。 */
function currentDrawing(store: Store): { pen: PenDrawing; target: PenTarget } | null {
  const pen = getPathEditSnapshot().pen;
  if (!pen) return null;
  const target = resolvePen(store.getState().doc, pen);
  if (!target) {
    setPenDrawing(null);
    return null;
  }
  // 作ったパスが Undo で消えたら、最初の点だけの状態に戻す
  if (target.kind === "pending" && pen.created === "path" && pen.pathId !== null) {
    const next = { ...pen, pathId: null, subpath: 0, end: "end" as const };
    setPenDrawing(next);
    return { pen: next, target };
  }
  return { pen, target };
}

/** 描いている輪郭の端の点のページ座標。 */
function endPagePoint(store: Store, target: Extract<PenTarget, { kind: "drawing" }>): Point | null {
  const geometry = pageGeometry(store.getState().doc, target.node.id);
  const sub = target.node.subpaths[target.subpath];
  if (!geometry || !sub) return null;
  return (
    pagePointOf(geometry, { subpath: target.subpath, index: endIndex(sub, target.end) })?.at ?? null
  );
}

/** 予定の線の始まり (最後の点か最初の点)。 */
function previousPoint(store: Store, target: PenTarget): Point | null {
  return target.kind === "pending" ? target.origin : endPagePoint(store, target);
}

/**
 * 描くのを終える。点の編集の中から描いていたら点の編集へ戻り、そうでなければ選択ツールへ戻って作ったパスを選ぶ。
 * `setTool` は自分の `onCancel` を呼ぶので、先に状態を片付ける。
 */
function finishDrawing(ctx: ToolContext, closed = false): void {
  const store = ctx.store;
  const drawing = currentDrawing(store);
  press = null;
  dragging = false;
  setPenDrawing(null);
  setPathEditHover(null);
  const state = store.getState();
  if (state.editingPathId !== null) {
    // 描いた輪郭の端の点を選んで点の編集へ戻る
    if (drawing?.target.kind === "drawing" && !closed) {
      const { target } = drawing;
      const node = getNode(state.doc, target.node.id);
      const sub = node?.type === "path" ? node.subpaths[target.subpath] : undefined;
      if (sub)
        setSelectedPoints(state.doc, target.node.id, [
          { subpath: target.subpath, index: endIndex(sub, target.end) },
        ]);
    } else clearSelectedPoints();
    state.setTool("pathEdit");
    return;
  }
  const id = drawing?.pen.pathId ?? null;
  if (id !== null && getNode(state.doc, id)?.type === "path") {
    const parent = getParent(state.doc, id);
    if (parent) state.setScope(scopeForParent(state.doc, parent));
    state.setSelection([id]);
  }
  state.setTool("select");
}

/** ドラッグのベクトル (Shift で 45° 刻み)。長さ 0 なら null。 */
function dragVector(at: Point, event: CanvasPointerEvent): Point | null {
  const raw = { x: event.page.x - at.x, y: event.page.y - at.y };
  const v = event.shift ? constrainVector45(raw) : raw;
  return v.x === 0 && v.y === 0 ? null : v;
}

/** ジェスチャーを開いて、押した時点の形を入れる。入れられなければ false。 */
function beginAdd(
  store: Store,
  recipe: (base: CanvasDocument, out: Point | null) => CanvasDocument | null,
): boolean {
  const state = store.getState();
  if (!recipe(state.doc, null)) return false;
  state.beginGesture();
  ownsGesture = true;
  state.updateGesture((base) => recipe(base, null) ?? base);
  return true;
}

// ---------------------------------------------------------------------------
// ポインター
// ---------------------------------------------------------------------------

function onPointerDown(event: CanvasPointerEvent, ctx: ToolContext): void {
  resetSelectOverlay();
  ownsGesture = false;
  dragging = false;
  press = { kind: "none" };
  setPathEditHover(null);
  if (event.button !== 0) return;
  const store = ctx.store;
  const state = store.getState();
  const zoom = state.viewport.zoom;
  const screen = event.screen;
  const drawing = currentDrawing(store);

  if (drawing) {
    const { pen, target } = drawing;
    patchPenDrawing({ pointer: null });
    if (target.kind === "pending") {
      const origin = target.origin;
      // 最初の点をもう一度押したら終える (点が 1 個のパスは作らない)
      if (Math.hypot(event.page.x - origin.x, event.page.y - origin.y) <= POINT_HIT_RADIUS / zoom) {
        finishDrawing(ctx);
        press = { kind: "none" };
        return;
      }
      const at = event.shift ? constrainPoint45(origin, event.page) : event.page;
      const id: NodeId =
        pen.created === "path" ? createId(state.doc.nodes) : (pen.pathId as NodeId);
      const subpath =
        pen.created === "path"
          ? 0
          : (() => {
              const node = getNode(state.doc, id);
              return node?.type === "path" ? node.subpaths.length : 0;
            })();
      const recipe = (base: CanvasDocument, out: Point | null) =>
        penSecondPoint(base, pen, id, at, out);
      if (!beginAdd(store, recipe)) return;
      setPenDrawing({ ...pen, pathId: id, subpath, end: "end", pointer: null });
      if (pen.created === "path") {
        const after = store.getState();
        after.setScope(scopeForParent(after.doc, pen.parent));
        after.setSelection([id]);
      }
      press = { kind: "add", screen, at, recipe };
      return;
    }

    const geometry = pageGeometry(state.doc, target.node.id);
    const sub = target.node.subpaths[target.subpath];
    if (!geometry || !sub) return;
    const endRef = { subpath: target.subpath, index: endIndex(sub, target.end) };
    const startRef = { subpath: target.subpath, index: startIndex(sub, target.end) };
    const hit = hitPoint(geometry, event.page, zoom);
    // 最後の点を押したら開いたまま終える
    if (hit && sameRef(hit, endRef)) {
      finishDrawing(ctx);
      press = { kind: "none" };
      return;
    }
    // 描き始めの点を押したら閉じる
    if (hit && sameRef(hit, startRef) && sub.points.length >= 2) {
      const at = pagePointOf(geometry, startRef)?.at ?? event.page;
      const recipe = (base: CanvasDocument, out: Point | null) => penClose(base, target, out);
      if (!beginAdd(store, recipe)) return;
      press = { kind: "close", screen, at, recipe };
      return;
    }
    const from = pagePointOf(geometry, endRef)?.at ?? event.page;
    const at = event.shift ? constrainPoint45(from, event.page) : event.page;
    const recipe = (base: CanvasDocument, out: Point | null) => penAddPoint(base, target, at, out);
    if (!beginAdd(store, recipe)) return;
    press = { kind: "add", screen, at, recipe };
    return;
  }

  // 点の編集の中: 開いた輪郭の端から続ける、線分に点を足す、新しい輪郭を描き始める
  const editingId = state.editingPathId;
  const geometry = editingId === null ? null : pageGeometry(state.doc, editingId);
  if (editingId !== null && geometry) {
    const parent: ParentRef = getParent(state.doc, editingId) ?? {
      kind: "page",
      id: state.pageId,
    };
    const hit = hitPoint(geometry, event.page, zoom);
    if (hit) {
      const sub = geometry.node.subpaths[hit.subpath]!;
      const n = sub.points.length;
      if (!sub.closed && (hit.index === n - 1 || hit.index === 0)) {
        const at = pagePointOf(geometry, hit)?.at ?? event.page;
        setPenDrawing({
          pathId: editingId,
          parent,
          subpath: hit.subpath,
          end: hit.index === n - 1 ? "end" : "start",
          origin: { x: at.x, y: at.y, out: null },
          created: null,
          baseCount: n,
          fromEdit: true,
          pointer: null,
        });
        setSelectedPoints(state.doc, editingId, [hit]);
      }
      return;
    }
    const segment = hitSegment(geometry, event.page, zoom);
    if (segment) {
      const inserted = insertPoint(geometry.node.subpaths, segment);
      if (inserted)
        applyShape(
          store,
          editingId,
          (_node, doc) => withSubpaths(doc, editingId, inserted.subpaths, true),
          [inserted.ref],
        );
      return;
    }
    clearSelectedPoints();
    setPenDrawing({
      pathId: editingId,
      parent,
      subpath: geometry.node.subpaths.length,
      end: "end",
      origin: { x: event.page.x, y: event.page.y, out: null },
      created: "subpath",
      baseCount: 0,
      fromEdit: true,
      pointer: null,
    });
    press = { kind: "pending", screen, at: event.page };
    return;
  }

  // 新しいパス。親は作成ツールと同じ決め方。入れられない (ノード数・深さの上限) なら何もしない
  const parent = creationParent(state.doc, state.pageId, state.scopeId, event.page);
  const probe = createPath(
    [
      {
        closed: false,
        points: [
          { x: 0, y: 0, in: null, out: null, mirror: "none" },
          { x: 1, y: 0, in: null, out: null, mirror: "none" },
        ],
      },
    ],
    { id: createId(state.doc.nodes) },
  );
  if (insertNode(state.doc, probe, parent) === state.doc) return;
  setPenDrawing({
    pathId: null,
    parent,
    subpath: 0,
    end: "end",
    origin: { x: event.page.x, y: event.page.y, out: null },
    created: "path",
    baseCount: 0,
    fromEdit: false,
    pointer: null,
  });
  press = { kind: "pending", screen, at: event.page };
}

function hoverAt(store: Store, page: Point, drawing: ReturnType<typeof currentDrawing>) {
  const state = store.getState();
  const zoom = state.viewport.zoom;
  if (drawing) {
    // 閉じられる描き始めの点を強調する
    const { target } = drawing;
    if (target.kind !== "drawing") return null;
    const geometry = pageGeometry(state.doc, target.node.id);
    const sub = target.node.subpaths[target.subpath];
    if (!geometry || !sub || sub.points.length < 2) return null;
    const startRef = { subpath: target.subpath, index: startIndex(sub, target.end) };
    const hit = hitPoint(geometry, page, zoom);
    return hit && sameRef(hit, startRef) ? ({ kind: "point", ref: hit } as const) : null;
  }
  const id = state.editingPathId;
  const geometry = id === null ? null : pageGeometry(state.doc, id);
  if (!geometry) return null;
  const point = hitPoint(geometry, page, zoom);
  if (point) return { kind: "point", ref: point } as const;
  const segment = hitSegment(geometry, page, zoom);
  return segment
    ? ({ kind: "segment", subpath: segment.subpath, segment: segment.segment } as const)
    : null;
}

function onPointerMove(event: CanvasPointerEvent, ctx: ToolContext): void {
  const store = ctx.store;
  if (event.clickCount === 0 || !press) {
    const drawing = currentDrawing(store);
    if (drawing) {
      const from = previousPoint(store, drawing.target);
      const pointer = from && event.shift ? constrainPoint45(from, event.page) : event.page;
      patchPenDrawing({ pointer });
    }
    const hover: PathEditHover = hoverAt(store, event.page, drawing);
    setPathEditHover(hover);
    return;
  }
  const current = press;
  if (current.kind === "none") return;
  if (!dragging) {
    const dx = event.screen.x - current.screen.x;
    const dy = event.screen.y - current.screen.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
  }
  const out = dragVector(current.at, event);
  if (current.kind === "pending") {
    patchPenDrawing({ origin: { x: current.at.x, y: current.at.y, out } });
    return;
  }
  // Undo などで外からジェスチャーが閉じられたら、それ以上変えない
  if (!ownGestureOpen(store)) {
    ownsGesture = false;
    press = { kind: "none" };
    return;
  }
  store.getState().updateGesture((base) => current.recipe(base, out) ?? store.getState().doc);
}

function onPointerUp(event: CanvasPointerEvent, ctx: ToolContext): void {
  const current = press;
  const wasDragging = dragging;
  press = null;
  dragging = false;
  const store = ctx.store;
  if (!current || current.kind === "none") {
    ownsGesture = false;
    return;
  }
  if (current.kind === "pending") {
    if (wasDragging)
      patchPenDrawing({ origin: { ...current.at, out: dragVector(current.at, event) } });
    return;
  }
  if (!ownGestureOpen(store)) {
    ownsGesture = false;
    return;
  }
  if (wasDragging) {
    const out = dragVector(current.at, event);
    store.getState().updateGesture((base) => current.recipe(base, out) ?? store.getState().doc);
  }
  store.getState().commitGesture();
  ownsGesture = false;
  if (current.kind === "close") {
    finishDrawing(ctx, true);
    return;
  }
  // 点の編集の中なら、描いている端の点を選んでおく (パネルで値が見える)
  const drawing = currentDrawing(store);
  const state = store.getState();
  if (drawing?.target.kind === "drawing" && state.editingPathId === drawing.target.node.id) {
    const sub = drawing.target.node.subpaths[drawing.target.subpath];
    if (sub)
      setSelectedPoints(state.doc, drawing.target.node.id, [
        { subpath: drawing.target.subpath, index: endIndex(sub, drawing.target.end) },
      ]);
  }
}

function onCancel(ctx: ToolContext): void {
  const current = press;
  press = null;
  dragging = false;
  const store = ctx.store;
  // 取り消すのは自分の押下が開いたジェスチャーだけ
  if (current && (current.kind === "add" || current.kind === "close") && ownGestureOpen(store))
    store.getState().cancelGesture();
  ownsGesture = false;
  setPenDrawing(null);
  setPathEditHover(null);
  resetSelectOverlay();
}

// ---------------------------------------------------------------------------
// キー
// ---------------------------------------------------------------------------

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function onKeyDown(event: CanvasKeyEvent, ctx: ToolContext): boolean {
  const store = ctx.store;
  const drawing = currentDrawing(store);
  const plain = !event.shift && !event.alt && !event.mod;
  const key = event.key;

  if ((key === "Enter" || key === "Escape") && plain) {
    if (event.repeat) return true;
    if (drawing) {
      finishDrawing(ctx);
      return true;
    }
    // 点の編集の中で描いていなければ、点の編集へ戻る (Esc の順、§8.7.2)
    if (store.getState().editingPathId !== null) {
      store.getState().setTool("pathEdit");
      return true;
    }
    return false;
  }

  if (drawing && (key === "Backspace" || key === "Delete") && !event.mod && !event.alt) {
    const state = store.getState();
    const result = penRemoveLast(state.doc, drawing.pen, drawing.target);
    if (result.doc !== state.doc) state.apply(() => result.doc);
    setPenDrawing(result.pen ? { ...result.pen, pointer: drawing.pen.pointer } : null);
    return true;
  }

  if (event.mod && !event.alt && key.toLowerCase() === "z") {
    // 最初の点だけ (文書にない) なら、その点を取り消す。文書の Undo には回さない
    if (drawing?.target.kind === "pending") {
      if (!event.repeat) setPenDrawing(null);
      return true;
    }
    clearSelectedPoints();
    return false;
  }

  if (store.getState().editingPathId !== null) return pathEditKey(event, store);
  if (drawing) {
    // 描いている間は、描いているパスを動かしたり複製したりするキーを受けて何もしない
    if (ARROW_KEYS.has(key)) return true;
    if (event.mod && !event.alt && key.toLowerCase() === "a") return true;
    return isBlockedInPathEdit(event);
  }
  return false;
}

export const penTool: Tool = {
  id: "pen",
  cursor: "crosshair",
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  onCancel,
  Overlay: PathEditOverlay,
};
