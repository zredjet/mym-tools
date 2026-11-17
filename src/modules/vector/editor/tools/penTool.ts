import type { Tool } from "./types";

/**
 * ペン (P、`docs/canvas-editor-design.md` §8.7.4)。
 *
 * v3 の基盤 (C1) が ID と登録だけを置いた空のツール。中身 (クリックで角の点、ドラッグで滑らかな点、
 * 輪郭を閉じる・続ける、予定の線の重ね描き) は「ペンと点の編集」のセッション (F) がこのファイルに書く。
 * 点の編集中にこのツールへ切り替えても、store は `editingPathId` を残す (§8.7.1)。
 */
export const penTool: Tool = {
  id: "pen",
  cursor: "crosshair",
};
