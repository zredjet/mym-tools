/**
 * 鉛筆 (Shift+P、`docs/canvas-editor-design.md` §4.14)。
 *
 * - 押してからなぞった点を親の座標系で集め、離したら `pencil/fit.ts` の `fitCurve` で 3 次ベジェに当てはめて
 *   (誤差 `PENCIL_TOLERANCE` 画面 px) 開いたパスを作る。終点が始点から `PENCIL_CLOSE_DISTANCE` 画面 px 以内なら
 *   閉じる。塗りなし、線は `createStroke()` の既定、名前は「鉛筆」
 * - 親は作成ツールと同じ決め方 (`creationParent`。回転した frame の中では frame の座標系、ブーリアンのスコープでは
 *   ブーリアンの外)。親は押したときに決める
 * - 押してから `DRAG_THRESHOLD` 画面 px 動いたらなぞり始める (ジェスチャーを開き、なぞった折れ線をそのまま
 *   パスとして描く)。動かさずに離した (クリックだけ) なら何も作らない
 * - 点の数が上限 (§3.5。1 つのパスの点と、文書の全パスの点の合計) を超えるなら、誤差を広げて当てはめ直す
 *   (`pencil/build.ts`)。それでも超えるか、座標が範囲を超えるなら何も作らない
 * - 作ったら、そのパスを選んで選択ツールへ戻る。何も作らなかったら、押す前の選択に戻してツールはそのまま
 * - Esc とフォーカス喪失 (`onCancel`) では、自分が開いたジェスチャーだけを取り消す
 *
 * 履歴: なぞり 1 回が 1 件 (押してから離すまでのジェスチャー)。
 */
import { applyToPoint, invert, type Matrix } from "../geometry/matrix";
import { createPath } from "../model/create";
import { parentMatrix } from "../model/geometry";
import { createId } from "../model/ids";
import { CANVAS_LIMITS } from "../model/limits";
import { insertNode } from "../model/structure";
import { getNode, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, Point, Subpath } from "../model/types";
import { pencilSubpath } from "../pencil/build";
import { creationParent, scopeForParent } from "./create/parent";
import { pathWithinLimits, totalPathPoints } from "./pathEdit/ops";
import { resetSelectOverlay } from "./select/overlayState";
import { DRAG_THRESHOLD } from "./selectTool";
import type { CanvasPointerEvent, Tool, ToolContext } from "./types";

/** 当てはめの誤差 (画面 px)。 */
export const PENCIL_TOLERANCE = 2;
/** 終点が始点からこの距離 (画面 px) 以内なら閉じる。 */
export const PENCIL_CLOSE_DISTANCE = 8;
/** 作るパスの名前。 */
export const PENCIL_NAME = "鉛筆";
/** なぞっている間に描く折れ線の点の数の上限 (多ければ間引く。作るパスには関係しない)。 */
const PREVIEW_MAX_POINTS = 2000;

interface Press {
  screen: Point;
  /** 押したときの文書。なぞり始めるまでに変わったら (Undo など) 何も作らない */
  doc: CanvasDocument;
  /** 押す前の選択 (作らずに終えたら戻す) */
  selection: readonly NodeId[];
  parent: ParentRef;
  /** ページ → 親の座標系 */
  toLocal: Matrix;
  /** 押したときの倍率 (画面 px を親の座標系の長さに直す) */
  zoom: number;
  /** なぞった点 (親の座標系) */
  points: Point[];
}

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; press: Press }
  | { kind: "drawing"; press: Press; id: NodeId }
  /** 押したが何も作らない */
  | { kind: "inert" };

let phase: Phase = { kind: "idle" };
/** 今のなぞりが開いたジェスチャーが開いているか (ほかが開いたジェスチャーは閉じない) */
let ownsGesture = false;

/** テスト用: 状態を捨てる。 */
export function resetPencilTool(): void {
  phase = { kind: "idle" };
  ownsGesture = false;
}

function ownGestureOpen(ctx: ToolContext): boolean {
  return ownsGesture && ctx.store.getState().gestureActive;
}

function addPoint(press: Press, page: Point): void {
  const p = applyToPoint(press.toLocal, page);
  const last = press.points[press.points.length - 1];
  if (!last || last.x !== p.x || last.y !== p.y) press.points.push(p);
}

/** なぞっている間に描く折れ線 (多ければ間引く。最後の点は残す)。 */
function previewSubpath(points: readonly Point[]): Subpath {
  const stride = Math.max(1, Math.ceil(points.length / PREVIEW_MAX_POINTS));
  const picked: Point[] = [];
  for (let i = 0; i < points.length; i += stride) picked.push(points[i] as Point);
  const last = points[points.length - 1];
  if (last && picked[picked.length - 1] !== last) picked.push(last);
  return {
    closed: false,
    points: picked.map((p) => ({ x: p.x, y: p.y, in: null, out: null, mirror: "none" })),
  };
}

