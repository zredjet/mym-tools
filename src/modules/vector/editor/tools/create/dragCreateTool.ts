/**
 * フレーム・矩形・楕円・線の作成ツール (§4.4 / §4.6)。4 つのツールはここの `createDragTool` で作る。
 *
 * - 押した点の下の最も前面の frame (スコープの中ならスコープ) を親にし、座標は親の座標系に直す。
 *   親は押したときに決め、ドラッグの途中では変えない (切り抜く frame の外へはみ出しても、見た目の位置は変えない)
 * - 押してから `DRAG_THRESHOLD` 画面 px 動いたらドラッグ。ドラッグの間は作ったノードを文書に入れて描く
 *   (`beginGesture` / `updateGesture` / `commitGesture` で履歴 1 件)
 * - 動かさずに離したら (クリック)、フレームはプロパティパネルで直前に選んだプリセットの大きさ (初回は iPhone)、
 *   矩形と楕円は 100 × 100 で、押した点を左上にして作る。線は作らない
 * - 押してからドラッグを始める (またはクリックを確定する) までに文書が変わったら、何も作らない
 * - 作ったら、そのノードを選んで選択ツールへ戻る。`setTool` は自分の `onCancel` を呼ぶので、先に
 *   ジェスチャーの確定と内部状態の片付けを済ませる
 * - Esc とフォーカス喪失 (`onCancel`) では、自分のドラッグが開いたジェスチャーだけを取り消し、何も残さない
 * - Shift で正方形・正円 (線は 45° 刻み)、Alt で押した点を中心にする。結果は整数
 * - スナップとスマートガイドは選択ツールと同じ規則 (候補は押したときに 1 回だけ集める)。Cmd/Ctrl を押している間は吸着しない
 * - §3.5 の範囲、ノード数と深さの上限を超えるなら作らない
 *
 * 計算はページ座標で行う。ドラッグの途中で表示位置が変わると、キャンバスが今のポインター位置で
 * `onPointerMove` を呼ぶので、そのまま追従する。
 */
import { createEllipse, createFrame, createLine, createRect } from "../../model/create";
import { getPageBounds, parentOrigin } from "../../model/geometry";
import { createId } from "../../model/ids";
import { insertNode } from "../../model/structure";
import { getNode, type ParentRef } from "../../model/tree";
import type { CanvasNode, NodeId, Point } from "../../model/types";
import { geometryWithinLimits } from "../../panels/limits";
import {
  alignedGuides,
  collectSnapTargets,
  rectGuides,
  SNAP_THRESHOLD,
  snapValue,
  type SnapGuide,
  type SnapOptions,
  type SnapTargets,
} from "../../snap/snap";
import type { EditorStore } from "../../state/types";
import { resetSelectOverlay, setSelectOverlay } from "../select/overlayState";
import { DRAG_THRESHOLD } from "../selectTool";
import type { CanvasPointerEvent, Tool, ToolContext } from "../types";
import { getLastFrameSize } from "./frameSize";
import { clickBox, dragBox, dragLine, type Size } from "./geometry";
import { creationParent, parentCoordinateFrame, scopeForParent } from "./parent";

export type ShapeKind = "frame" | "rect" | "ellipse" | "line";

/** クリックだけで作る矩形と楕円の大きさ。 */
export const CLICK_SHAPE_SIZE: Size = { width: 100, height: 100 };

interface Press {
  /** 押した点 (ページ座標、吸着の後) */
  page: Point;
  screen: Point;
  /** 押したときの文書。ドラッグを始めるまでに変わったら (Undo など) 何も作らない */
  doc: EditorStore["doc"];
  /** 押す前の選択 (作らずに終えたら戻す) */
  selection: readonly NodeId[];
  parent: ParentRef;
  /** 親の座標系の原点 (ページ座標) */
  origin: Point;
  targets: SnapTargets;
}

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; press: Press }
  | { kind: "drag"; press: Press; id: NodeId }
  /** 押したが何も作らない (上限などで作れない) */
  | { kind: "inert" };

export interface DragCreateTool extends Tool {
  /** テスト用: 状態を捨てる */
  reset(): void;
  /** テスト用: 今の状態の種類 */
  phase(): Phase["kind"];
}

function snapOptions(state: EditorStore): SnapOptions {
  return {
    threshold: SNAP_THRESHOLD / state.viewport.zoom,
    gridSize: state.view.snapToGrid ? state.view.gridSize : null,
  };
}

