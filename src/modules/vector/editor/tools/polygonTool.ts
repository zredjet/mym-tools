/**
 * 多角形と星の作成ツール (`docs/canvas-editor-design.md` §4.14)。星のツール (`starTool.ts`) もここの
 * `createRegularShapeTool` で作る。
 *
 * - ドラッグした矩形に収まる形を作る。ドラッグの決め方 (Shift で正方形、Alt で中心から、吸着とスマートガイド、
 *   クリックだけなら 100 × 100)、親 (回転した frame の中、ブーリアンのスコープではブーリアンの親)、上限、
 *   Esc とフォーカス喪失での取消、作ったら選んで選択ツールへ戻ることは、矩形ツール (`create/dragCreateTool.ts`)
 *   と同じ。矩形ツールをそのまま動かし、文書に入る矩形を同じ箱・同じ ID のパスに置き換える (`shapeContext`)
 * - 形は、最初の頂点を上の中央に置いた正多角形 (星は外側と内側の頂点を交互) を、箱にぴったり収まるよう
 *   縦横に拡大したもの (`path/polygon.ts`)。角の点だけの閉じたパス。点は小数第 2 位に丸める (§4.12)
 * - 名前は「多角形」「星」。塗り・線・影は矩形ツールが作る矩形のもの (矩形の既定)
 * - 頂点の数と凹みは「ツールの設定」(`getShapeToolSettings`)。プロパティパネルの節で変え、エディタを開いている
 *   間だけ覚える (store にも settings.json にも入れない。節がエディタを開くたびに `resetShapeToolSettings` を呼ぶ)
 *
 * 履歴: 矩形ツールと同じく、ドラッグ 1 回 (またはクリック 1 回) が 1 件。
 */
import type { StoreApi } from "zustand";
import { createPath } from "../model/create";
import { hasOwn } from "../model/ids";
import type { CanvasDocument, NodeId, PathNode, RectNode, Subpath } from "../model/types";
import {
  clampSides,
  clampStarRatio,
  POLYGON_DEFAULT_SIDES,
  polygonSubpath,
  STAR_DEFAULT_POINTS,
  STAR_DEFAULT_RATIO,
  starSubpath,
} from "../path/polygon";
import type { DocRecipe, EditorStore } from "../state/types";
import { createDragTool } from "./create/dragCreateTool";
import { pathWithinLimits } from "./pathEdit/ops";
import type { Tool, ToolContext } from "./types";

export type RegularShapeKind = "polygon" | "star";

/** 作るパスの名前 (§4.14)。 */
export const REGULAR_SHAPE_NAMES: Readonly<Record<RegularShapeKind, string>> = {
  polygon: "多角形",
  star: "星",
};

// ---------------------------------------------------------------------------
// ツールの設定 (エディタを開いている間だけ覚える)
// ---------------------------------------------------------------------------

export interface ShapeToolSettings {
  /** 多角形の頂点の数 (3〜60) */
  polygonSides: number;
  /** 星の外側の頂点の数 (3〜60) */
  starPoints: number;
  /** 星の凹み: 内側の半径 ÷ 外側の半径 (0.01〜1) */
  starRatio: number;
}

export const DEFAULT_SHAPE_TOOL_SETTINGS: ShapeToolSettings = {
  polygonSides: POLYGON_DEFAULT_SIDES,
  starPoints: STAR_DEFAULT_POINTS,
  starRatio: STAR_DEFAULT_RATIO,
};

let settings: ShapeToolSettings = DEFAULT_SHAPE_TOOL_SETTINGS;
const listeners = new Set<() => void>();

export function getShapeToolSettings(): ShapeToolSettings {
  return settings;
}

export function subscribeShapeToolSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 設定を変える。範囲に収め (頂点の数は整数に切り捨て)、変わらなければ何もしない。 */
export function setShapeToolSettings(patch: Partial<ShapeToolSettings>): void {
  const next: ShapeToolSettings = {
    polygonSides: clampSides(patch.polygonSides ?? settings.polygonSides),
    starPoints: clampSides(patch.starPoints ?? settings.starPoints),
    starRatio: clampStarRatio(patch.starRatio ?? settings.starRatio),
  };
  if (
    next.polygonSides === settings.polygonSides &&
    next.starPoints === settings.starPoints &&
    next.starRatio === settings.starRatio
  )
    return;
  settings = next;
  for (const listener of listeners) listener();
}