/** パスを入れた文書。上限を超えるか入れられなければ null。 */
function insertPath(
  base: CanvasDocument,
  id: NodeId,
  subpath: Subpath,
  parent: ParentRef,
): CanvasDocument | null {
  const node = createPath([subpath], { id, name: PENCIL_NAME });
  const next = insertNode(base, node, parent);
  return next !== base && pathWithinLimits(next, id, true) ? next : null;
}

/** 離したときに作るパスの輪郭。作れなければ null。 */
export function pencilResult(
  base: CanvasDocument,
  points: readonly Point[],
  zoom: number,
): Subpath | null {
  const available = Math.min(
    CANVAS_LIMITS.maxPathPoints,
    CANVAS_LIMITS.maxTotalPathPoints - totalPathPoints(base),
  );
  if (available < 1) return null;
  const result = pencilSubpath(points, {
    tolerance: PENCIL_TOLERANCE / zoom,
    closeDistance: PENCIL_CLOSE_DISTANCE / zoom,
    maxPoints: available,
  });
  return result?.subpath ?? null;
}

function onPointerDown(event: CanvasPointerEvent, ctx: ToolContext): void {
  resetSelectOverlay();
  ownsGesture = false;
  phase = { kind: "inert" };
  if (event.button !== 0) return;
  const state = ctx.store.getState();
  state.setHovered(null);
  const doc = state.doc;
  const parent = creationParent(doc, state.pageId, state.scopeId, event.page);
  const toLocal = invert(parentMatrix(doc, parent));
  if (!toLocal) return;
  const press: Press = {
    screen: event.screen,
    doc,
    selection: state.selection,
    parent,
    toLocal,
    zoom: state.viewport.zoom,
    points: [],
  };
  addPoint(press, event.page);
  phase = { kind: "pending", press };
}

function onPointerMove(event: CanvasPointerEvent, ctx: ToolContext): void {
  if (event.clickCount === 0 || phase.kind === "idle" || phase.kind === "inert") return;
  addPoint(phase.press, event.page);
  if (phase.kind === "pending") {
    const press = phase.press;
    const moved = Math.hypot(event.screen.x - press.screen.x, event.screen.y - press.screen.y);
    if (moved < DRAG_THRESHOLD) return;
    const state = ctx.store.getState();
    const id = createId(state.doc.nodes);
    // 押してから文書が変わった (親が古い) か、ノード数・深さの上限で入れられないなら作らない
    const probe = createPath([previewSubpath(press.points)], { id });
    if (state.doc !== press.doc || insertNode(state.doc, probe, press.parent) === state.doc) {
      phase = { kind: "inert" };
      return;
    }
    state.beginGesture();
    ownsGesture = true;
    phase = { kind: "drawing", press, id };
  }
  // Undo などで外からジェスチャーが閉じられたら、それ以上描かない
  if (!ownGestureOpen(ctx)) {
    ownsGesture = false;
    phase = { kind: "inert" };
    return;
  }
  const { press, id } = phase;
  const store = ctx.store;
  store
    .getState()
    .updateGesture(
      (base) =>
        insertPath(base, id, previewSubpath(press.points), press.parent) ?? store.getState().doc,
    );
}

function onPointerUp(event: CanvasPointerEvent, ctx: ToolContext): void {
  const current = phase;
  phase = { kind: "idle" };
  if (current.kind !== "drawing") {
    ownsGesture = false;
    return;
  }
  if (!ownGestureOpen(ctx)) {
    ownsGesture = false;
    return;
  }
  const { press, id } = current;
  addPoint(press, event.page);
  const store = ctx.store;
  // ジェスチャーの元の文書は押したときの文書 (なぞり始めるときに同じことを確かめてある)
  const subpath = pencilResult(press.doc, press.points, press.zoom);
  const next = subpath && insertPath(press.doc, id, subpath, press.parent);
  ownsGesture = false;
  if (!subpath || !next) {
    // 何も作らなかったら、押す前の文書と選択に戻してツールはそのまま
    store.getState().cancelGesture();
    return;
  }
  store.getState().updateGesture((base) => insertPath(base, id, subpath, press.parent) ?? base);
  store.getState().commitGesture();
  const state = store.getState();
  if (!getNode(state.doc, id)) return;
  state.setScope(scopeForParent(state.doc, press.parent));
  state.setSelection([id]);
  // ここで自分の onCancel が呼ばれるが、状態は片付け済みなので何もしない
  state.setTool("select");
}

function onCancel(ctx: ToolContext): void {
  const current = phase;
  phase = { kind: "idle" };
  // 取り消すのは自分のなぞりが開いたジェスチャーだけ。文書と選択は押す前に戻る
  if (current.kind === "drawing" && ownGestureOpen(ctx)) ctx.store.getState().cancelGesture();
  ownsGesture = false;
}

export const pencilTool: Tool = {
  id: "pencil",
  cursor: "crosshair",
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onCancel,
};