function snapPoint(point: Point, targets: SnapTargets, options: SnapOptions): Point {
  return {
    x: point.x + snapValue(point.x, targets.x, options),
    y: point.y + snapValue(point.y, targets.y, options),
  };
}

function boxNode(kind: Exclude<ShapeKind, "line">, id: NodeId, box: Size & Point): CanvasNode {
  const init = { id, x: box.x, y: box.y, width: box.width, height: box.height };
  switch (kind) {
    case "frame":
      return createFrame(init);
    case "rect":
      return createRect(init);
    case "ellipse":
      return createEllipse(init);
  }
}

/** 上限 (ノード数・深さ) の確認に使う、位置だけ仮のノード。 */
function probeNode(kind: ShapeKind, id: NodeId): CanvasNode {
  return kind === "line"
    ? createLine({ id })
    : boxNode(kind, id, { x: 0, y: 0, width: 1, height: 1 });
}

/** 文書にノードを入れる。範囲を超える、または入れられないなら null。 */
function insertChecked(
  doc: EditorStore["doc"],
  node: CanvasNode,
  parent: ParentRef,
): EditorStore["doc"] | null {
  const next = insertNode(doc, node, parent);
  return next !== doc && geometryWithinLimits(next, [node.id]) ? next : null;
}

export function createDragTool(kind: ShapeKind): DragCreateTool {
  let phase: Phase = { kind: "idle" };
  /** 今のドラッグが開いたジェスチャーが開いているか (ほかが開いたジェスチャーは閉じない) */
  let ownsGesture = false;

  const ownGestureOpen = (ctx: ToolContext) => ownsGesture && ctx.store.getState().gestureActive;

  /** 作ったノードを選び、選択ツールへ戻る。内部状態は先に片付けておくこと。 */
  const finish = (ctx: ToolContext, id: NodeId, parent: ParentRef) => {
    const state = ctx.store.getState();
    const node = getNode(state.doc, id);
    if (!node) return;
    state.setScope(scopeForParent(state.doc, parent));
    state.setSelection([id]);
    // ここで自分の onCancel が呼ばれるが、状態は片付け済みなので何もしない
    state.setTool("select");
  };

  /** ドラッグの今の位置でノードを作り直す。 */
  const updateDrag = (press: Press, id: NodeId, event: CanvasPointerEvent, ctx: ToolContext) => {
    const store = ctx.store;
    const state = store.getState();
    const options = snapOptions(state);
    const snapping = !event.mod;
    let node: CanvasNode | null;
    if (kind === "line") {
      // 45° 刻みのときは吸着しない (選択ツールの端点と同じ)
      const pointer =
        snapping && !event.shift ? snapPoint(event.page, press.targets, options) : event.page;
      const line = dragLine(press.page, pointer, press.origin, {
        constrain: event.shift,
        fromCenter: event.alt,
      });
      node = line ? createLine({ id, ...line }) : null;
    } else {
      const pointer = snapping ? snapPoint(event.page, press.targets, options) : event.page;
      const box = dragBox(press.page, pointer, press.origin, {
        square: event.shift,
        fromCenter: event.alt,
      });
      node = boxNode(kind, id, box);
    }
    // 範囲を超えるなら当てない (前の結果を残す)。線の長さが 0 なら、まだ何も入れない
    state.updateGesture((base) =>
      node ? (insertChecked(base, node, press.parent) ?? store.getState().doc) : base,
    );

    const after = store.getState();
    const exists = getNode(after.doc, id) !== undefined;
    if (exists && !(after.selection.length === 1 && after.selection[0] === id))
      after.setSelection([id]);
    setSelectOverlay({ guides: exists && snapping ? guidesFor(after.doc, id, press, event) : [] });
  };

  /** そろった線 (スマートガイド)。 */
  const guidesFor = (
    doc: EditorStore["doc"],
    id: NodeId,
    press: Press,
    event: CanvasPointerEvent,
  ): SnapGuide[] => {
    const node = getNode(doc, id);
    if (!node) return [];
    if (node.type === "line") {
      if (event.shift) return [];
      const end = { x: press.origin.x + node.x2, y: press.origin.y + node.y2, width: 0, height: 0 };
      return [
        ...alignedGuides("x", [end.x], press.targets.x, end),
        ...alignedGuides("y", [end.y], press.targets.y, end),
      ];
    }
    const bounds = getPageBounds(doc, id);
    return bounds ? rectGuides(bounds, press.targets, { x: true, y: true }) : [];
  };

  const onPointerDown = (event: CanvasPointerEvent, ctx: ToolContext) => {
    resetSelectOverlay();
    ownsGesture = false;
    if (event.button !== 0) {
      phase = { kind: "inert" };
      return;
    }
    const state = ctx.store.getState();
    state.setHovered(null);
    const doc = state.doc;
    const parent = creationParent(doc, state.pageId, state.scopeId, event.page);
    const frame = parentCoordinateFrame(doc, parent);
    // 候補は押したときに 1 回だけ集める (ノードが数千個でもドラッグのたびに調べ直さない)
    const targets = collectSnapTargets(doc, state.pageId, {
      parents: [parent],
      frames: frame === null ? [] : [frame],
      exclude: new Set(),
    });
    const page = event.mod ? event.page : snapPoint(event.page, targets, snapOptions(state));
    phase = {
      kind: "pending",
      press: {
        page,
        screen: event.screen,
        doc,
        selection: state.selection,
        parent,
        origin: parentOrigin(doc, parent),
        targets,
      },
    };
  };

  const onPointerMove = (event: CanvasPointerEvent, ctx: ToolContext) => {
    if (event.clickCount === 0 || phase.kind === "idle" || phase.kind === "inert") return;
    if (phase.kind === "pending") {
      const press = phase.press;
      const dx = event.screen.x - press.screen.x;
      const dy = event.screen.y - press.screen.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      const state = ctx.store.getState();
      const id = createId(state.doc.nodes);
      // 押してから文書が変わった (原点と親が古い) か、ノード数・深さの上限で入れられないなら作らない
      if (
        state.doc !== press.doc ||
        insertNode(state.doc, probeNode(kind, id), press.parent) === state.doc
      ) {
        phase = { kind: "inert" };
        return;
      }
      state.beginGesture();
      ownsGesture = true;
      phase = { kind: "drag", press, id };
    }
    // Undo などで外からジェスチャーが閉じられたら、それ以上作らない
    if (!ownGestureOpen(ctx)) {
      ownsGesture = false;
      phase = { kind: "inert" };
      resetSelectOverlay();
      return;
    }
    updateDrag(phase.press, phase.id, event, ctx);
  };

  const onPointerUp = (event: CanvasPointerEvent, ctx: ToolContext) => {
    const current = phase;
    phase = { kind: "idle" };
    resetSelectOverlay();
    const store = ctx.store;
    if (current.kind === "pending") {
      ownsGesture = false;
      if (kind === "line") return;
      const press = current.press;
      // 押してから文書が変わったら (原点と親が古い) 作らない
      if (store.getState().doc !== press.doc) return;
      const size = kind === "frame" ? getLastFrameSize() : CLICK_SHAPE_SIZE;
      const state = store.getState();
      const id = createId(state.doc.nodes);
      const node = boxNode(kind, id, clickBox(press.page, press.origin, size));
      state.apply((doc) => insertChecked(doc, node, press.parent) ?? doc);
      finish(ctx, id, press.parent);
      return;
    }
    if (current.kind !== "drag") {
      ownsGesture = false;
      return;
    }
    if (!ownGestureOpen(ctx)) {
      ownsGesture = false;
      return;
    }
    updateDrag(current.press, current.id, event, ctx);
    resetSelectOverlay();
    store.getState().commitGesture();
    ownsGesture = false;
    if (getNode(store.getState().doc, current.id)) finish(ctx, current.id, current.press.parent);
    // 何も作らなかった (長さ 0 の線) なら、押す前の選択に戻してツールはそのまま
    else store.getState().setSelection(current.press.selection);
  };

  const onCancel = (ctx: ToolContext) => {
    const current = phase;
    phase = { kind: "idle" };
    resetSelectOverlay();
    // 取り消すのは自分のドラッグが開いたジェスチャーだけ (本文の編集や色の選択のジェスチャーは残す)。
    // 文書と選択は押す前に戻る
    if (current.kind === "drag" && ownGestureOpen(ctx)) ctx.store.getState().cancelGesture();
    ownsGesture = false;
  };

  return {
    id: kind,
    cursor: "crosshair",
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onCancel,
    reset() {
      phase = { kind: "idle" };
      ownsGesture = false;
      resetSelectOverlay();
    },
    phase: () => phase.kind,
  };
}
