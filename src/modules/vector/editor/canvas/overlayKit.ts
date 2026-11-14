/**
 * 重ね描き (選択枠、ハンドル、作成中の枠、スナップの線) を描くコンポーネント向けの補助。
 *
 * `SelectionOverlay` と各ツールの `Overlay` は、重ね描き用 SVG の中の
 * ページ座標の `<g>` (倍率で拡大される) に置かれる。線の太さを倍率に関係なく一定にするには
 * `OVERLAY_LINE` を付け、ハンドルの大きさなど画面 px で決めたい長さは `useScreenUnit()` を掛ける。
 */
import { useEditorStore } from "../state/store";

/** 線の太さを画面 px で一定にする属性 (`vector-effect: non-scaling-stroke`)。 */
export const OVERLAY_LINE = {
  vectorEffect: "non-scaling-stroke",
  strokeWidth: 1,
  fill: "none",
} as const;

/** 重ね描きの色 (CSS 変数)。`--accent` は選択、ガイド線は `--destructive` の赤を使う。 */
export const OVERLAY_COLORS = {
  selection: "var(--accent)",
  guide: "var(--destructive)",
  label: "var(--fg-muted)",
} as const;

/** 1 画面 px が何ページ px か (= 1 / zoom)。 */
export function useScreenUnit(): number {
  return useEditorStore((state) => 1 / state.viewport.zoom);
}
