/**
 * グリッドを描く条件 (§5.5、純関数)。
 * - `view.grid` が入なら `gridSize` の間隔で描く。ただし線の間隔が 4 画面 px を下回る倍率では描かない
 * - 倍率 800% 以上では、表示の入切に関係なく 1 px のグリッドを描く
 */
import type { ViewOptions } from "../state/types";

export const MIN_GRID_SPACING = 4;
export const PIXEL_GRID_ZOOM = 8;

export interface GridLevel {
  /** 線の間隔 (ページ px) */
  step: number;
  /** `view.grid` のグリッドなら true (1 px のグリッドより濃く描く) */
  strong: boolean;
}

export function gridLevels(
  view: Pick<ViewOptions, "grid" | "gridSize">,
  zoom: number,
): GridLevel[] {
  const levels: GridLevel[] = [];
  if (zoom >= PIXEL_GRID_ZOOM) levels.push({ step: 1, strong: false });
  if (view.grid && view.gridSize > 0 && view.gridSize * zoom >= MIN_GRID_SPACING) {
    if (view.gridSize === 1 && levels.length > 0) levels[0] = { step: 1, strong: true };
    else levels.push({ step: view.gridSize, strong: true });
  }
  return levels;
}

/**
 * パターンの 1 枚目の左上の画面座標。ページ座標 0 の線が画面のどこに来るかから求め、
 * 0 以上 1 周期未満に収める (大きな座標でも小数の誤差が増えないように)。
 */
export function gridOffset(origin: number, step: number, zoom: number): number {
  const period = step * zoom;
  const offset = (-origin * zoom) % period;
  return offset < 0 ? offset + period : offset || 0;
}
