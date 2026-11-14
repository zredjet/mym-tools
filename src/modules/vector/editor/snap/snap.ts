/**
 * スナップとスマートガイド (§4.6)。純関数。
 *
 * - 候補は、同じ親の兄弟と親 frame の辺・中心、ガイド線、グリッド (`snapToGrid` のとき)
 * - しきい値 (`SNAP_THRESHOLD` 画面 px) 以内でいちばん近いものに吸着する
 * - そろった線 (ガイド線とグリッドを除く) を重ね描きする
 * - Cmd/Ctrl を押している間は吸着しない (呼び出し側が判定する)
 *
 * 候補はドラッグの開始時に集め (`collectSnapTargets`)、ポインターが動くたびには集め直さない。
 */
import { getPageBounds, type Rect } from "../model/geometry";
import { getChildren, getNode, getPage, type ParentRef } from "../model/tree";
import type { CanvasDocument, NodeId, PageId } from "../model/types";

/** 吸着する距離 (画面 px)。 */
export const SNAP_THRESHOLD = 6;

/**
 * 吸着先の線。`pos` は x の線なら x 座標、y の線なら y 座標。
 * `start` / `end` は線の伸びる範囲 (x の線なら y の範囲)。ガイド線は無限 (重ね描きしない)。
 */
export interface SnapLine {
  pos: number;
  start: number;
  end: number;
}

export interface SnapTargets {
  /** 縦の線 (x 座標) */
  x: SnapLine[];
  /** 横の線 (y 座標) */
  y: SnapLine[];
}

/** 重ね描きするスマートガイド (ページ座標)。 */
export interface SnapGuide {
  /** `x` は縦の線 (x = pos)、`y` は横の線 */
  axis: "x" | "y";
  pos: number;
  start: number;
  end: number;
}

/** 動かす側の線。`grid` が true ならグリッドにも吸着する (辺だけ。中心はグリッドに合わせない)。 */
export interface SnapValue {
  value: number;
  grid: boolean;
}

export const EMPTY_SNAP_TARGETS: SnapTargets = { x: [], y: [] };

/** 矩形の辺と中心の線。 */
export function rectSnapLines(rect: Rect): SnapTargets {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const yRange = { start: rect.y, end: bottom };
  const xRange = { start: rect.x, end: right };
  return {
    x: [
      { pos: rect.x, ...yRange },
      { pos: rect.x + rect.width / 2, ...yRange },
      { pos: right, ...yRange },
    ],
    y: [
      { pos: rect.y, ...xRange },
      { pos: rect.y + rect.height / 2, ...xRange },
      { pos: bottom, ...xRange },
    ],
  };
}

/** 動かす矩形の線 (左・中心・右、上・中心・下)。辺はグリッドにも吸着する。 */
export function rectSnapValues(rect: Rect): { x: SnapValue[]; y: SnapValue[] } {
  return {
    x: [
      { value: rect.x, grid: true },
      { value: rect.x + rect.width / 2, grid: false },
      { value: rect.x + rect.width, grid: true },
    ],
    y: [
      { value: rect.y, grid: true },
      { value: rect.y + rect.height / 2, grid: false },
      { value: rect.y + rect.height, grid: true },
    ],
  };
}

export interface CollectSnapOptions {
  /** 兄弟を集める親 */
  parents: readonly ParentRef[];
  /** 辺と中心を候補にする frame (動かすノードの座標系の frame) */
  frames: readonly NodeId[];
  /** 候補にしないノード (動かしているもの) */
  exclude: ReadonlySet<NodeId>;
}

/** スナップの候補を集める。非表示の兄弟は除く。ページのガイド線は無限の線として入れる。 */
export function collectSnapTargets(
  doc: CanvasDocument,
  pageId: PageId,
  options: CollectSnapOptions,
): SnapTargets {
  const x: SnapLine[] = [];
  const y: SnapLine[] = [];
  const add = (rect: Rect | null) => {
    if (!rect) return;
    const lines = rectSnapLines(rect);
    x.push(...lines.x);
    y.push(...lines.y);
  };
  const seenParents = new Set<string>();
  for (const parent of options.parents) {
    const key = `${parent.kind}:${parent.id}`;
    if (seenParents.has(key)) continue;
    seenParents.add(key);
    for (const id of getChildren(doc, parent)) {
      if (options.exclude.has(id) || getNode(doc, id)?.visible !== true) continue;
      add(getPageBounds(doc, id));
    }
  }
  for (const id of new Set(options.frames)) add(getPageBounds(doc, id));
  for (const guide of getPage(doc, pageId)?.guides ?? []) {
    const line = { pos: guide.position, start: -Infinity, end: Infinity };
    (guide.axis === "x" ? x : y).push(line);
  }
  return { x, y };
}