/** 既定に戻す (エディタを開くたび)。 */
export function resetShapeToolSettings(): void {
  if (settings === DEFAULT_SHAPE_TOOL_SETTINGS) return;
  settings = DEFAULT_SHAPE_TOOL_SETTINGS;
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------

function round2(value: number): number {
  const r = Math.round(value * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * 幅 × 高さの箱 (左上が (0, 0)) に収まる形の輪郭。点は小数第 2 位に丸める。範囲の端の頂点は箱の辺ちょうど
 * なので、箱の大きさが整数なら丸めても範囲は変わらない。
 */
export function regularShapeSubpath(
  kind: RegularShapeKind,
  width: number,
  height: number,
  options: ShapeToolSettings = settings,
): Subpath {
  const rect = { x: 0, y: 0, width, height };
  const sub =
    kind === "polygon"
      ? polygonSubpath(options.polygonSides, rect)
      : starSubpath(options.starPoints, options.starRatio, rect);
  return {
    closed: true,
    points: sub.points.map((p) => ({ ...p, x: round2(p.x), y: round2(p.y) })),
  };
}

/** 矩形ツールが作った矩形を、同じ ID・同じ箱・同じ見た目のパスにする。 */
export function regularShapeFromRect(
  kind: RegularShapeKind,
  rect: RectNode,
  options: ShapeToolSettings = settings,
): PathNode {
  return createPath([regularShapeSubpath(kind, rect.width, rect.height, options)], {
    id: rect.id,
    name: REGULAR_SHAPE_NAMES[kind],
    x: rect.x,
    y: rect.y,
    fill: rect.fill,
    stroke: rect.stroke,
    shadow: rect.shadow,
  });
}

/**
 * `next` で `base` に無かった矩形を形に置き換える。置き換えた結果が点の上限 (§3.5) を超えるなら null。
 * 置き換えるものがなければ `next` をそのまま返す。
 */
export function convertCreatedRects(
  kind: RegularShapeKind,
  base: CanvasDocument,
  next: CanvasDocument,
): CanvasDocument | null {
  if (next === base) return next;
  let nodes: CanvasDocument["nodes"] | null = null;
  const converted: NodeId[] = [];
  for (const id of Object.keys(next.nodes)) {
    if (hasOwn(base.nodes, id)) continue;
    const node = next.nodes[id];
    if (node?.type !== "rect") continue;
    nodes ??= { ...next.nodes };
    nodes[id] = regularShapeFromRect(kind, node);
    converted.push(id);
  }
  if (!nodes) return next;
  const doc = { ...next, nodes };
  return converted.every((id) => pathWithinLimits(doc, id, true)) ? doc : null;
}

/**
 * 矩形ツールに渡す文脈。store の `apply` と `updateGesture` の結果で、新しく入った矩形を形に置き換える。
 * 上限を超えるなら、`apply` は文書を変えず、`updateGesture` は前の結果を残す (矩形ツールと同じ扱い)。
 */
function shapeContext(kind: RegularShapeKind, ctx: ToolContext): ToolContext {
  const store = ctx.store;
  const getState = (): EditorStore => {
    const state = store.getState();
    return {
      ...state,
      apply: (recipe: DocRecipe) =>
        state.apply((doc) => convertCreatedRects(kind, doc, recipe(doc)) ?? doc),
      updateGesture: (recipe: DocRecipe) =>
        state.updateGesture(
          (base) => convertCreatedRects(kind, base, recipe(base)) ?? store.getState().doc,
        ),
    };
  };
  const wrapped: StoreApi<EditorStore> = { ...store, getState };
  return { ...ctx, store: wrapped };
}

export interface RegularShapeTool extends Tool {
  /** テスト用: 状態を捨てる */
  reset(): void;
}

export function createRegularShapeTool(kind: RegularShapeKind): RegularShapeTool {
  const inner = createDragTool("rect");
  return {
    id: kind,
    cursor: "crosshair",
    onPointerDown: (event, ctx) => inner.onPointerDown?.(event, shapeContext(kind, ctx)),
    onPointerMove: (event, ctx) => inner.onPointerMove?.(event, shapeContext(kind, ctx)),
    onPointerUp: (event, ctx) => inner.onPointerUp?.(event, shapeContext(kind, ctx)),
    onCancel: (ctx) => inner.onCancel?.(shapeContext(kind, ctx)),
    reset: () => inner.reset(),
  };
}

/** 多角形 (§4.14)。 */
export const polygonTool = createRegularShapeTool("polygon");