/**
 * 1 つの軸で吸着する量。`values` のどれかを、候補の線かグリッドの線に合わせる
 * いちばん小さな移動量を返す。`threshold` (ページ座標) 以内に何もなければ null。
 */
export function snapAxis(
  values: readonly SnapValue[],
  lines: readonly SnapLine[],
  threshold: number,
  gridSize: number | null,
): number | null {
  let best: number | null = null;
  const consider = (delta: number) => {
    if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best)))
      best = delta;
  };
  for (const v of values) {
    for (const line of lines) consider(line.pos - v.value);
    if (gridSize !== null && gridSize > 0 && v.grid)
      consider(Math.round(v.value / gridSize) * gridSize - v.value);
  }
  return best;
}

export interface SnapOptions {
  /** ページ座標のしきい値 (= `SNAP_THRESHOLD` / zoom) */
  threshold: number;
  /** グリッドの間隔。グリッドに吸着しないなら null */
  gridSize: number | null;
}

/**
 * 移動の吸着。`rect` は動かした後の外接矩形 (吸着の前)。`axes` で吸着する軸を選ぶ
 * (Shift で水平に固定しているときは縦に吸着しない)。返すのは足す量。
 */
export function snapMove(
  rect: Rect,
  targets: SnapTargets,
  options: SnapOptions,
  axes: { x: boolean; y: boolean } = { x: true, y: true },
): { dx: number; dy: number } {
  const values = rectSnapValues(rect);
  const dx = axes.x ? snapAxis(values.x, targets.x, options.threshold, options.gridSize) : null;
  const dy = axes.y ? snapAxis(values.y, targets.y, options.threshold, options.gridSize) : null;
  return { dx: dx ?? 0, dy: dy ?? 0 };
}

/** 1 つの値 (リサイズで動かす辺、線の端点) の吸着。返すのは足す量 (なければ 0)。 */
export function snapValue(value: number, lines: readonly SnapLine[], options: SnapOptions): number {
  return snapAxis([{ value, grid: true }], lines, options.threshold, options.gridSize) ?? 0;
}

/** 重ね描きでそろったとみなす差 (ページ座標)。結果を整数に丸めるので 0.5 まで。 */
export const ALIGN_EPSILON = 0.5;

/**
 * そろった線をスマートガイドにする。`values` (動かした後の線) と同じ位置にある候補の線を、
 * 動かした矩形 `rect` と候補の範囲をつなぐ長さで返す。同じ位置の線は 1 本にまとめる。
 * 無限の線 (ガイド線) は出さない。
 */
export function alignedGuides(
  axis: "x" | "y",
  values: readonly number[],
  lines: readonly SnapLine[],
  rect: Rect,
  epsilon = ALIGN_EPSILON,
): SnapGuide[] {
  const ownStart = axis === "x" ? rect.y : rect.x;
  const ownEnd = axis === "x" ? rect.y + rect.height : rect.x + rect.width;
  const byPos = new Map<number, SnapGuide>();
  for (const value of values)
    for (const line of lines) {
      if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) continue;
      if (Math.abs(line.pos - value) > epsilon) continue;
      const pos = value;
      const current = byPos.get(pos);
      const start = Math.min(ownStart, line.start, current?.start ?? Infinity);
      const end = Math.max(ownEnd, line.end, current?.end ?? -Infinity);
      byPos.set(pos, { axis, pos, start, end });
    }
  return [...byPos.values()];
}

/** 矩形の線 (辺と中心) のうち、候補とそろっているものすべてのスマートガイド。 */
export function rectGuides(
  rect: Rect,
  targets: SnapTargets,
  axes: { x: boolean; y: boolean },
): SnapGuide[] {
  const values = rectSnapValues(rect);
  return [
    ...(axes.x
      ? alignedGuides(
          "x",
          values.x.map((v) => v.value),
          targets.x,
          rect,
        )
      : []),
    ...(axes.y
      ? alignedGuides(
          "y",
          values.y.map((v) => v.value),
          targets.y,
          rect,
        )
      : []),
  ];
}
